import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { organization } from "../db/auth-schema.ts";
import { db } from "../db/index.ts";
import { mcpServers, mcpTools } from "../db/schema.ts";
import { env } from "../env.ts";
import { decrypt, encrypt } from "../lib/crypto.ts";
import { badRequest, notFound } from "../lib/http.ts";
import { id } from "../lib/ids.ts";
import { disconnect, finishAuthorization, type McpServer, syncServer } from "../services/mcp/client.ts";
import { verifyState } from "../services/mcp/oauth.ts";
import { mcpPresets } from "../services/mcp/presets.ts";
import { getAgentMcpTool, runMcpNow } from "../services/mcp/tools.ts";
import { Trace } from "../services/tracer.ts";
import { type AppEnv, requireAdmin } from "./middleware.ts";

/** MCP servers the agent can use as tools. Mounted at /api/w/:wid/mcp */
export const mcpRoutes = new Hono<AppEnv>();

const record = z.record(z.string(), z.string());
const serverFields = {
  name: z.string().min(1).max(60),
  transport: z.enum(["http", "sse", "stdio"]),
  url: z.string().url().nullable(),
  command: z.string().nullable(),
  args: z.array(z.string()),
  authType: z.enum(["none", "headers", "oauth"]),
  /** Write-only. Replaces all stored headers when present. */
  headers: record,
  /** Write-only. Replaces the stored environment (stdio) when present. */
  env: record,
  enabled: z.boolean(),
};
const createSchema = z.object({
  ...serverFields,
  slug: z.string().optional(),
  transport: serverFields.transport.default("http"),
  url: serverFields.url.default(null),
  command: serverFields.command.default(null),
  args: serverFields.args.default([]),
  authType: serverFields.authType.default("none"),
  headers: serverFields.headers.optional(),
  env: serverFields.env.optional(),
  enabled: serverFields.enabled.default(true),
});
// No defaults on patch: zod applies .default() even under .partial().
const patchSchema = z.object(serverFields).partial();

function readSecrets(server: Pick<McpServer, "secrets">): {
  headers?: Record<string, string>;
  env?: Record<string, string>;
} {
  try {
    return server.secrets ? JSON.parse(decrypt(server.secrets)) : {};
  } catch {
    return {};
  }
}

/** Never return credentials: only which header / env names are set. */
function serialize(server: McpServer) {
  const { secrets: _s, oauth, ...rest } = server;
  const secrets = readSecrets(server);
  return {
    ...rest,
    headerNames: Object.keys(secrets.headers ?? {}),
    envNames: Object.keys(secrets.env ?? {}),
    signedIn: !!oauth,
  };
}

function checkTarget(transport: string, url: string | null | undefined, command: string | null | undefined) {
  if (transport === "stdio") {
    if (!env.MCP_ALLOW_STDIO)
      throw badRequest("Local (stdio) MCP servers are disabled here. Set MCP_ALLOW_STDIO=true to allow them.");
    if (!command?.trim()) throw badRequest("A command is required for a local server");
    return;
  }
  if (!url) throw badRequest("A server URL is required");
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw badRequest("The URL must be http(s)");
}

async function uniqueSlug(orgId: string, base: string) {
  const root =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 20) || "mcp";
  const taken = new Set(
    (await db.select({ slug: mcpServers.slug }).from(mcpServers).where(eq(mcpServers.orgId, orgId))).map((r) => r.slug),
  );
  let slug = /^[a-z]/.test(root) ? root : `m_${root}`;
  for (let i = 2; taken.has(slug); i++) slug = `${root.slice(0, 17)}_${i}`;
  return slug;
}

async function getServer(orgId: string, serverId: string) {
  const [server] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.orgId, orgId), eq(mcpServers.id, serverId)));
  if (!server) throw notFound("MCP server not found");
  return server;
}

