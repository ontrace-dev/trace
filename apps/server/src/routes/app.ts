import { and, asc, count, desc, eq, gte, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { db } from "../db/index.ts";
import {
  apiKeys,
  articles,
  type Attachment,
  channels,
  customers,
  drafts,
  integrations,
  member,
  messages,
  spans,
  ssoProvider,
  tickets,
  user,
  views,
} from "../db/schema.ts";
import { env } from "../env.ts";
import { bus, type BusEvent } from "../lib/bus.ts";
import { badRequest, notFound } from "../lib/http.ts";
import { id, secretToken } from "../lib/ids.ts";
import type {
  AiSettings,
  ChatWebhookConfig,
  SlaSettings,
  ViewFilters,
  WebhookConfig,
  WidgetSettings,
} from "../lib/types.ts";
import { getClaude } from "../services/ai/client.ts";
import { articleFromTicket, askWorkspace, rewriteText, summarizeTicket } from "../services/ai/copilot.ts";
import { enqueueAgent } from "../services/ai/queue.ts";
import { handleInboundEmail } from "../services/email/inbound.ts";
import {
  listTickets,
  pendingDraftFor,
  sidebarCounts,
  type SystemView,
  systemViewFilters,
} from "../services/queries.ts";
import {
  addMessage,
  createTicket,
  getCustomer,
  getMessages,
  getTicket,
  getTicketByNumber,
  sendDraft,
  updateTicket,
} from "../services/tickets.ts";
import { getOrg, getSettings, updateSettings } from "../services/workspace.ts";
import { WEBHOOK_EVENTS } from "../services/webhooks.ts";
import { postToHook } from "../services/notifications/chat-webhooks.ts";
import { decrypt, encrypt } from "../lib/crypto.ts";
import { enqueueIndexing, syncArticle } from "../services/knowledge/indexer.ts";
import { listRuns } from "../services/actions/runs.ts";
import { setFieldValue, ticketFieldValues } from "../services/fields.ts";
import { ticketIssueLinks } from "../services/issues/index.ts";
import { homeData, queuesOverview } from "../services/home.ts";
import { discoverOidc } from "../services/sso.ts";
import { type AppEnv, requireAdmin, requireUser, requireWorkspace } from "./middleware.ts";
import { mask, publicSettings } from "./serializers.ts";

export const appRoutes = new Hono<AppEnv>();
appRoutes.use("*", requireUser);

/** Workspaces the current user belongs to. */
appRoutes.get("/me", async (c) => {
  const u = c.get("user");
  const memberships = await db
    .select({ orgId: member.organizationId, role: member.role })
    .from(member)
    .where(eq(member.userId, u.id));
  return c.json({ user: u, memberships });
});

const w = new Hono<AppEnv>();
w.use("*", requireWorkspace);

const STATUS = z.enum(["open", "pending", "resolved", "closed"]);
const PRIORITY = z.enum(["low", "normal", "high", "urgent"]);
const actor = (c: { get: (k: "user") => AppEnv["Variables"]["user"] }) => {
  const u = c.get("user");
  return { type: "agent" as const, id: u.id, name: u.name };
};

// ---------------------------------------------------------------- bootstrap & realtime

w.get("/bootstrap", async (c) => {
  const orgId = c.get("orgId");
  const [settings, org, members, vs, chans] = await Promise.all([
    getSettings(orgId),
    getOrg(orgId),
    db
      .select({
        id: user.id,
        memberId: member.id,
        name: user.name,
        email: user.email,
        image: user.image,
        role: member.role,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, orgId))
      .orderBy(asc(user.name)),
    db.select().from(views).where(eq(views.orgId, orgId)).orderBy(asc(views.position), asc(views.createdAt)),
    db
      .select({ id: channels.id, type: channels.type, name: channels.name })
      .from(channels)
      .where(eq(channels.orgId, orgId)),
  ]);
  return c.json({
    org,
    role: c.get("role"),
    settings: publicSettings(settings),
    members,
    views: vs,
    channels: chans,
    ai: { online: !!getClaude(settings.ai), model: settings.ai.model },
    env: { publicUrl: env.PUBLIC_URL, inboundDomain: env.INBOUND_DOMAIN, smtpPort: env.INBOUND_SMTP_PORT },
  });
});

w.get("/counts", async (c) => c.json(await sidebarCounts(c.get("orgId"), c.get("user").id)));

/** The landing page: what needs a human, what's spiking, what the AI did, every queue at a glance. */
w.get("/home", async (c) => c.json(await homeData(c.get("orgId"), c.get("user").id)));

/** Every queue (built-in and saved views) with its live numbers. */
w.get("/views/overview", async (c) => c.json({ queues: await queuesOverview(c.get("orgId"), c.get("user").id) }));

w.get("/stream", (c) => {
  const orgId = c.get("orgId");
  return streamSSE(c, async (stream) => {
    const queue: BusEvent[] = [];
    let wake: (() => void) | null = null;
    const onEvent = (e: BusEvent) => {
      queue.push(e);
      wake?.();
    };
    bus.on(`org:${orgId}`, onEvent);
    stream.onAbort(() => {
      bus.off(`org:${orgId}`, onEvent);
      wake?.();
    });
    await stream.writeSSE({ event: "ready", data: "{}" });
    while (!stream.aborted) {
      if (!queue.length) {
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 25_000);
        });
        wake = null;
      }
      if (stream.aborted) break;
      if (!queue.length) {
        await stream.writeSSE({ event: "ping", data: "{}" });
        continue;
      }
      const batch = queue.splice(0, queue.length);
      for (const e of batch) await stream.writeSSE({ event: "change", data: JSON.stringify(e) });
    }
    bus.off(`org:${orgId}`, onEvent);
  });
});

