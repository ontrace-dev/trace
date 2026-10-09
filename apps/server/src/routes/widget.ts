import { and, desc, eq, inArray, notInArray, or } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "../db/index.ts";
import { channels, messages, tickets } from "../db/schema.ts";
import { env } from "../env.ts";
import { bus, type BusEvent } from "../lib/bus.ts";
import { secretToken } from "../lib/ids.ts";
import { escapeHtml } from "../lib/text.ts";
import { getClaude } from "../services/ai/client.ts";
import { addMessage, createTicket, upsertCustomer } from "../services/tickets.ts";
import { findWorkspaceByWidgetKey, getOrg } from "../services/workspace.ts";
import { widgetForBrowser } from "./serializers.ts";

/**
 * Public API for the embeddable widget (packages/widget). Everything is keyed by the workspace's
 * public widget key; visitors authenticate with a stateless HMAC-signed token from POST /session.
 */
export const widgetRoutes = new Hono();

type Settings = NonNullable<Awaited<ReturnType<typeof findWorkspaceByWidgetKey>>>;

// ---------------------------------------------------------------- visitor tokens

interface VisitorClaims {
  /** workspace (organization) id */
  o: string;
  /** visitor id (persisted in the browser) */
  v: string;
  /** customer id, once known */
  c?: string;
  /** identity verified via userHash */
  vf?: boolean;
  iat: number;
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sig = (payload: string) =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(`widget:${payload}`).digest("base64url");

function signToken(claims: Omit<VisitorClaims, "iat">) {
  const payload = b64(JSON.stringify({ ...claims, iat: Math.floor(Date.now() / 1000) }));
  return `${payload}.${sig(payload)}`;
}

function verifyToken(token: string | undefined, orgId: string): VisitorClaims {
  if (!token) throw new HTTPException(401, { message: "Missing visitor token" });
  const [payload, mac] = token.split(".");
  if (!payload || !mac) throw new HTTPException(401, { message: "Malformed token" });
  const expected = sig(payload);
  if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) {
    throw new HTTPException(401, { message: "Invalid token" });
  }
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as VisitorClaims;
  if (claims.o !== orgId) throw new HTTPException(401, { message: "Token is for another workspace" });
  return claims;
}

function verifyUserHash(secret: string, subject: string, hash?: string) {
  if (!hash || !secret || !subject) return false;
  const expected = createHmac("sha256", secret).update(subject).digest("hex");
  return expected.length === hash.length && timingSafeEqual(Buffer.from(expected), Buffer.from(hash.toLowerCase()));
}

// ---------------------------------------------------------------- guards

const buckets = new Map<string, { n: number; reset: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref();

/** Fixed-window limiter per IP + widget key. */
function rateLimit(c: Context, key: string, limit: number, scope: string) {
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ||
    "unknown";
  const id = `${scope}:${key}:${ip}`;
  const now = Date.now();
  const b = buckets.get(id);
  if (!b || b.reset < now) {
    buckets.set(id, { n: 1, reset: now + 60_000 });
    return;
  }
  if (++b.n > limit) throw new HTTPException(429, { message: "Too many requests — slow down a little" });
}

function originAllowed(origin: string | undefined, allowed: string[]) {
  if (!allowed.length || !origin) return true;
  const own = [env.PUBLIC_URL, env.APP_URL].map((u) => new URL(u).origin);
  if (own.includes(origin)) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return allowed.some((raw) => {
    const a = raw.trim().replace(/\/+$/, "");
    if (!a) return false;
    if (a === "*") return true;
    if (a.startsWith("*.")) return host.endsWith(a.slice(1)) || host === a.slice(2);
    if (a.includes("://")) return a === origin;
    return a === host;
  });
}

async function workspace(c: Context, opts: { limit?: number; scope?: string } = {}) {
  const key = c.req.param("key") ?? "";
  if (!/^wk_[A-Za-z0-9]+$/.test(key)) throw new HTTPException(404, { message: "Unknown widget" });
  rateLimit(c, key, opts.limit ?? 240, opts.scope ?? "read");
  const s = await findWorkspaceByWidgetKey(key);
  if (!s) throw new HTTPException(404, { message: "Unknown widget" });
  if (!originAllowed(c.req.header("origin"), s.widget.allowedOrigins ?? [])) {
    throw new HTTPException(403, { message: "This website is not allowed to use this widget" });
  }
  return s;
}

function claims(c: Context, s: Settings) {
  const raw = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") || c.req.query("token");
  return verifyToken(raw, s.orgId);
}

/** Tickets this visitor may see: started from their browser, or (verified) any widget ticket of their customer. */
function visitorScope(cl: VisitorClaims) {
  const byVisitor = eq(tickets.widgetVisitorId, cl.v);
  return cl.vf && cl.c ? or(byVisitor, and(eq(tickets.customerId, cl.c), eq(tickets.channel, "widget"))) : byVisitor;
}

async function ownTicket(orgId: string, cl: VisitorClaims, ticketId: string) {
  const [t] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), eq(tickets.id, ticketId), visitorScope(cl)));
  if (!t) throw new HTTPException(404, { message: "Conversation not found" });
  return t;
}