/** Connect and load tools. A server that turns out to need sign-in switches to OAuth once. */
async function connect(server: McpServer) {
  const result = await syncServer(server.id);
  if (!result.ok && "needsAuth" in result && !result.authorizeUrl && server.authType === "none") {
    await db.update(mcpServers).set({ authType: "oauth" }).where(eq(mcpServers.id, server.id));
    return syncServer(server.id);
  }
  return result;
}

mcpRoutes.get("/presets", (c) => c.json({ presets: mcpPresets, stdioAllowed: env.MCP_ALLOW_STDIO }));

mcpRoutes.get("/servers", async (c) => {
  const orgId = c.get("orgId");
  const [servers, tools] = await Promise.all([
    db.select().from(mcpServers).where(eq(mcpServers.orgId, orgId)).orderBy(asc(mcpServers.createdAt)),
    db.select().from(mcpTools).where(eq(mcpTools.orgId, orgId)).orderBy(asc(mcpTools.name)),
  ]);
  return c.json({
    servers: servers.map((s) => ({ ...serialize(s), tools: tools.filter((t) => t.serverId === s.id) })),
    stdioAllowed: env.MCP_ALLOW_STDIO,
  });
});

mcpRoutes.post("/servers", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const body = createSchema.parse(await c.req.json());
  checkTarget(body.transport, body.url, body.command);
  const secrets = body.headers || body.env ? { headers: body.headers, env: body.env } : null;
  const [server] = await db
    .insert(mcpServers)
    .values({
      id: id("mcp"),
      orgId,
      name: body.name,
      slug: await uniqueSlug(orgId, body.slug || body.name),
      transport: body.transport,
      url: body.transport === "stdio" ? null : body.url,
      command: body.transport === "stdio" ? body.command : null,
      args: body.args,
      authType: body.authType,
      secrets: secrets ? encrypt(JSON.stringify(secrets)) : null,
      enabled: body.enabled,
    })
    .returning();
  const result = await connect(server!);
  return c.json({ server: serialize((await getServer(orgId, server!.id))!), result }, 201);
});

mcpRoutes.patch("/servers/:id", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const server = await getServer(orgId, c.req.param("id"));
  const body = patchSchema.parse(await c.req.json());
  const transport = body.transport ?? server.transport;
  if (body.url !== undefined || body.command !== undefined || body.transport !== undefined)
    checkTarget(transport, body.url ?? server.url, body.command ?? server.command);
  const { headers, env: envVars, ...fields } = body;
  const secrets = readSecrets(server);
  if (headers) secrets.headers = headers;
  if (envVars) secrets.env = envVars;
  const connectionChanged = ["transport", "url", "command", "args", "authType", "headers", "env"].some(
    (k) => k in body,
  );
  const [updated] = await db
    .update(mcpServers)
    .set({
      ...fields,
      ...(headers || envVars ? { secrets: encrypt(JSON.stringify(secrets)) } : {}),
      // A different server URL must not reuse the old server's tokens.
      ...(body.url && body.url !== server.url ? { oauth: null } : {}),
    })
    .where(eq(mcpServers.id, server.id))
    .returning();
  if (connectionChanged || body.enabled === false) await disconnect(server.id);
  const result = connectionChanged && updated!.enabled ? await connect(updated!) : undefined;
  return c.json({ server: serialize(await getServer(orgId, server.id)), result });
});

mcpRoutes.post("/servers/:id/sync", requireAdmin, async (c) => {
  const server = await getServer(c.get("orgId"), c.req.param("id"));
  return c.json({ result: await connect(server) });
});

/** Forget OAuth tokens (sign out) — the next sync asks to sign in again. */
mcpRoutes.post("/servers/:id/sign-out", requireAdmin, async (c) => {
  const server = await getServer(c.get("orgId"), c.req.param("id"));
  await disconnect(server.id);
  await db
    .update(mcpServers)
    .set({ oauth: null, status: "needs_auth", statusMessage: "Signed out" })
    .where(eq(mcpServers.id, server.id));
  return c.json({ ok: true });
});