// ---------------------------------------------------------------- tickets

const filtersSchema = z.object({
  status: z.array(STATUS).optional(),
  priority: z.array(PRIORITY).optional(),
  channel: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  assignee: z.string().optional(),
  aiState: z.array(z.string()).optional(),
  q: z.string().optional(),
});

w.get("/tickets", async (c) => {
  const orgId = c.get("orgId");
  const uid = c.get("user").id;
  const view = c.req.query("view") ?? "inbox";
  let filters: ViewFilters;
  if (view.startsWith("view_")) {
    const [v] = await db
      .select()
      .from(views)
      .where(and(eq(views.id, view), eq(views.orgId, orgId)));
    if (!v) throw notFound("View not found");
    filters = v.filters;
  } else {
    filters = systemViewFilters(view as SystemView, uid);
  }
  const q = c.req.query("q");
  if (q) filters = { ...filters, q };
  const status = c.req.query("status");
  if (status) filters = { ...filters, status: status.split(",") as ViewFilters["status"] };
  const before = c.req.query("before");
  const rows = await listTickets(orgId, filters, uid, { limit: 50, before: before ? new Date(before) : undefined });
  return c.json({ tickets: rows });
});

w.post("/tickets", async (c) => {
  const orgId = c.get("orgId");
  const body = z
    .object({
      subject: z.string().min(1),
      body: z.string().min(1),
      customerEmail: z.string().email().optional(),
      customerName: z.string().optional(),
      priority: PRIORITY.optional(),
      tags: z.array(z.string()).optional(),
      assigneeId: z.string().nullable().optional(),
      /** "customer": log a message on behalf of the customer (AI will triage). "outbound": agent writes to the customer. */
      mode: z.enum(["customer", "outbound"]).default("customer"),
    })
    .parse(await c.req.json());
  const u = c.get("user");
  const [emailChannel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.type, "email"), eq(channels.enabled, true)))
    .limit(1);
  const outbound = body.mode === "outbound";
  const viaEmail = outbound && !!emailChannel && !!body.customerEmail;
  const { ticket } = await createTicket(orgId, {
    subject: body.subject,
    body: body.body,
    channel: viaEmail ? "email" : "web",
    channelId: viaEmail ? emailChannel!.id : null,
    customer: body.customerEmail ? { email: body.customerEmail, name: body.customerName } : undefined,
    priority: body.priority,
    tags: body.tags,
    assigneeId: body.assigneeId ?? (outbound ? u.id : null),
    email: viaEmail ? { channelAddress: emailChannel!.address ?? undefined, references: [] } : undefined,
    noInitialMessage: outbound,
  });
  if (outbound) {
    // The agent's opener is a normal public reply, so it's delivered over email when possible.
    await addMessage(orgId, ticket.id, {
      authorType: "agent",
      authorId: u.id,
      authorName: u.name,
      body: body.body,
      meta: { via: "web" },
    });
  }
  return c.json({ ticket });
});

async function resolveTicket(orgId: string, ref: string) {
  const t = /^\d+$/.test(ref) ? await getTicketByNumber(orgId, Number(ref)) : await getTicket(orgId, ref);
  if (!t) throw notFound("Ticket not found");
  return t;
}