type PublicMessage = {
  id: string;
  ticketId: string;
  authorType: string;
  authorName: string | null;
  body: string;
  attachments: { id: string; name: string; size: number; contentType: string }[];
  createdAt: Date;
};

const publicMessage = (m: typeof messages.$inferSelect): PublicMessage => ({
  id: m.id,
  ticketId: m.ticketId,
  authorType: m.authorType,
  authorName: m.authorType === "customer" ? null : m.authorName,
  body: m.body,
  attachments: m.attachments,
  createdAt: m.createdAt,
});

const publicTicket = (t: typeof tickets.$inferSelect) => ({
  id: t.id,
  subject: t.subject,
  status: t.status,
  aiState: t.aiState,
  createdAt: t.createdAt,
  lastMessageAt: t.lastMessageAt,
});

const visibleKinds = notInArray(messages.kind, ["note", "event"]);

async function ensureCustomer(s: Settings, cl: VisitorClaims, input: { email?: string; name?: string }) {
  if (cl.c && !input.email) return cl;
  const customer = await upsertCustomer(s.orgId, {
    email: input.email ?? null,
    name: input.name ?? (input.email ? null : `Visitor ${cl.v.slice(-4).toUpperCase()}`),
    externalId: input.email ? null : `visitor:${cl.v}`,
  });
  return { ...cl, c: customer.id };
}

// ---------------------------------------------------------------- routes

widgetRoutes.get("/:key/config", async (c) => {
  const s = await workspace(c);
  const org = await getOrg(s.orgId);
  return c.json({
    widget: widgetForBrowser(s.widget),
    org: { name: org?.name ?? "Support", logo: org?.logo ?? null },
    ai: { agentName: s.ai.agentName, enabled: s.ai.enabled, online: !!getClaude(s.ai) },
  });
});

const sessionSchema = z.object({
  visitorId: z
    .string()
    .regex(/^v_[A-Za-z0-9]{8,40}$/)
    .optional(),
  token: z.string().optional(),
  email: z.string().email().optional(),
  name: z.string().max(120).optional(),
  userId: z.string().max(200).optional(),
  userHash: z.string().max(128).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

widgetRoutes.post("/:key/session", async (c) => {
  const s = await workspace(c, { limit: 30, scope: "session" });
  const b = sessionSchema.parse(await c.req.json().catch(() => ({})));
  let prev: VisitorClaims | undefined;
  if (b.token) {
    try {
      prev = verifyToken(b.token, s.orgId);
    } catch {
      prev = undefined;
    }
  }
  const visitorId = prev?.v ?? b.visitorId ?? `v_${secretToken(20)}`;
  let customerId = prev?.c;
  let verified = prev?.vf ?? false;

  if (b.email || b.userId) {
    const subject = b.userId || b.email!;
    verified = verifyUserHash(s.widget.identitySecret, subject, b.userHash);
    const customer = await upsertCustomer(s.orgId, {
      email: b.email ?? null,
      name: b.name ?? null,
      // Only trust a userId as an external identity when it is verified.
      externalId: verified && b.userId ? b.userId : null,
      attributes: b.attributes,
    });
    customerId = customer.id;
    // An unverified identity never unlocks someone else's conversations.
    if (!verified && prev?.vf) verified = false;
  }

  const token = signToken({ o: s.orgId, v: visitorId, c: customerId, vf: verified || undefined });
  return c.json({ visitorId, token, verified });
});

widgetRoutes.get("/:key/conversations", async (c) => {
  const s = await workspace(c);
  const cl = claims(c, s);
  const rows = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.orgId, s.orgId), visitorScope(cl)))
    .orderBy(desc(tickets.lastMessageAt))
    .limit(30);
  const ids = rows.map((r) => r.id);
  const last = new Map<string, typeof messages.$inferSelect>();
  if (ids.length) {
    const msgs = await db
      .select()
      .from(messages)
      .where(and(inArray(messages.ticketId, ids), visibleKinds))
      .orderBy(desc(messages.createdAt));
    for (const m of msgs) if (!last.has(m.ticketId)) last.set(m.ticketId, m);
  }
  return c.json({
    conversations: rows.map((t) => {
      const m = last.get(t.id);
      return {
        ...publicTicket(t),
        preview: m ? m.body.slice(0, 140) : "",
        lastAuthorType: m?.authorType ?? null,
        lastAuthorName: m && m.authorType !== "customer" ? m.authorName : null,
        // "Unread" = the latest message is a reply the visitor hasn't answered yet; the widget refines this with local read receipts.
        unread: !!m && m.authorType !== "customer",
      };
    }),
  });
});

