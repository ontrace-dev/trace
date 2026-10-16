import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { db } from "../db/index.ts";
import { articles, customers, messages, tickets } from "../db/schema.ts";
import { env } from "../env.ts";
import { hit, originAllowed, rateLimit } from "../lib/guards.ts";
import { escapeHtml, markdownToPlain } from "../lib/text.ts";
import { searchKnowledge } from "../services/knowledge/search.ts";
import { publicMailbox } from "../services/demo.ts";
import { DEMO_SLUG } from "../scripts/seed.ts";
import {
  customerForSignedIdentity,
  findOrgBySlug,
  type PortalClaims,
  portalSettings,
  redeemSignIn,
  SESSION_TTL,
  sendSignInLink,
  signPortalToken,
  verifyPortalToken,
  verifyUserHash,
} from "../services/portal.ts";
import { addMessage, createTicket, updateTicket, upsertCustomer } from "../services/tickets.ts";
import { getSettings } from "../services/workspace.ts";

/**
 * Public API of the customer portal (packages/portal and the hosted page at /portal/<workspace>).
 * Also usable directly to build a portal of your own. Customers authenticate with a bearer token
 * from POST /verify (email sign-in link) or POST /session (signed in by your platform).
 */
export const portalRoutes = new Hono();

const DEMO_CUSTOMER = "anna@northwind.io";

async function portal(c: Context, opts: { limit?: number; scope?: string } = {}) {
  const slug = c.req.param("slug") ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(slug)) throw new HTTPException(404, { message: "Unknown portal" });
  rateLimit(c, slug, opts.limit ?? 240, `portal:${opts.scope ?? "read"}`);
  const org = await findOrgBySlug(slug);
  if (!org) throw new HTTPException(404, { message: "Unknown portal" });
  const settings = await getSettings(org.id);
  const p = portalSettings(settings, org.name);
  if (!p.enabled) throw new HTTPException(404, { message: "This support portal is turned off" });
  if (!originAllowed(c.req.header("origin"), p.allowedOrigins)) {
    throw new HTTPException(403, { message: "This website is not allowed to embed this portal" });
  }
  // Email links can't be offered when every email lands in a public demo mailbox.
  const emailSignIn = p.emailSignIn && !publicMailbox();
  const demo = env.DEMO_MODE && slug === DEMO_SLUG;
  return { org, slug, settings, portal: p, emailSignIn, demo };
}

type Ctx = Awaited<ReturnType<typeof portal>>;

function session(c: Context, ctx: Ctx): PortalClaims {
  const raw = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const claims = verifyPortalToken(raw, ctx.org.id);
  if (!claims) throw new HTTPException(401, { message: "Please sign in again" });
  return claims;
}

/** The tickets a session may see: every ticket of its customer, or the single ticket of an email link. */
const scope = (cl: PortalClaims) =>
  and(eq(tickets.orgId, cl.o), eq(tickets.customerId, cl.c), cl.t ? eq(tickets.id, cl.t) : undefined);

async function ownTicket(cl: PortalClaims, ref: string) {
  const number = Number(ref);
  if (!Number.isInteger(number) || number < 1) throw new HTTPException(404, { message: "Request not found" });
  const [t] = await db
    .select()
    .from(tickets)
    .where(and(scope(cl), eq(tickets.number, number)));
  if (!t) throw new HTTPException(404, { message: "Request not found" });
  return t;
}

const visible = notInArray(messages.kind, ["note", "event"]);

/** How the customer sees a status: we're working on it, it's their turn, or it's done. */
const stateOf = (status: string) =>
  status === "pending" ? "awaiting_you" : status === "resolved" || status === "closed" ? "solved" : "open";

function publicTicket(ctx: Ctx, t: typeof tickets.$inferSelect) {
  return {
    number: t.number,
    ref: `${ctx.settings.ticketPrefix}-${t.number}`,
    subject: t.subject,
    status: t.status,
    state: stateOf(t.status),
    channel: t.channel,
    createdAt: t.createdAt,
    updatedAt: t.lastMessageAt,
    solvedAt: t.status === "resolved" || t.status === "closed" ? t.resolvedAt : null,
  };
}

function publicMessage(m: typeof messages.$inferSelect) {
  return {
    id: m.id,
    author:
      m.authorType === "customer" ? "you" : m.authorType === "ai" ? "ai" : m.authorType === "agent" ? "team" : "system",
    authorName: m.authorType === "customer" ? null : m.authorName,
    body: m.body,
    attachments: m.attachments.map((a) => ({ id: a.id, name: a.name, size: a.size, contentType: a.contentType })),
    createdAt: m.createdAt,
  };
}