w.get("/tickets/:ref", async (c) => {
  const orgId = c.get("orgId");
  const ticket = await resolveTicket(orgId, c.req.param("ref"));
  const [msgs, customer, draft, traceSpans, assignee, runs] = await Promise.all([
    getMessages(ticket.id),
    getCustomer(ticket.customerId),
    pendingDraftFor(ticket.id),
    db.select().from(spans).where(eq(spans.ticketId, ticket.id)).orderBy(asc(spans.startedAt)),
    ticket.assigneeId
      ? db
          .select({ id: user.id, name: user.name, email: user.email, image: user.image })
          .from(user)
          .where(eq(user.id, ticket.assigneeId))
          .then((r) => r[0])
      : Promise.resolve(undefined),
    listRuns(orgId, ticket.id),
  ]);
  const [fieldValues, issueLinks] = await Promise.all([
    ticketFieldValues(orgId, ticket),
    ticketIssueLinks(orgId, ticket.id),
  ]);
  let customerStats = null;
  let recent: { id: string; number: number; subject: string; status: string; createdAt: Date }[] = [];
  if (customer) {
    const [agg] = await db
      .select({
        total: count(),
        open: sql<number>`count(*) filter (where ${tickets.status} in ('open','pending'))`.mapWith(Number),
      })
      .from(tickets)
      .where(eq(tickets.customerId, customer.id));
    customerStats = agg;
    recent = await db
      .select({
        id: tickets.id,
        number: tickets.number,
        subject: tickets.subject,
        status: tickets.status,
        createdAt: tickets.createdAt,
      })
      .from(tickets)
      .where(and(eq(tickets.customerId, customer.id), ne(tickets.id, ticket.id)))
      .orderBy(desc(tickets.createdAt))
      .limit(5);
  }
  // Group spans into traces (newest first).
  const traces = new Map<string, typeof traceSpans>();
  for (const s of traceSpans) traces.set(s.traceId, [...(traces.get(s.traceId) ?? []), s]);
  return c.json({
    ticket,
    messages: msgs,
    customer,
    customerStats,
    recent,
    draft,
    assignee,
    traces: [...traces.entries()].map(([traceId, s]) => ({ traceId, spans: s })).reverse(),
    runs,
    fields: fieldValues,
    links: issueLinks,
  });
});

/** Set a ticket field by hand (null clears it). */
w.patch("/tickets/:id/fields", async (c) => {
  const orgId = c.get("orgId");
  const { key, value } = z.object({ key: z.string(), value: z.unknown() }).parse(await c.req.json());
  const t = await resolveTicket(orgId, c.req.param("id"));
  try {
    await setFieldValue(orgId, t.id, key, value, actor(c));
  } catch (err) {
    throw badRequest((err as Error).message);
  }
  return c.json({ fields: await ticketFieldValues(orgId, (await getTicket(orgId, t.id))!) });
});

w.patch("/tickets/:id", async (c) => {
  const patch = z
    .object({
      subject: z.string().min(1).optional(),
      status: STATUS.optional(),
      priority: PRIORITY.optional(),
      assigneeId: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
    })
    .parse(await c.req.json());
  if (patch.status === "resolved" || patch.status === "closed") {
    // Fields marked "needed to resolve" must have a value first.
    const current = await getTicket(c.get("orgId"), c.req.param("id"));
    if (current) {
      const missing = (await ticketFieldValues(c.get("orgId"), current)).filter(
        (f) =>
          f.requiredToResolve && (f.value == null || f.value === "" || (Array.isArray(f.value) && !f.value.length)),
      );
      if (missing.length) throw badRequest(`Set ${missing.map((f) => f.label).join(", ")} before resolving`);
    }
  }
  const t = await updateTicket(c.get("orgId"), c.req.param("id"), patch, actor(c));
  return c.json({ ticket: t });
});

w.post("/tickets/:id/messages", async (c) => {
  const orgId = c.get("orgId");
  const body = z
    .object({
      body: z.string().min(1),
      kind: z.enum(["message", "note"]).default("message"),
      attachments: z
        .array(z.object({ id: z.string(), name: z.string(), size: z.number(), contentType: z.string() }))
        .optional(),
      status: STATUS.optional(),
    })
    .parse(await c.req.json());
  const u = c.get("user");
  const t = await getTicket(orgId, c.req.param("id"));
  if (!t) throw notFound();
  if (!t.assigneeId && body.kind === "message") {
    await updateTicket(orgId, t.id, { assigneeId: u.id }, actor(c));
  }
  const msg = await addMessage(orgId, t.id, {
    kind: body.kind,
    authorType: "agent",
    authorId: u.id,
    authorName: u.name,
    body: body.body,
    attachments: body.attachments as Attachment[] | undefined,
    meta: { via: "web" },
    status: body.status,
  });
  return c.json({ message: msg });
});

w.post("/tickets/:id/draft/send", async (c) => {
  const { body } = z.object({ body: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
  const u = c.get("user");
  const msg = await sendDraft(c.get("orgId"), c.req.param("id"), { id: u.id, name: u.name }, body);
  return c.json({ message: msg });
});

w.post("/tickets/:id/draft/discard", async (c) => {
  const orgId = c.get("orgId");
  const ticketId = c.req.param("id");
  await db
    .update(drafts)
    .set({ status: "discarded" })
    .where(and(eq(drafts.ticketId, ticketId), eq(drafts.orgId, orgId), eq(drafts.status, "pending")));
  await db
    .update(tickets)
    .set({ aiState: "none" })
    .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)));
  bus.publish({ type: "ai.state", orgId, ticketId, state: "none" });
  return c.json({ ok: true });
});

w.post("/tickets/:id/ai/run", async (c) => {
  const orgId = c.get("orgId");
  const t = await getTicket(orgId, c.req.param("id"));
  if (!t) throw notFound();
  enqueueAgent(orgId, t.id, { force: true, immediate: true });
  return c.json({ ok: true });
});