mcpRoutes.delete("/servers/:id", requireAdmin, async (c) => {
  const server = await getServer(c.get("orgId"), c.req.param("id"));
  await disconnect(server.id);
  await db.delete(mcpServers).where(eq(mcpServers.id, server.id));
  return c.json({ ok: true });
});

const toolPatch = z.object({ enabled: z.boolean(), readOnly: z.boolean(), requiresApproval: z.boolean() }).partial();

mcpRoutes.patch("/tools/:id", requireAdmin, async (c) => {
  const body = toolPatch.parse(await c.req.json());
  const [tool] = await db
    .update(mcpTools)
    .set(body)
    .where(and(eq(mcpTools.orgId, c.get("orgId")), eq(mcpTools.id, c.req.param("id"))))
    .returning();
  if (!tool) throw notFound("Tool not found");
  return c.json({ tool });
});

/** Enable a server's tools in bulk: only the read-only ones, all, or none. */
mcpRoutes.post("/servers/:id/tools", requireAdmin, async (c) => {
  const server = await getServer(c.get("orgId"), c.req.param("id"));
  const { enable } = z.object({ enable: z.enum(["read_only", "all", "none"]) }).parse(await c.req.json());
  const where = eq(mcpTools.serverId, server.id);
  if (enable === "read_only") {
    await db
      .update(mcpTools)
      .set({ enabled: false })
      .where(and(where, eq(mcpTools.readOnly, false)));
    await db
      .update(mcpTools)
      .set({ enabled: true })
      .where(and(where, eq(mcpTools.readOnly, true)));
  } else
    await db
      .update(mcpTools)
      .set({ enabled: enable === "all" })
      .where(where);
  return c.json({ ok: true });
});

/** Run a tool by hand from settings. Not tied to a ticket; recorded as a span only. */
mcpRoutes.post("/tools/:id/test", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const tool = await getAgentMcpTool(orgId, c.req.param("id"));
  if (!tool) throw notFound("Tool not found");
  const { input } = z.object({ input: z.record(z.string(), z.unknown()).default({}) }).parse(await c.req.json());
  const result = await runMcpNow({
    orgId,
    ticketId: null,
    tool,
    input,
    trace: new Trace(orgId, null),
    requestedBy: "agent",
  });
  return c.json({ result });
});

/** Public: the OAuth provider redirects the admin's browser here after sign-in. */
export const mcpPublicRoutes = new Hono();

mcpPublicRoutes.get("/oauth/callback", async (c) => {
  const serverId = verifyState(c.req.query("state") ?? "");
  const code = c.req.query("code");
  const [server] = serverId ? await db.select().from(mcpServers).where(eq(mcpServers.id, serverId)) : [];
  if (!server) return c.text("Invalid or expired sign-in link. Start the sign-in again from trace.", 400);
  const [org] = await db
    .select({ slug: organization.slug })
    .from(organization)
    .where(eq(organization.id, server.orgId));
  const back = new URL(`${env.APP_URL}/w/${org?.slug ?? ""}/agent/actions`);
  back.searchParams.set("tab", "mcp");
  back.searchParams.set("server", server.id);
  const providerError = c.req.query("error_description") ?? c.req.query("error");
  if (providerError || !code) {
    await db
      .update(mcpServers)
      .set({ status: "needs_auth", statusMessage: `Sign-in failed: ${providerError ?? "no code returned"}` })
      .where(eq(mcpServers.id, server.id));
    back.searchParams.set("mcp", "error");
    return c.redirect(back.toString());
  }
  try {
    const result = await finishAuthorization(server.id, code);
    back.searchParams.set("mcp", result.ok ? "connected" : "error");
  } catch (err) {
    await db
      .update(mcpServers)
      .set({ status: "error", statusMessage: `Sign-in failed: ${(err as Error).message}` })
      .where(eq(mcpServers.id, server.id));
    back.searchParams.set("mcp", "error");
  }
  return c.redirect(back.toString());
});