function publicCustomer(cu: typeof customers.$inferSelect | undefined) {
  return cu ? { name: cu.name, email: cu.email } : null;
}

async function issueSession(ctx: Ctx, customerId: string, ttl: number) {
  const [cu] = await db.select().from(customers).where(eq(customers.id, customerId));
  return { token: signPortalToken({ o: ctx.org.id, c: customerId }, ttl), customer: publicCustomer(cu) };
}

// ---------------------------------------------------------------- config

portalRoutes.get("/:slug/config", async (c) => {
  const ctx = await portal(c);
  const { allowedOrigins: _o, ...p } = ctx.portal;
  return c.json({
    portal: { ...p, emailSignIn: ctx.emailSignIn },
    org: { name: ctx.org.name, logo: ctx.org.logo ?? null, slug: ctx.slug },
    ticketPrefix: ctx.settings.ticketPrefix,
    demo: ctx.demo ? { customer: DEMO_CUSTOMER } : null,
  });
});

// ---------------------------------------------------------------- sign-in

portalRoutes.post("/:slug/login", async (c) => {
  const ctx = await portal(c, { limit: 10, scope: "login" });
  if (!ctx.emailSignIn) throw new HTTPException(403, { message: "Email sign-in is turned off for this portal" });
  const b = z
    .object({
      email: z.string().trim().toLowerCase().email().max(254),
      returnTo: z.string().url().max(2000).optional(),
    })
    .parse(await c.req.json());
  // A few links per address per quarter hour, whoever asks: nobody gets to flood a mailbox.
  hit(`portal:login:${ctx.org.id}:${b.email}`, 3, 15 * 60_000);
  await sendSignInLink({ orgId: ctx.org.id, slug: ctx.slug, email: b.email, portal: ctx.portal, returnTo: b.returnTo });
  // Same answer whether or not we know the address.
  return c.json({ ok: true });
});

portalRoutes.post("/:slug/verify", async (c) => {
  const ctx = await portal(c, { limit: 20, scope: "login" });
  const b = z.object({ code: z.string().min(20).max(100) }).parse(await c.req.json());
  const email = await redeemSignIn(ctx.org.id, b.code);
  if (!email) throw new HTTPException(400, { message: "This sign-in link has expired or was already used" });
  const cu = await upsertCustomer(ctx.org.id, { email });
  return c.json(await issueSession(ctx, cu.id, SESSION_TTL.email));
});