w.post("/tickets/:id/ai/summarize", async (c) => c.json(await summarizeTicket(c.get("orgId"), c.req.param("id"))));

w.post("/tickets/:id/ai/article", async (c) => {
  const orgId = c.get("orgId");
  const draft = await articleFromTicket(orgId, c.req.param("id"));
  const [a] = await db
    .insert(articles)
    .values({
      id: id("art"),
      orgId,
      title: draft.title,
      body: draft.body,
      tags: "tags" in draft ? (draft.tags as string[]) : [],
      status: "draft",
      source: "ai",
      sourceTicketId: c.req.param("id"),
      authorId: c.get("user").id,
    })
    .returning();
  return c.json({ article: a });
});

w.post("/ai/ask", async (c) => {
  const { question } = z.object({ question: z.string().min(1) }).parse(await c.req.json());
  return c.json(await askWorkspace(c.get("orgId"), question));
});

w.post("/ai/rewrite", async (c) => {
  const b = z
    .object({
      text: z.string().min(1),
      mode: z.enum(["improve", "shorten", "friendlier", "formal", "translate", "fix"]),
      language: z.string().optional(),
    })
    .parse(await c.req.json());
  return c.json(await rewriteText(c.get("orgId"), b.text, b.mode, b.language));
});

// ---------------------------------------------------------------- attachments

w.post("/uploads", async (c) => {
  const orgId = c.get("orgId");
  const form = await c.req.formData();
  const out: Attachment[] = [];
  for (const [, value] of form.entries()) {
    if (typeof value === "string") continue;
    const file = value as File;
    if (file.size > 15 * 1024 * 1024) throw badRequest(`${file.name} is larger than 15 MB`);
    const attId = id("att");
    const dir = join(env.DATA_DIR, "uploads", orgId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, attId), Buffer.from(await file.arrayBuffer()));
    out.push({ id: attId, name: file.name, size: file.size, contentType: file.type || "application/octet-stream" });
  }
  return c.json({ attachments: out });
});

w.get("/attachments/:id", async (c) => {
  const orgId = c.get("orgId");
  const attId = c.req.param("id");
  if (!/^att_[a-z0-9]+$/.test(attId)) throw notFound();
  const [m] = await db
    .select({ attachments: messages.attachments })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), sql`${messages.attachments} @> ${JSON.stringify([{ id: attId }])}::jsonb`))
    .limit(1);
  const meta = m?.attachments.find((a) => a.id === attId);
  const data = await readFile(join(env.DATA_DIR, "uploads", orgId, attId)).catch(() => null);
  if (!data) throw notFound();
  return c.body(data, 200, {
    "content-type": meta?.contentType ?? "application/octet-stream",
    "content-disposition": `inline; filename="${(meta?.name ?? attId).replace(/"/g, "")}"`,
  });
});

// ---------------------------------------------------------------- customers

w.get("/customers", async (c) => {
  const orgId = c.get("orgId");
  const q = c.req.query("q")?.trim();
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      company: customers.company,
      avatarUrl: customers.avatarUrl,
      attributes: customers.attributes,
      createdAt: customers.createdAt,
      lastSeenAt: customers.lastSeenAt,
      // Fully qualified: drizzle drops table prefixes in single-table selects, which breaks correlation.
      tickets: sql<number>`(select count(*) from "tickets" t where t.customer_id = "customers"."id")`.mapWith(Number),
      openTickets:
        sql<number>`(select count(*) from "tickets" t where t.customer_id = "customers"."id" and t.status in ('open','pending'))`.mapWith(
          Number,
        ),
    })
    .from(customers)
    .where(
      and(
        eq(customers.orgId, orgId),
        q
          ? or(ilike(customers.name, `%${q}%`), ilike(customers.email, `%${q}%`), ilike(customers.company, `%${q}%`))
          : undefined,
      ),
    )
    .orderBy(desc(sql`coalesce(${customers.lastSeenAt}, ${customers.createdAt})`))
    .limit(200);
  return c.json({ customers: rows });
});

w.get("/customers/:id", async (c) => {
  const orgId = c.get("orgId");
  const [cust] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.orgId, orgId), eq(customers.id, c.req.param("id"))));
  if (!cust) throw notFound();
  const ts = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      status: tickets.status,
      priority: tickets.priority,
      channel: tickets.channel,
      createdAt: tickets.createdAt,
      lastMessageAt: tickets.lastMessageAt,
    })
    .from(tickets)
    .where(eq(tickets.customerId, cust.id))
    .orderBy(desc(tickets.lastMessageAt));
  return c.json({ customer: cust, tickets: ts });
});