const bodySchema = z.object({ body: z.string().trim().min(1).max(10_000) });

widgetRoutes.post("/:key/conversations", async (c) => {
  const s = await workspace(c, { limit: 20, scope: "write" });
  let cl = claims(c, s);
  const b = bodySchema
    .extend({ email: z.string().email().optional(), name: z.string().max(120).optional() })
    .parse(await c.req.json());
  if (s.widget.requireEmail && !b.email && !cl.c) {
    throw new HTTPException(400, { message: "Please leave your email so we can follow up" });
  }
  cl = await ensureCustomer(s, cl, b);
  const [widgetChannel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.orgId, s.orgId), eq(channels.type, "widget")))
    .limit(1);
  const firstLine = b.body.replace(/\s+/g, " ").trim();
  const { ticket, message } = await createTicket(s.orgId, {
    subject: firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine,
    body: b.body,
    channel: "widget",
    channelId: widgetChannel?.id ?? null,
    customerId: cl.c,
    widgetVisitorId: cl.v,
    meta: { via: "widget" },
  });
  return c.json(
    {
      conversation: publicTicket(ticket),
      message: message ? publicMessage(message) : null,
      token: signToken({ o: cl.o, v: cl.v, c: cl.c, vf: cl.vf }),
    },
    201,
  );
});

widgetRoutes.get("/:key/conversations/:id/messages", async (c) => {
  const s = await workspace(c);
  const cl = claims(c, s);
  const t = await ownTicket(s.orgId, cl, c.req.param("id"));
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.ticketId, t.id), visibleKinds))
    .orderBy(messages.createdAt);
  return c.json({ conversation: publicTicket(t), messages: rows.map(publicMessage) });
});

widgetRoutes.post("/:key/conversations/:id/messages", async (c) => {
  const s = await workspace(c, { limit: 40, scope: "write" });
  const cl = claims(c, s);
  const t = await ownTicket(s.orgId, cl, c.req.param("id"));
  const b = bodySchema.parse(await c.req.json());
  const customerId = t.customerId ?? cl.c ?? null;
  const msg = await addMessage(s.orgId, t.id, {
    authorType: "customer",
    authorId: customerId,
    body: b.body,
    meta: { via: "widget" },
  });
  return c.json({ message: publicMessage(msg) }, 201);
});

widgetRoutes.get("/:key/stream", async (c) => {
  const s = await workspace(c, { limit: 60, scope: "stream" });
  const cl = claims(c, s);
  const own = new Set(
    (
      await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.orgId, s.orgId), visitorScope(cl)))
    ).map((r) => r.id),
  );
  const isOwn = async (ticketId: string) => {
    if (own.has(ticketId)) return true;
    const [t] = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), visitorScope(cl)));
    if (t) own.add(t.id);
    return !!t;
  };

  return streamSSE(c, async (stream) => {
    const queue: BusEvent[] = [];
    let wake: (() => void) | null = null;
    const onEvent = (e: BusEvent) => {
      if (
        e.type !== "message.created" &&
        e.type !== "ai.state" &&
        e.type !== "ticket.updated" &&
        e.type !== "ticket.created"
      )
        return;
      if (e.type === "message.created" && (e.kind === "note" || e.kind === "event")) return;
      queue.push(e);
      wake?.();
    };
    bus.on(`org:${s.orgId}`, onEvent);
    stream.onAbort(() => {
      bus.off(`org:${s.orgId}`, onEvent);
      wake?.();
    });
    await stream.writeSSE({ event: "ready", data: JSON.stringify({ visitorId: cl.v }), retry: 3000 });
    while (!stream.aborted) {
      if (!queue.length) {
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 20_000);
        });
        wake = null;
      }
      if (stream.aborted) break;
      if (!queue.length) {
        await stream.writeSSE({ event: "ping", data: "{}" });
        continue;
      }
      for (const e of queue.splice(0, queue.length)) {
        if (!("ticketId" in e) || !(await isOwn(e.ticketId))) continue;
        if (e.type === "message.created") {
          const [m] = await db.select().from(messages).where(eq(messages.id, e.messageId));
          if (!m || m.kind !== "message") continue;
          await stream.writeSSE({ event: "message", data: JSON.stringify(publicMessage(m)) });
        } else {
          const [t] = await db.select().from(tickets).where(eq(tickets.id, e.ticketId));
          if (t) await stream.writeSSE({ event: "conversation", data: JSON.stringify(publicTicket(t)) });
        }
      }
    }
    bus.off(`org:${s.orgId}`, onEvent);
  });
});

