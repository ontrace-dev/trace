import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { type actions, workspaceSecrets } from "../../db/schema.ts";
import { decrypt } from "../../lib/crypto.ts";
import { truncate } from "../../lib/text.ts";
import type { ActionParameter } from "../../lib/types.ts";
import type { Customer, Ticket } from "../tickets.ts";

export type Action = typeof actions.$inferSelect;

export interface ActionScope {
  orgId: string;
  ticket?: Pick<Ticket, "id" | "number" | "subject" | "channel"> | null;
  customer?: Pick<Customer, "id" | "email" | "name" | "externalId" | "attributes"> | null;
}

export interface ActionResult {
  ok: boolean;
  status: number | null;
  /** Response body, compacted and truncated for the model and the UI. */
  output: string;
  error?: string;
  durationMs: number;
  request: { method: string; url: string };
}

const MAX_OUTPUT = 6000;

async function loadSecrets(orgId: string) {
  const rows = await db.select().from(workspaceSecrets).where(eq(workspaceSecrets.orgId, orgId));
  const out: Record<string, string> = {};
  for (const r of rows) {
    try {
      out[r.name] = decrypt(r.value);
    } catch {
      /* unreadable (secret rotated) — leave unset */
    }
  }
  return out;
}

function lookup(path: string, scope: Record<string, unknown>): unknown {
  return path
    .split(".")
    .reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), scope);
}

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Interpolate {{path}} placeholders into a string. Missing values become "". */
export function renderString(template: string, scope: Record<string, unknown>, encode?: (s: string) => string) {
  return template.replace(PLACEHOLDER, (_, path: string) => {
    const v = lookup(path, scope);
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return encode ? encode(s) : s;
  });
}

/** Render a JSON body template: a string value that is exactly "{{x}}" keeps x's type. */
export function renderJson(template: unknown, scope: Record<string, unknown>): unknown {
  if (typeof template === "string") {
    const whole = template.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (whole) return lookup(whole[1]!, scope) ?? null;
    return renderString(template, scope);
  }
  if (Array.isArray(template)) return template.map((t) => renderJson(t, scope));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, renderJson(v, scope)]));
  }
  return template;
}

/** Coerce and validate model-provided input against the action's declared parameters. */
export function validateInput(params: ActionParameter[], input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    let v = input[p.name];
    if (v === undefined || v === null || v === "") {
      if (p.required) throw new Error(`missing required parameter "${p.name}"`);
      continue;
    }
    if (p.type === "number" || p.type === "integer") {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`parameter "${p.name}" must be a number`);
      v = p.type === "integer" ? Math.trunc(n) : n;
    } else if (p.type === "boolean") {
      v = v === true || v === "true";
    } else {
      v = String(v);
    }
    if (p.enum?.length && !p.enum.includes(String(v)))
      throw new Error(`parameter "${p.name}" must be one of ${p.enum.join(", ")}`);
    out[p.name] = v;
  }
  return out;
}

function toForm(value: unknown, prefix = "", out = new URLSearchParams()) {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) toForm(v, prefix ? `${prefix}[${k}]` : k, out);
  } else if (value != null && prefix) {
    out.append(prefix, String(value));
  }
  return out;
}

function compact(text: string, contentType: string) {
  if (contentType.includes("json")) {
    try {
      return truncate(JSON.stringify(JSON.parse(text)), MAX_OUTPUT);
    } catch {
      /* fall through */
    }
  }
  return truncate(text, MAX_OUTPUT);
}

/** Execute an action's HTTP call. Never throws — failures are returned as results for the model. */
export async function executeAction(
  action: Action,
  rawInput: Record<string, unknown>,
  scope: ActionScope,
): Promise<ActionResult> {
  const t0 = performance.now();
  let url = action.url;
  try {
    const input = validateInput(action.parameters, rawInput);
    const secrets = await loadSecrets(scope.orgId);
    const vars: Record<string, unknown> = {
      ...input,
      input,
      secrets,
      ticket: scope.ticket ? { id: scope.ticket.id, number: scope.ticket.number, subject: scope.ticket.subject } : {},
      customer: scope.customer
        ? {
            id: scope.customer.id,
            email: scope.customer.email,
            name: scope.customer.name,
            externalId: scope.customer.externalId,
            ...scope.customer.attributes,
          }
        : {},
    };
    url = renderString(action.url, vars, encodeURIComponent);
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("only http(s) URLs are allowed");
    const headers = new Headers();
    for (const [k, v] of Object.entries(action.headers)) headers.set(k, renderString(v, vars));
    let body: string | undefined;
    if (action.method !== "GET" && action.bodyFormat !== "none" && action.body?.trim()) {
      const rendered = renderJson(JSON.parse(action.body), vars);
      if (action.bodyFormat === "form") {
        body = toForm(rendered).toString();
        if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded");
      } else {
        body = JSON.stringify(rendered);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
    }
    if (!headers.has("accept")) headers.set("accept", "application/json");
    headers.set("user-agent", "trace-actions/1");
    const res = await fetch(url, {
      method: action.method,
      headers,
      body,
      signal: AbortSignal.timeout(action.timeoutMs),
    });
    const text = await res.text();
    const output = compact(text, res.headers.get("content-type") ?? "");
    return {
      ok: res.ok,
      status: res.status,
      output,
      error: res.ok ? undefined : `HTTP ${res.status}`,
      durationMs: Math.round(performance.now() - t0),
      request: { method: action.method, url: redact(url) },
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      output: "",
      error:
        err instanceof Error
          ? err.name === "TimeoutError"
            ? `timed out after ${action.timeoutMs}ms`
            : err.message
          : String(err),
      durationMs: Math.round(performance.now() - t0),
      request: { method: action.method, url: redact(url) },
    };
  }
}

/** Strip credentials from URLs before they are stored in traces. */
function redact(url: string) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    for (const k of [...u.searchParams.keys()])
      if (/key|token|secret|password|auth/i.test(k)) u.searchParams.set(k, "***");
    return u.toString();
  } catch {
    return url.replace(/\{\{\s*secrets\.[\w.]+\s*\}\}/g, "***");
  }
}