w.patch("/customers/:id", async (c) => {
  const orgId = c.get("orgId");
  const b = z
    .object({
      name: z.string().optional(),
      email: z.string().email().optional(),
      company: z.string().nullable().optional(),
      attributes: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(await c.req.json());
  const [row] = await db
    .update(customers)
    .set(b)
    .where(and(eq(customers.orgId, orgId), eq(customers.id, c.req.param("id"))))
    .returning();
  return c.json({ customer: row });
});

// ---------------------------------------------------------------- knowledge base

w.get("/articles", async (c) => {
  const orgId = c.get("orgId");
  const q = c.req.query("q")?.trim();
  const rows = await db
    .select({
      id: articles.id,
      title: articles.title,
      status: articles.status,
      tags: articles.tags,
      source: articles.source,
      views: articles.views,
      citations: articles.citations,
      updatedAt: articles.updatedAt,
      excerpt: sql<string>`left(${articles.body}, 200)`,
    })
    .from(articles)
    .where(
      and(
        eq(articles.orgId, orgId),
        q ? or(ilike(articles.title, `%${q}%`), ilike(articles.body, `%${q}%`)) : undefined,
      ),
    )
    .orderBy(desc(articles.updatedAt));
  return c.json({ articles: rows });
});

const articleSchema = z.object({
  title: z.string().min(1),
  body: z.string().default(""),
  status: z.enum(["draft", "published"]).default("draft"),
  tags: z.array(z.string()).default([]),
});

// Patch schemas never carry defaults: zod applies .default() even under .partial().
const articlePatchSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  status: z.enum(["draft", "published"]).optional(),
  tags: z.array(z.string()).optional(),
});

w.post("/articles", async (c) => {
  const b = articleSchema.parse(await c.req.json());
  const [a] = await db
    .insert(articles)
    .values({ id: id("art"), orgId: c.get("orgId"), ...b, authorId: c.get("user").id })
    .returning();
  void enqueueIndexing(() => syncArticle(a!.id));
  return c.json({ article: a });
});

w.get("/articles/:id", async (c) => {
  const [a] = await db
    .select()
    .from(articles)
    .where(and(eq(articles.orgId, c.get("orgId")), eq(articles.id, c.req.param("id"))));
  if (!a) throw notFound();
  return c.json({ article: a });
});

w.patch("/articles/:id", async (c) => {
  const b = articlePatchSchema.parse(await c.req.json());
  const [a] = await db
    .update(articles)
    .set(b)
    .where(and(eq(articles.orgId, c.get("orgId")), eq(articles.id, c.req.param("id"))))
    .returning();
  if (!a) throw notFound();
  void enqueueIndexing(() => syncArticle(a.id));
  return c.json({ article: a });
});