/** Your platform signs the customer in: HMAC-SHA256 of their email (or userId) with the identity secret. */
portalRoutes.post("/:slug/session", async (c) => {
  const ctx = await portal(c, { limit: 30, scope: "session" });
  const b = z
    .object({
      email: z.string().trim().toLowerCase().email().max(254).optional(),
      userId: z.string().min(1).max(200).optional(),
      name: z.string().max(120).optional(),
      userHash: z.string().max(128),
      attributes: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(await c.req.json());
  const secret = ctx.settings.widget.identitySecret;
  const signed = verifyUserHash(secret, b.email, b.userHash)
    ? "email"
    : verifyUserHash(secret, b.userId, b.userHash)
      ? "userId"
      : null;
  if (!signed) throw new HTTPException(401, { message: "Identity could not be verified (check userHash)" });
  const cu = await customerForSignedIdentity(ctx.org.id, b, signed);
  return c.json(await issueSession(ctx, cu.id, SESSION_TTL.platform));
});

/** The shared demo: one click signs in as a seeded customer (its mailbox is public, so there are no email links). */
portalRoutes.post("/:slug/demo", async (c) => {
  const ctx = await portal(c, { limit: 20, scope: "login" });
  if (!ctx.demo) throw new HTTPException(404, { message: "Not a demo portal" });
  const cu = await upsertCustomer(ctx.org.id, { email: DEMO_CUSTOMER });
  return c.json(await issueSession(ctx, cu.id, SESSION_TTL.platform));
});

portalRoutes.get("/:slug/me", async (c) => {
  const ctx = await portal(c);
  const cl = session(c, ctx);
  const [cu] = await db.select().from(customers).where(eq(customers.id, cl.c));
  if (!cu) throw new HTTPException(401, { message: "Please sign in again" });
  return c.json({ customer: publicCustomer(cu), scope: cl.t ? "ticket" : "all" });
});

// ---------------------------------------------------------------- requests

const STATES = { open: ["open"], awaiting_you: ["pending"], solved: ["resolved", "closed"] } as const;

portalRoutes.get("/:slug/tickets", async (c) => {
  const ctx = await portal(c);
  const cl = session(c, ctx);
  const state = c.req.query("state");
  const statuses = state === "active" ? [...STATES.open, ...STATES.awaiting_you] : STATES[state as keyof typeof STATES];
  const rows = await db
    .select()
    .from(tickets)
    .where(and(scope(cl), statuses ? inArray(tickets.status, [...statuses]) : undefined))
    .orderBy(desc(tickets.lastMessageAt))
    .limit(200);

  const ids = rows.map((r) => r.id);
  const last = new Map<string, typeof messages.$inferSelect>();
  if (ids.length) {
    // Latest visible message per ticket.
    const latest = await db
      .selectDistinctOn([messages.ticketId])
      .from(messages)
      .where(and(inArray(messages.ticketId, ids), visible))
      .orderBy(messages.ticketId, desc(messages.createdAt));
    for (const m of latest) last.set(m.ticketId, m);
  }
  const counts = await db
    .select({ status: tickets.status, n: sql<number>`count(*)::int` })
    .from(tickets)
    .where(scope(cl))
    .groupBy(tickets.status);
  const count = (s: readonly string[]) => counts.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.n, 0);

  return c.json({
    tickets: rows.map((t) => {
      const m = last.get(t.id);
      return {
        ...publicTicket(ctx, t),
        preview: m ? markdownToPlain(m.body).slice(0, 160) : "",
        lastAuthor: m ? publicMessage(m).author : null,
      };
    }),
    counts: {
      open: count(STATES.open),
      awaiting_you: count(STATES.awaiting_you),
      solved: count(STATES.solved),
      all: count(["open", "pending", "resolved", "closed"]),
    },
  });
});

const bodySchema = z.object({ body: z.string().trim().min(1).max(20_000) });

portalRoutes.post("/:slug/tickets", async (c) => {
  const ctx = await portal(c, { limit: 10, scope: "write" });
  const cl = session(c, ctx);
  if (cl.t) throw new HTTPException(403, { message: "Sign in to open a new request" });
  if (!ctx.portal.allowNewRequests) throw new HTTPException(403, { message: "New requests are turned off here" });
  const b = bodySchema.extend({ subject: z.string().trim().min(1).max(200) }).parse(await c.req.json());
  const { ticket } = await createTicket(ctx.org.id, {
    subject: b.subject,
    body: b.body,
    channel: "portal",
    customerId: cl.c,
    meta: { via: "portal" },
  });
  return c.json({ ticket: publicTicket(ctx, ticket) }, 201);
});

portalRoutes.get("/:slug/tickets/:ref", async (c) => {
  const ctx = await portal(c);
  const cl = session(c, ctx);
  const t = await ownTicket(cl, c.req.param("ref"));
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.ticketId, t.id), visible))
    .orderBy(messages.createdAt);
  return c.json({
    ticket: { ...publicTicket(ctx, t), working: t.aiState === "processing" },
    messages: rows.map(publicMessage),
  });
});

portalRoutes.post("/:slug/tickets/:ref/messages", async (c) => {
  const ctx = await portal(c, { limit: 30, scope: "write" });
  const cl = session(c, ctx);
  const t = await ownTicket(cl, c.req.param("ref"));
  const b = bodySchema.parse(await c.req.json());
  const [cu] = await db.select().from(customers).where(eq(customers.id, cl.c));
  // A customer reply reopens a solved request (addMessage moves it back to open).
  const msg = await addMessage(ctx.org.id, t.id, {
    authorType: "customer",
    authorId: cl.c,
    authorName: cu?.name ?? null,
    body: b.body,
    meta: { via: "portal" },
  });
  const [updated] = await db.select().from(tickets).where(eq(tickets.id, t.id));
  return c.json({ message: publicMessage(msg), ticket: publicTicket(ctx, updated!) }, 201);
});

