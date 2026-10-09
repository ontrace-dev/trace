import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { mcpServers, mcpTools } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { decrypt } from "../../lib/crypto.ts";
import { id } from "../../lib/ids.ts";
import { truncate } from "../../lib/text.ts";
import { DbOAuthProvider, pendingAuthorization } from "./oauth.ts";

export type McpServer = typeof mcpServers.$inferSelect;
export type McpTool = typeof mcpTools.$inferSelect;

const CALL_TIMEOUT_MS = 30_000;
const IDLE_CLOSE_MS = 10 * 60_000;
const MAX_OUTPUT = 6000;

interface Pooled {
  client: Client;
  transport: Transport;
  lastUsed: number;
}
const pool = new Map<string, Pooled>();
const connecting = new Map<string, Promise<Pooled>>();

export class NeedsAuthorization extends Error {
  constructor(readonly authorizeUrl: string | undefined) {
    super("This MCP server needs you to sign in");
  }
}

function secretsOf(server: McpServer): { headers?: Record<string, string>; env?: Record<string, string> } {
  if (!server.secrets) return {};
  try {
    return JSON.parse(decrypt(server.secrets));
  } catch {
    return {};
  }
}

async function makeTransport(server: McpServer, kind: "http" | "sse" | "stdio"): Promise<Transport> {
  if (kind === "stdio") {
    if (!env.MCP_ALLOW_STDIO)
      throw new Error("Local (stdio) MCP servers are disabled on this server. Set MCP_ALLOW_STDIO=true to allow them.");
    if (!server.command) throw new Error("No command configured");
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      // Only a safe default environment plus the server's own secrets — never trace's env.
      env: { ...getDefaultEnvironment(), ...secretsOf(server).env },
      stderr: "ignore",
    });
  }
  if (!server.url) throw new Error("No URL configured");
  const url = new URL(server.url);
  const headers = secretsOf(server).headers ?? {};
  const authProvider = server.authType === "oauth" ? await DbOAuthProvider.load(server.id) : undefined;
  const opts = { authProvider, requestInit: { headers } };
  return kind === "sse" ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts);
}

function isUnauthorized(err: unknown) {
  if (err instanceof UnauthorizedError) return true;
  // Without an auth provider the transports surface the HTTP status as `code` (StreamableHTTPError / SseError).
  const e = err as { code?: unknown; message?: string };
  return e?.code === 401 || /\b401\b|unauthorized|invalid_token/i.test(String(e?.message ?? ""));
}

async function open(server: McpServer): Promise<Pooled> {
  const client = new Client({ name: "trace", version: "0.1.0" });
  const attempt = async (kind: "http" | "sse" | "stdio") => {
    const transport = await makeTransport(server, kind);
    await client.connect(transport, { timeout: CALL_TIMEOUT_MS });
    return transport;
  };
  try {
    const transport = await attempt(server.transport);
    return { client, transport, lastUsed: Date.now() };
  } catch (err) {
    if (isUnauthorized(err)) {
      throw new NeedsAuthorization(pendingAuthorization.get(server.id));
    }
    // Older servers only speak the HTTP+SSE transport: fall back once, as the MCP spec recommends.
    if (server.transport === "http") {
      try {
        const transport = await attempt("sse");
        await db.update(mcpServers).set({ transport: "sse" }).where(eq(mcpServers.id, server.id));
        return { client, transport, lastUsed: Date.now() };
      } catch {
        /* report the original error */
      }
    }
    throw err;
  }
}

export async function getClient(server: McpServer): Promise<Client> {
  const pooled = pool.get(server.id);
  if (pooled) {
    pooled.lastUsed = Date.now();
    return pooled.client;
  }
  let pending = connecting.get(server.id);
  if (!pending) {
    pending = open(server).finally(() => connecting.delete(server.id));
    connecting.set(server.id, pending);
  }
  const p = await pending;
  p.client.onclose = () => pool.delete(server.id);
  pool.set(server.id, p);
  return p.client;
}

/** Drop the cached connection (after config changes, errors or deletion). */
export async function disconnect(serverId: string) {
  const p = pool.get(serverId);
  pool.delete(serverId);
  await p?.client.close().catch(() => {});
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, p] of pool) if (now - p.lastUsed > IDLE_CLOSE_MS) void disconnect(sid);
}, 60_000).unref();

async function setStatus(serverId: string, status: McpServer["status"], statusMessage: string | null) {
  await db.update(mcpServers).set({ status, statusMessage }).where(eq(mcpServers.id, serverId));
}