// ---------------------------------------------------------------- demo page

widgetRoutes.get("/demo", async (c) => {
  const key = c.req.query("key") ?? "";
  const s = key ? await findWorkspaceByWidgetKey(key) : undefined;
  const org = s ? await getOrg(s.orgId) : undefined;
  const name = escapeHtml(org?.name ?? "Acme");
  const accent = escapeHtml(s?.widget.accentColor ?? "#b9a3ff");
  const script = s
    ? `<script src="${escapeHtml(env.PUBLIC_URL)}/widget.js" data-key="${escapeHtml(key)}" async></script>`
    : "";
  return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${name} — widget demo</title>
<style>
  :root { --accent: ${accent}; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #18181b; background: #fafaf9; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 18px 40px; border-bottom: 1px solid #e7e5e4; background: #fff; }
  .logo { display: flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: -.01em; }
  .logo i { width: 22px; height: 22px; background: var(--accent); display: inline-block; border-radius: 6px; }
  nav a { margin-left: 26px; color: #57534e; text-decoration: none; font-size: 14px; }
  main { max-width: 1040px; margin: 0 auto; padding: 72px 40px; }
  .eyebrow { font: 600 11px ui-monospace, Menlo, monospace; letter-spacing: .14em; text-transform: uppercase; color: #78716c; }
  h1 { font-size: 48px; line-height: 1.05; letter-spacing: -.03em; margin: 14px 0 18px; max-width: 720px; }
  p.lead { font-size: 18px; color: #57534e; line-height: 1.6; max-width: 620px; }
  .cta { display: flex; gap: 12px; margin-top: 28px; }
  .btn { padding: 11px 18px; border-radius: 10px; font-weight: 600; font-size: 14px; border: 1px solid #d6d3d1; background: #fff; cursor: pointer; color: inherit; }
  .btn.primary { background: #18181b; color: #fff; border-color: #18181b; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 64px; }
  .card { background: #fff; border: 1px solid #e7e5e4; border-radius: 14px; padding: 20px; }
  .card b { display: block; margin-bottom: 6px; }
  .card span { color: #78716c; font-size: 14px; line-height: 1.5; }
  .note { margin-top: 56px; padding: 16px 18px; border: 1px dashed #d6d3d1; border-radius: 12px; font-size: 13px; color: #57534e; background: #fff; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 12px; background: #f5f5f4; padding: 2px 5px; border-radius: 4px; }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } h1 { font-size: 34px; } header, main { padding-left: 20px; padding-right: 20px; } nav { display: none; } }
</style>
</head>
<body>
<header><div class="logo"><i></i>${name}</div><nav><a href="#">Product</a><a href="#">Pricing</a><a href="#">Docs</a><a href="#">Help</a></nav></header>
<main>
  <div class="eyebrow">Widget demo</div>
  <h1>This is a pretend ${name} website with the trace widget installed.</h1>
  <p class="lead">Open the chat bubble in the corner and ask anything. Messages land in your trace inbox, the AI agent answers instantly when it's confident, and your team picks up the rest.</p>
  <div class="cta">
    <button class="btn primary" data-trace-open>Chat with support</button>
    <button class="btn" onclick="Trace('identify',{email:'demo.customer@example.com',name:'Demo Customer'});Trace('open')">Identify as demo customer</button>
  </div>
  <div class="grid">
    <div class="card"><b>Instant answers</b><span>The agent searches your knowledge base and past resolutions before replying.</span></div>
    <div class="card"><b>Humans where it counts</b><span>Low-confidence or sensitive requests are drafted for your team instead.</span></div>
    <div class="card"><b>Fully yours</b><span>Colors, copy, position, launcher and CSS are configurable in Settings → Channels → Widget.</span></div>
  </div>
  <div class="note">${
    s
      ? `Embedded with <code>&lt;script src="${escapeHtml(env.PUBLIC_URL)}/widget.js" data-key="${escapeHtml(key)}" async&gt;&lt;/script&gt;</code>`
      : `No valid widget key — open this page from <b>Settings → Widget</b> in trace, or append <code>?key=wk_…</code>.`
  }</div>
</main>
<script>window.Trace=window.Trace||function(){(Trace.q=Trace.q||[]).push(arguments)};</script>
${script}
</body>
</html>`);
});