w.delete("/articles/:id", async (c) => {
  // Knowledge documents cascade with the article.
  await db.delete(articles).where(and(eq(articles.orgId, c.get("orgId")), eq(articles.id, c.req.param("id"))));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- views

const viewSchema = z.object({
  name: z.string().min(1),
  icon: z.string().default("layers"),
  filters: filtersSchema.default({}),
});

w.post("/views", async (c) => {
  const b = viewSchema.parse(await c.req.json());
  const [v] = await db
    .insert(views)
    .values({
      id: id("view"),
      orgId: c.get("orgId"),
      ...b,
      filters: b.filters as ViewFilters,
      createdBy: c.get("user").id,
      position: 99,
    })
    .returning();
  return c.json({ view: v });
});

w.patch("/views/:id", async (c) => {
  const b = viewSchema
    .partial()
    .extend({ position: z.number().optional() })
    .parse(await c.req.json());
  const [v] = await db
    .update(views)
    .set({ ...b, filters: b.filters as ViewFilters | undefined })
    .where(and(eq(views.orgId, c.get("orgId")), eq(views.id, c.req.param("id"))))
    .returning();
  return c.json({ view: v });
});

w.delete("/views/:id", async (c) => {
  await db.delete(views).where(and(eq(views.orgId, c.get("orgId")), eq(views.id, c.req.param("id"))));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- settings (admin)

w.get("/settings", async (c) => {
  const s = await getSettings(c.get("orgId"));
  return c.json({ settings: { ...publicSettings(s), widget: s.widget }, aiApiKeyMasked: mask(s.ai.apiKey) });
});

w.patch("/settings", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const current = await getSettings(orgId);
  const b = z
    .object({
      ticketPrefix: z
        .string()
        .regex(/^[A-Z]{1,6}$/)
        .optional(),
      accentColor: z.string().optional(),
      timezone: z.string().optional(),
      ai: z.record(z.string(), z.unknown()).optional(),
      widget: z.record(z.string(), z.unknown()).optional(),
      sla: z.object({ firstResponse: z.record(z.string(), z.number()) }).optional(),
    })
    .parse(await c.req.json());
  const ai = b.ai ? ({ ...current.ai, ...b.ai } as AiSettings) : undefined;
  // Empty string clears the BYO key; undefined keeps it.
  if (ai && b.ai && "apiKey" in b.ai && b.ai.apiKey === undefined) ai.apiKey = current.ai.apiKey;
  const row = await updateSettings(orgId, {
    ticketPrefix: b.ticketPrefix,
    accentColor: b.accentColor,
    timezone: b.timezone,
    ai,
    widget: b.widget ? ({ ...current.widget, ...b.widget } as WidgetSettings) : undefined,
    sla: b.sla
      ? ({ firstResponse: { ...current.sla.firstResponse, ...b.sla.firstResponse } } as SlaSettings)
      : undefined,
  });
  return c.json({ settings: { ...publicSettings(row), widget: row.widget } });
});

// ---------------------------------------------------------------- channels (admin)

w.get("/channels", async (c) => {
  const rows = await db
    .select()
    .from(channels)
    .where(eq(channels.orgId, c.get("orgId")))
    .orderBy(asc(channels.createdAt));
  return c.json({
    channels: rows.map((ch) => ({
      ...ch,
      config: { ...ch.config, smtpUrl: ch.config.smtpUrl ? mask(ch.config.smtpUrl) : undefined },
      forwardingAddress: ch.type === "email" ? `${ch.inboundToken}@${env.INBOUND_DOMAIN}` : undefined,
      webhookUrl: ch.type === "email" ? `${env.PUBLIC_URL}/api/inbound/email/${ch.inboundToken}` : undefined,
    })),
  });
});

const emailChannelSchema = z.object({
  name: z.string().min(1),
  address: z.string().email(),
  fromName: z.string().optional(),
  signature: z.string().optional(),
  smtpUrl: z.string().optional(),
  enabled: z.boolean().optional(),
});

w.post("/channels", requireAdmin, async (c) => {
  const b = emailChannelSchema.parse(await c.req.json());
  const [ch] = await db
    .insert(channels)
    .values({
      id: id("ch"),
      orgId: c.get("orgId"),
      type: "email",
      name: b.name,
      address: b.address.toLowerCase(),
      inboundToken: secretToken(20).toLowerCase(),
      config: { fromName: b.fromName, signature: b.signature, smtpUrl: b.smtpUrl || undefined },
    })
    .returning();
  return c.json({ channel: ch });
});

w.patch("/channels/:id", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const b = emailChannelSchema.partial().parse(await c.req.json());
  const [cur] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.id, c.req.param("id"))));
  if (!cur) throw notFound();
  const config = { ...cur.config };
  if (b.fromName !== undefined) config.fromName = b.fromName;
  if (b.signature !== undefined) config.signature = b.signature;
  if (b.smtpUrl !== undefined && !b.smtpUrl.includes("••••")) config.smtpUrl = b.smtpUrl || undefined;
  const [ch] = await db
    .update(channels)
    .set({ name: b.name, address: b.address?.toLowerCase(), enabled: b.enabled, config })
    .where(eq(channels.id, cur.id))
    .returning();
  return c.json({ channel: ch });
});

w.delete("/channels/:id", requireAdmin, async (c) => {
  await db
    .delete(channels)
    .where(and(eq(channels.orgId, c.get("orgId")), eq(channels.id, c.req.param("id")), eq(channels.type, "email")));
  return c.json({ ok: true });
});

/** Simulate an inbound email so admins can verify routing end-to-end. */
w.post("/channels/:id/test", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const [ch] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.id, c.req.param("id"))));
  if (!ch || ch.type !== "email") throw notFound();
  const b = z
    .object({
      from: z.string().email().default("customer@example.com"),
      subject: z.string().default("Test email"),
      body: z.string().default("Hello! This is a test message."),
    })
    .parse(await c.req.json().catch(() => ({})));
  const result = await handleInboundEmail(
    {
      from: { address: b.from, name: "Test Customer" },
      to: [ch.address ?? ""],
      subject: b.subject,
      text: b.body,
      messageId: `${id("test")}@example.com`,
    },
    ch,
  );
  return c.json(result);
});

// ---------------------------------------------------------------- API keys (admin)

w.get("/api-keys", requireAdmin, async (c) => {
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.orgId, c.get("orgId")))
    .orderBy(desc(apiKeys.createdAt));
  return c.json({ apiKeys: rows });
});

w.post("/api-keys", requireAdmin, async (c) => {
  const { name } = z.object({ name: z.string().min(1) }).parse(await c.req.json());
  const key = `trk_${secretToken(40)}`;
  const [row] = await db
    .insert(apiKeys)
    .values({
      id: id("key"),
      orgId: c.get("orgId"),
      name,
      prefix: key.slice(0, 10),
      hash: createHash("sha256").update(key).digest("hex"),
      createdBy: c.get("user").id,
    })
    .returning({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt });
  return c.json({ apiKey: row, key });
});