/** Tool names the model sees: <slug>__<name>, limited to the API's [a-zA-Z0-9_-]{1,64}. */
export function exposedName(slug: string, name: string) {
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${slug}__${clean}`.slice(0, 64);
}

/** Connect, read the server's tools and store them. New tools start disabled; existing choices are kept. */
export async function syncServer(serverId: string) {
  const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
  if (!server) throw new Error("MCP server not found");
  try {
    await disconnect(serverId);
    const client = await getClient(server);
    const listed: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CALL_TIMEOUT_MS });
      listed.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && listed.length < 500);

    const existing = await db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId));
    const byName = new Map(existing.map((t) => [t.name, t]));
    for (const t of listed) {
      const annotations = (t.annotations ?? {}) as Record<string, unknown>;
      const readOnlyHint = annotations.readOnlyHint === true;
      const values = {
        title: t.title ?? (annotations.title as string | undefined) ?? null,
        description: t.description ?? "",
        inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        annotations,
        toolName: exposedName(server.slug, t.name),
      };
      const prev = byName.get(t.name);
      if (prev) await db.update(mcpTools).set(values).where(eq(mcpTools.id, prev.id));
      else
        await db.insert(mcpTools).values({
          id: id("mct"),
          orgId: server.orgId,
          serverId,
          name: t.name,
          ...values,
          enabled: false,
          readOnly: readOnlyHint,
          requiresApproval: !readOnlyHint,
        });
    }
    const keep = listed.map((t) => t.name);
    await db
      .delete(mcpTools)
      .where(
        keep.length
          ? and(eq(mcpTools.serverId, serverId), notInArray(mcpTools.name, keep))
          : eq(mcpTools.serverId, serverId),
      );
    await db
      .update(mcpServers)
      .set({
        status: "connected",
        statusMessage: null,
        instructions: client.getInstructions() ?? null,
        lastSyncedAt: new Date(),
      })
      .where(eq(mcpServers.id, serverId));
    return { ok: true as const, tools: listed.length };
  } catch (err) {
    await disconnect(serverId);
    if (err instanceof NeedsAuthorization) {
      await setStatus(serverId, "needs_auth", "Sign in to authorize trace");
      return { ok: false as const, needsAuth: true, authorizeUrl: err.authorizeUrl };
    }
    const message = err instanceof Error ? err.message : String(err);
    await setStatus(serverId, "error", truncate(message, 300));
    return { ok: false as const, error: message };
  }
}

/** Finish an OAuth sign-in (from the provider's redirect) and load the tools. */
export async function finishAuthorization(serverId: string, code: string) {
  const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
  if (!server?.url) throw new Error("MCP server not found");
  const transport = (await makeTransport(server, server.transport === "sse" ? "sse" : "http")) as
    | StreamableHTTPClientTransport
    | SSEClientTransport;
  await transport.finishAuth(code);
  pendingAuthorization.delete(serverId);
  return syncServer(serverId);
}

export interface McpCallResult {
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

/** Call a tool and flatten its result into text for the model and the trace. Never throws. */
export async function callMcpTool(tool: McpTool, args: Record<string, unknown>): Promise<McpCallResult> {
  const t0 = performance.now();
  const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, tool.serverId));
  if (!server || !server.enabled)
    return { ok: false, output: "", error: "MCP server is disabled or deleted", durationMs: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const client = await getClient(server);
      const res = (await client.callTool({ name: tool.name, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
      })) as {
        content?: {
          type: string;
          text?: string;
          resource?: { uri?: string; text?: string };
          uri?: string;
          name?: string;
        }[];
        structuredContent?: unknown;
        isError?: boolean;
      };
      const parts = (res.content ?? []).map((c) => {
        if (c.type === "text") return c.text ?? "";
        if (c.type === "resource") return c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`;
        if (c.type === "resource_link") return `[link ${c.name ?? ""} ${c.uri ?? ""}]`;
        return `[${c.type}]`;
      });
      if (!parts.join("").trim() && res.structuredContent !== undefined)
        parts.push(JSON.stringify(res.structuredContent));
      const output = truncate(parts.join("\n").trim(), MAX_OUTPUT);
      return {
        ok: !res.isError,
        output,
        error: res.isError ? truncate(output || "tool reported an error", 300) : undefined,
        durationMs: Math.round(performance.now() - t0),
      };
    } catch (err) {
      await disconnect(server.id);
      if (err instanceof NeedsAuthorization) {
        await setStatus(server.id, "needs_auth", "Sign in again to authorize trace");
        return {
          ok: false,
          output: "",
          error: "The MCP server needs re-authorization",
          durationMs: Math.round(performance.now() - t0),
        };
      }
      if (attempt === 1) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, output: "", error: truncate(message, 300), durationMs: Math.round(performance.now() - t0) };
      }
    }
  }
  return { ok: false, output: "", error: "unreachable", durationMs: 0 };
}