portalRoutes.post("/:slug/tickets/:ref/solve", async (c) => {
  const ctx = await portal(c, { limit: 30, scope: "write" });
  const cl = session(c, ctx);
  const t = await ownTicket(cl, c.req.param("ref"));
  const [cu] = await db.select().from(customers).where(eq(customers.id, cl.c));
  const updated = await updateTicket(
    ctx.org.id,
    t.id,
    { status: "resolved" },
    { type: "customer", id: cl.c, name: cu?.name ?? "The customer" },
  );
  return c.json({ ticket: publicTicket(ctx, updated) });
});

portalRoutes.get("/:slug/tickets/:ref/attachments/:id", async (c) => {
  const ctx = await portal(c);
  const cl = session(c, ctx);
  const t = await ownTicket(cl, c.req.param("ref"));
  const attId = c.req.param("id");
  if (!/^att_[a-z0-9]+$/.test(attId)) throw new HTTPException(404, { message: "Attachment not found" });
  const [m] = await db
    .select({ attachments: messages.attachments })
    .from(messages)
    .where(
      and(
        eq(messages.ticketId, t.id),
        visible,
        sql`${messages.attachments} @> ${JSON.stringify([{ id: attId }])}::jsonb`,
      ),
    )
    .limit(1);
  const meta = m?.attachments.find((a) => a.id === attId);
  const data = meta ? await readFile(join(env.DATA_DIR, "uploads", ctx.org.id, attId)).catch(() => null) : null;
  if (!meta || !data) throw new HTTPException(404, { message: "Attachment not found" });
  return c.body(data, 200, {
    "content-type": meta.contentType || "application/octet-stream",
    "content-disposition": `attachment; filename="${meta.name.replace(/["\r\n]/g, "")}"`,
    "x-content-type-options": "nosniff",
  });
});

// ---------------------------------------------------------------- answers

portalRoutes.get("/:slug/articles/search", async (c) => {
  const ctx = await portal(c, { limit: 60, scope: "search" });
  if (!ctx.portal.showKnowledge) return c.json({ articles: [] });
  const q = (c.req.query("q") ?? "").slice(0, 200);
  const hits = await searchKnowledge(ctx.org.id, q, { limit: 6, includeInternal: false });
  // Help-center articles have no public URL of their own: the portal shows them in full.
  const ids = hits.filter((h) => !h.url && h.articleId).map((h) => h.articleId!);
  const bodies = new Map(
    ids.length
      ? (
          await db
            .select({ id: articles.id, body: articles.body })
            .from(articles)
            .where(and(eq(articles.orgId, ctx.org.id), inArray(articles.id, ids), eq(articles.status, "published")))
        ).map((a) => [a.id, a.body])
      : [],
  );
  return c.json({
    articles: hits
      .filter((h) => h.url || (h.articleId && bodies.has(h.articleId)))
      .map((h) => ({
        id: h.documentId,
        title: h.title,
        url: h.url,
        excerpt: markdownToPlain(h.content).slice(0, 280),
        body: h.articleId ? (bodies.get(h.articleId) ?? null) : null,
      })),
  });
});

// ---------------------------------------------------------------- hosted page

/** The hosted portal: a page with the same <trace-portal> element you can embed on your own site. */
export const portalPageRoutes = new Hono();

portalPageRoutes.get("/:slug{[a-z0-9][a-z0-9-]{0,62}}/*", hostedPage);
portalPageRoutes.get("/:slug{[a-z0-9][a-z0-9-]{0,62}}", hostedPage);

async function hostedPage(c: Context) {
  const slug = c.req.param("slug") ?? "";
  const org = await findOrgBySlug(slug);
  const p = org ? portalSettings(await getSettings(org.id), org.name) : null;
  if (!org || !p?.enabled) {
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;color:#555"><p>There is no support portal here.</p></body>`,
      404,
    );
  }
  const title = escapeHtml(p.title || `${org.name} support`);
  const icon = escapeHtml(p.logoUrl || org.logo || "/favicon.svg");
  const light = "#f6f6f7";
  const dark = "#0e0e10";
  const bg =
    p.theme === "dark"
      ? `body{background:${dark}}`
      : p.theme === "light"
        ? `body{background:${light}}`
        : `body{background:${light}}@media (prefers-color-scheme: dark){body{background:${dark}}}`;
  const base = `/portal/${slug}`;
  return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<link rel="icon" href="${icon}" />
<style>html,body{margin:0;min-height:100%}${bg}</style>
</head>
<body>
<trace-portal workspace="${escapeHtml(slug)}" layout="page" routing="path" base-path="${escapeHtml(base)}"></trace-portal>
<script src="/portal.js" async></script>
</body>
</html>`);
}