w.delete("/api-keys/:id", requireAdmin, async (c) => {
  await db.delete(apiKeys).where(and(eq(apiKeys.orgId, c.get("orgId")), eq(apiKeys.id, c.req.param("id"))));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- integrations: list + webhooks

w.get("/integrations", async (c) => {
  const rows = await db
    .select()
    .from(integrations)
    .where(eq(integrations.orgId, c.get("orgId")))
    .orderBy(asc(integrations.createdAt));
  return c.json({
    integrations: rows.map((r) => ({
      ...r,
      config:
        r.config.kind === "slack"
          ? {
              ...r.config,
              botToken: mask(r.config.botToken),
              appToken: mask(r.config.appToken),
              signingSecret: mask(r.config.signingSecret),
            }
          : r.config.kind === "discord"
            ? { ...r.config, botToken: "••••" }
            : r.config.kind === "chat_webhook"
              ? { ...r.config, url: maskWebhookUrl(r.config.url) }
              : r.config.kind === "linear"
                ? { ...r.config, apiKey: "••••" }
                : r.config.kind === "jira"
                  ? { ...r.config, apiToken: "••••" }
                  : { ...r.config, secret: mask(r.config.secret) },
    })),
    webhookEvents: WEBHOOK_EVENTS,
  });
});

w.post("/integrations/webhooks", requireAdmin, async (c) => {
  const b = z
    .object({ name: z.string().min(1), url: z.string().url(), events: z.array(z.string()).default([]) })
    .parse(await c.req.json());
  const secret = `whsec_${secretToken(32)}`;
  const config: WebhookConfig = { kind: "webhook", url: b.url, secret, events: b.events };
  const [row] = await db
    .insert(integrations)
    .values({ id: id("int"), orgId: c.get("orgId"), provider: "webhook", name: b.name, config, status: "pending" })
    .returning();
  return c.json({ integration: row, secret });
});

w.patch("/integrations/webhooks/:id", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const b = z
    .object({
      name: z.string().optional(),
      url: z.string().url().optional(),
      events: z.array(z.string()).optional(),
      enabled: z.boolean().optional(),
    })
    .parse(await c.req.json());
  const [cur] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.orgId, orgId), eq(integrations.id, c.req.param("id"))));
  if (!cur || cur.config.kind !== "webhook") throw notFound();
  const config: WebhookConfig = { ...cur.config, url: b.url ?? cur.config.url, events: b.events ?? cur.config.events };
  const [row] = await db
    .update(integrations)
    .set({ name: b.name, enabled: b.enabled, config })
    .where(eq(integrations.id, cur.id))
    .returning();
  return c.json({ integration: row });
});

// ---------------------------------------------------------------- integrations: chat webhooks ("just notify me")

/** Show where a webhook posts without exposing the secret part of the URL. */
function maskWebhookUrl(encrypted: string) {
  try {
    const u = new URL(decrypt(encrypted));
    return `${u.host}/…${u.pathname.slice(-4)}`;
  } catch {
    return "••••";
  }
}

const chatWebhookSchema = z.object({
  name: z.string().min(1).max(80),
  platform: z.enum(["slack", "discord"]),
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), "Webhook URLs must use https"),
  events: z.array(z.enum(["ticket.created", "ticket.escalated"])).min(1),
  waitForAi: z.boolean(),
});

w.post("/integrations/chat-webhooks", requireAdmin, async (c) => {
  const b = chatWebhookSchema.parse(await c.req.json());
  const config: ChatWebhookConfig = {
    kind: "chat_webhook",
    platform: b.platform,
    url: encrypt(b.url),
    events: b.events,
    waitForAi: b.waitForAi,
  };
  const [row] = await db
    .insert(integrations)
    .values({ id: id("int"), orgId: c.get("orgId"), provider: "chat_webhook", name: b.name, config, status: "pending" })
    .returning();
  return c.json({ integration: { ...row, config: { ...config, url: maskWebhookUrl(config.url) } } });
});

w.patch("/integrations/chat-webhooks/:id", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const b = z
    .object({
      name: z.string().min(1).max(80).optional(),
      url: z
        .string()
        .url()
        .refine((u) => u.startsWith("https://"), "Webhook URLs must use https")
        .optional(),
      events: z
        .array(z.enum(["ticket.created", "ticket.escalated"]))
        .min(1)
        .optional(),
      waitForAi: z.boolean().optional(),
      enabled: z.boolean().optional(),
    })
    .parse(await c.req.json());
  const [cur] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.orgId, orgId), eq(integrations.id, c.req.param("id"))));
  if (!cur || cur.config.kind !== "chat_webhook") throw notFound();
  const config: ChatWebhookConfig = {
    ...cur.config,
    url: b.url ? encrypt(b.url) : cur.config.url,
    events: b.events ?? cur.config.events,
    waitForAi: b.waitForAi ?? cur.config.waitForAi,
  };
  const [row] = await db
    .update(integrations)
    .set({ name: b.name, enabled: b.enabled, config })
    .where(eq(integrations.id, cur.id))
    .returning();
  return c.json({ integration: { ...row, config: { ...config, url: maskWebhookUrl(config.url) } } });
});

