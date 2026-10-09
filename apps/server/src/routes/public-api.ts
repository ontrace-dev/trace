import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db/index.ts";
import { apiKeys, channels } from "../db/schema.ts";
import { notFound, unauthorized } from "../lib/http.ts";
import { searchKnowledge } from "../services/knowledge/search.ts";
import { listTickets } from "../services/queries.ts";
import {
  addMessage,
  createTicket,
  getCustomer,
  getMessages,
  getTicket,
  getTicketByNumber,
  updateTicket,
  upsertCustomer,
} from "../services/tickets.ts";

/**
 * Public REST API (v1). Authenticate with `Authorization: Bearer trk_…` (Settings → API).
 * This is the "inbound API" for any system that wants to open or update tickets:
 * contact forms, backend error reports, CRMs, internal tools, …
 */
type ApiEnv = { Variables: { orgId: string; keyName: string } };

const requireApiKey = createMiddleware<ApiEnv>(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const key = header.replace(/^Bearer\s+/i, "").trim();
  if (!key.startsWith("trk_")) throw unauthorized("Missing API key");
  const hash = createHash("sha256").update(key).digest("hex");
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.hash, hash));
  if (!row) throw unauthorized("Invalid API key");
  c.set("orgId", row.orgId);
  c.set("keyName", row.name);
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .catch(() => {});
  await next();
});

export const publicApi = new Hono<ApiEnv>();
publicApi.use("*", requireApiKey);

const PRIORITY = z.enum(["low", "normal", "high", "urgent"]);
const STATUS = z.enum(["open", "pending", "resolved", "closed"]);

async function resolveTicket(orgId: string, ref: string) {
  const t = /^\d+$/.test(ref) ? await getTicketByNumber(orgId, Number(ref)) : await getTicket(orgId, ref);
  if (!t) throw notFound("Ticket not found");
  return t;
}

publicApi.get("/tickets", async (c) => {
  const status = c.req.query("status")?.split(",") as never;
  const rows = await listTickets(c.get("orgId"), { status, q: c.req.query("q") }, "", { limit: 100 });
  return c.json({ data: rows });
});

publicApi.post("/tickets", async (c) => {
  const orgId = c.get("orgId");
  const b = z
    .object({
      subject: z.string().min(1),
      body: z.string().min(1),
      customer: z.object({
        email: z.string().email().optional(),
        name: z.string().optional(),
        externalId: z.string().optional(),
        company: z.string().optional(),
        attributes: z.record(z.string(), z.unknown()).optional(),
      }),
      priority: PRIORITY.optional(),
      tags: z.array(z.string()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(await c.req.json());
  const [apiChannel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.type, "api")))
    .limit(1);
  const { ticket, message } = await createTicket(orgId, {
    subject: b.subject,
    body: b.body,
    channel: "api",
    channelId: apiChannel?.id,
    customer: b.customer,
    priority: b.priority,
    tags: b.tags,
  });
  return c.json({ data: { ticket, message } }, 201);
});

publicApi.get("/tickets/:ref", async (c) => {
  const t = await resolveTicket(c.get("orgId"), c.req.param("ref"));
  const [msgs, customer] = await Promise.all([getMessages(t.id), getCustomer(t.customerId)]);
  return c.json({ data: { ticket: t, customer, messages: msgs.filter((m) => m.kind !== "note") } });
});

publicApi.patch("/tickets/:ref", async (c) => {
  const orgId = c.get("orgId");
  const t = await resolveTicket(orgId, c.req.param("ref"));
  const b = z
    .object({
      status: STATUS.optional(),
      priority: PRIORITY.optional(),
      tags: z.array(z.string()).optional(),
      subject: z.string().optional(),
    })
    .parse(await c.req.json());
  const updated = await updateTicket(orgId, t.id, b, { type: "system", name: `API (${c.get("keyName")})` });
  return c.json({ data: updated });
});

/** Add a message. author: "customer" (default) appends a customer reply; "agent" sends a reply; "note" is internal. */
publicApi.post("/tickets/:ref/messages", async (c) => {
  const orgId = c.get("orgId");
  const t = await resolveTicket(orgId, c.req.param("ref"));
  const b = z
    .object({
      body: z.string().min(1),
      author: z.enum(["customer", "agent", "note"]).default("customer"),
      authorName: z.string().optional(),
    })
    .parse(await c.req.json());
  const customer = await getCustomer(t.customerId);
  const msg = await addMessage(orgId, t.id, {
    kind: b.author === "note" ? "note" : "message",
    authorType: b.author === "customer" ? "customer" : "agent",
    authorId: b.author === "customer" ? (customer?.id ?? null) : null,
    authorName: b.authorName ?? (b.author === "customer" ? customer?.name : `API (${c.get("keyName")})`),
    body: b.body,
    meta: { via: "api" },
  });
  return c.json({ data: msg }, 201);
});

publicApi.put("/customers", async (c) => {
  const b = z
    .object({
      email: z.string().email().optional(),
      name: z.string().optional(),
      externalId: z.string().optional(),
      company: z.string().optional(),
      attributes: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(await c.req.json());
  return c.json({ data: await upsertCustomer(c.get("orgId"), b) });
});

publicApi.get("/articles/search", async (c) => {
  // Public API: only knowledge marked public.
  const rows = await searchKnowledge(c.get("orgId"), c.req.query("q") ?? "", { limit: 10, includeInternal: false });
  return c.json({ data: rows });
});