/** Post the most recent ticket (with its full context) so admins can see exactly what the channel gets. */
w.post("/integrations/chat-webhooks/:id/test", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const [hook] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.orgId, orgId), eq(integrations.id, c.req.param("id"))));
  if (!hook || hook.config.kind !== "chat_webhook") throw notFound();
  const [latest] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.orgId, orgId))
    .orderBy(desc(tickets.createdAt))
    .limit(1);
  if (!latest) throw badRequest("Create a ticket first — the test posts your most recent ticket.");
  await postToHook(
    hook as never,
    latest,
    hook.config.platform === "slack" ? ":test_tube: *Test message from trace*" : "🧪 **Test message from trace**",
  );
  const [after] = await db.select().from(integrations).where(eq(integrations.id, hook.id));
  if (after?.status === "error")
    throw badRequest(`The webhook rejected the message: ${after.statusMessage ?? "unknown error"}`);
  return c.json({ ok: true });
});

w.delete("/integrations/:id", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const [row] = await db
    .delete(integrations)
    .where(and(eq(integrations.orgId, orgId), eq(integrations.id, c.req.param("id"))))
    .returning();
  if (row) bus.publish({ type: "integration.updated", orgId, integrationId: row.id });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- insights

w.get("/insights", async (c) => {
  const orgId = c.get("orgId");
  const since = new Date(Date.now() - 14 * 86_400_000);
  const [perDay, byChannel, byIntent, totals, aiReplies, frt] = await Promise.all([
    db
      .select({ day: sql<string>`to_char(date_trunc('day', ${tickets.createdAt}), 'YYYY-MM-DD')`, n: count() })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), gte(tickets.createdAt, since)))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    db
      .select({ channel: tickets.channel, n: count() })
      .from(tickets)
      .where(eq(tickets.orgId, orgId))
      .groupBy(tickets.channel),
    db
      .select({ intent: tickets.aiIntent, n: count() })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), sql`${tickets.aiIntent} is not null`))
      .groupBy(tickets.aiIntent)
      .orderBy(desc(count()))
      .limit(8),
    db
      .select({
        total: count(),
        open: sql<number>`count(*) filter (where ${tickets.status} in ('open','pending'))`.mapWith(Number),
        resolved: sql<number>`count(*) filter (where ${tickets.status} in ('resolved','closed'))`.mapWith(Number),
        autoReplied: sql<number>`count(*) filter (where ${tickets.aiState} = 'auto_replied')`.mapWith(Number),
        breached:
          sql<number>`count(*) filter (where ${tickets.firstRespondedAt} is null and ${tickets.firstResponseDueAt} < now() and ${tickets.status} = 'open')`.mapWith(
            Number,
          ),
      })
      .from(tickets)
      .where(eq(tickets.orgId, orgId)),
    db
      .select({ authorType: messages.authorType, n: count() })
      .from(messages)
      .where(
        and(eq(messages.orgId, orgId), eq(messages.kind, "message"), inArray(messages.authorType, ["agent", "ai"])),
      )
      .groupBy(messages.authorType),
    db
      .select({
        median: sql<
          number | null
        >`percentile_cont(0.5) within group (order by extract(epoch from (${tickets.firstRespondedAt} - ${tickets.createdAt})))`,
      })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), sql`${tickets.firstRespondedAt} is not null`)),
  ]);
  return c.json({
    perDay,
    byChannel,
    byIntent,
    totals: totals[0],
    replies: aiReplies,
    medianFirstResponseSeconds: frt[0]?.median ?? null,
  });
});

// ---------------------------------------------------------------- single sign-on (providers live in Better Auth)

w.get("/sso", async (c) => {
  const settings = await getSettings(c.get("orgId"));
  return c.json({
    settings: settings.sso ?? { defaultRole: "member", enforcedDomains: [] },
    // What admins paste into their identity provider.
    authBaseUrl: `${env.APP_URL}/api/auth`,
  });
});

w.post("/sso/discover", requireAdmin, async (c) => {
  const { issuer } = z.object({ issuer: z.string().trim().min(1) }).parse(await c.req.json());
  return c.json(await discoverOidc(issuer));
});

w.put("/sso", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const body = z
    .object({
      defaultRole: z.enum(["member", "admin"]),
      enforcedDomains: z.array(z.string().trim().toLowerCase()).max(50),
    })
    .parse(await c.req.json());
  // Only domains this workspace has proven it owns can be locked to SSO.
  const verified = (
    await db
      .select({ domain: ssoProvider.domain })
      .from(ssoProvider)
      .where(and(eq(ssoProvider.organizationId, orgId), eq(ssoProvider.domainVerified, true)))
  ).flatMap((p) =>
    p.domain
      .toLowerCase()
      .split(",")
      .map((d) => d.trim()),
  );
  const bad = body.enforcedDomains.filter((d) => !verified.includes(d));
  if (bad.length) throw badRequest(`Verify ${bad.join(", ")} before requiring SSO for it`);
  const row = await updateSettings(orgId, { sso: body });
  return c.json({ settings: row.sso });
});

// Mounted last: Hono copies a sub-app's routes at mount time.
appRoutes.route("/w/:wid", w);
