import { and, asc, desc, eq, gte, inArray, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.ts";
import { agentStatus, member, routingGroupMembers, routingGroups, routingRules, spans, tickets } from "../db/schema.ts";
import { badRequest, notFound } from "../lib/http.ts";
import type { RoutingConditions } from "../lib/types.ts";
import { id } from "../lib/ids.ts";
import { setAvailability } from "../services/routing/availability.ts";
import { decide, describeConditions, getRouting } from "../services/routing/engine.ts";
import { sweep } from "../services/routing/worker.ts";
import { getTicketByNumber } from "../services/tickets.ts";
import { updateSettings } from "../services/workspace.ts";
import { type AppEnv, requireAdmin } from "./middleware.ts";

/** Auto-assignment: settings, groups, rules, availability, preview and the decision log. Mounted at /api/w/:wid/routing */
export const routingRoutes = new Hono<AppEnv>();

const list = z.array(z.string().trim().min(1)).max(50);
const conditionsSchema = z.object({
  intents: list.optional(),
  tags: list.optional(),
  languages: list.optional(),
  channels: list.optional(),
  priorities: list.optional(),
  plans: list.optional(),
  minMrr: z.number().nonnegative().nullable().optional(),
});

const settingsSchema = z.object({
  enabled: z.boolean(),
  triggers: z.object({
    handoff: z.boolean(),
    approval: z.boolean(),
    lowConfidence: z.boolean(),
    confidenceBelow: z.number().min(0.05).max(1),
    slaSoon: z.boolean(),
    slaMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
    everyTicket: z.boolean(),
  }),
  method: z.enum(["least_open", "round_robin"]),
  maxOpenPerAgent: z.number().int().min(0).max(1000),
  stickyHours: z
    .number()
    .int()
    .min(0)
    .max(24 * 30),
  skipAway: z.boolean(),
  reassign: z.object({
    enabled: z.boolean(),
    minutesBeforeDue: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
    maxTimes: z.number().int().min(1).max(10),
  }),
  fallbackGroupId: z.string().nullable(),
});

async function groupsWithStats(orgId: string) {
  const [groups, members, statuses, loads] = await Promise.all([
    db.select().from(routingGroups).where(eq(routingGroups.orgId, orgId)).orderBy(asc(routingGroups.createdAt)),
    db.select().from(routingGroupMembers).where(eq(routingGroupMembers.orgId, orgId)),
    db.select().from(agentStatus).where(eq(agentStatus.orgId, orgId)),
    db
      .select({ userId: tickets.assigneeId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), inArray(tickets.status, ["open", "pending"])))
      .groupBy(tickets.assigneeId),
  ]);
  const away = new Set(statuses.filter((s) => s.status === "away").map((s) => s.userId));
  const load = new Map(loads.map((l) => [l.userId, l.n]));
  return groups.map((g) => {
    const ids = members.filter((m) => m.groupId === g.id).map((m) => m.userId);
    return {
      ...g,
      memberIds: ids,
      available: ids.filter((u) => !away.has(u)).length,
      open: ids.reduce((sum, u) => sum + (load.get(u) ?? 0), 0),
    };
  });
}

routingRoutes.get("/", async (c) => {
  const orgId = c.get("orgId");
  const [settings, groups, rules, statuses] = await Promise.all([
    getRouting(orgId),
    groupsWithStats(orgId),
    db
      .select()
      .from(routingRules)
      .where(eq(routingRules.orgId, orgId))
      .orderBy(asc(routingRules.position), asc(routingRules.createdAt)),
    db.select().from(agentStatus).where(eq(agentStatus.orgId, orgId)),
  ]);
  return c.json({
    settings,
    groups,
    rules: rules.map((r) => ({ ...r, label: describeConditions(r.conditions, r.match) })),
    statuses: Object.fromEntries(statuses.map((s) => [s.userId, s.status])),
  });
});

routingRoutes.put("/settings", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const body = settingsSchema.parse(await c.req.json());
  if (body.fallbackGroupId) {
    const [g] = await db
      .select({ id: routingGroups.id })
      .from(routingGroups)
      .where(and(eq(routingGroups.orgId, orgId), eq(routingGroups.id, body.fallbackGroupId)));
    if (!g) throw badRequest("Fallback group not found");
  }
  await updateSettings(orgId, { routing: body });
  // Pick up tickets that already need someone, instead of waiting for the next minute.
  if (body.enabled) void sweep().catch(() => {});
  return c.json({ settings: await getRouting(orgId) });
});

// ---------------------------------------------------------------- groups

const groupSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(300).default(""),
  memberIds: z.array(z.string()).max(200).default([]),
});

async function setMembers(orgId: string, groupId: string, memberIds: string[]) {
  const valid = memberIds.length
    ? (
        await db
          .select({ userId: member.userId })
          .from(member)
          .where(and(eq(member.organizationId, orgId), inArray(member.userId, memberIds)))
      ).map((m) => m.userId)
    : [];
  await db.delete(routingGroupMembers).where(eq(routingGroupMembers.groupId, groupId));
  if (valid.length) await db.insert(routingGroupMembers).values(valid.map((userId) => ({ groupId, userId, orgId })));
}

routingRoutes.post("/groups", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const b = groupSchema.parse(await c.req.json());
  const [g] = await db
    .insert(routingGroups)
    .values({ id: id("grp"), orgId, name: b.name, description: b.description })
    .returning();
  await setMembers(orgId, g!.id, b.memberIds);
  return c.json({ group: g }, 201);
});

routingRoutes.patch("/groups/:id", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const b = groupSchema.partial().parse(await c.req.json());
  const [g] = await db
    .update(routingGroups)
    .set({
      ...(b.name ? { name: b.name } : {}),
      ...(b.description !== undefined ? { description: b.description } : {}),
    })
    .where(and(eq(routingGroups.orgId, orgId), eq(routingGroups.id, c.req.param("id"))))
    .returning();
  if (!g) throw notFound("Group not found");
  if (b.memberIds) await setMembers(orgId, g.id, b.memberIds);
  return c.json({ group: g });
});

routingRoutes.delete("/groups/:id", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const gid = c.req.param("id");
  const s = await getRouting(orgId);
  if (s.fallbackGroupId === gid) await updateSettings(orgId, { routing: { ...s, fallbackGroupId: null } });
  await db.delete(routingGroups).where(and(eq(routingGroups.orgId, orgId), eq(routingGroups.id, gid)));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- rules

const ruleSchema = z.object({
  groupId: z.string(),
  match: z.enum(["any", "all"]).default("any"),
  conditions: conditionsSchema.default({}),
  enabled: z.boolean().default(true),
});

async function checkGroup(orgId: string, groupId: string) {
  const [g] = await db
    .select({ id: routingGroups.id })
    .from(routingGroups)
    .where(and(eq(routingGroups.orgId, orgId), eq(routingGroups.id, groupId)));
  if (!g) throw badRequest("Group not found");
}

/** Drop empty lists and nulls so stored conditions only hold what the rule actually checks. */
const clean = (c: z.infer<typeof conditionsSchema>): RoutingConditions => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) if (Array.isArray(v) ? v.length : v != null) out[k] = v;
  return out as RoutingConditions;
};

routingRoutes.post("/rules", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const b = ruleSchema.parse(await c.req.json());
  await checkGroup(orgId, b.groupId);
  const [{ max } = { max: -1 }] = await db
    .select({ max: sql<number>`coalesce(max(${routingRules.position}), -1)`.mapWith(Number) })
    .from(routingRules)
    .where(eq(routingRules.orgId, orgId));
  const [r] = await db
    .insert(routingRules)
    .values({ id: id("rul"), orgId, ...b, conditions: clean(b.conditions), position: max + 1 })
    .returning();
  return c.json({ rule: r }, 201);
});

routingRoutes.patch("/rules/:id", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  // No defaults on patch: zod applies .default() even under .partial().
  const b = z
    .object({ groupId: z.string(), match: z.enum(["any", "all"]), conditions: conditionsSchema, enabled: z.boolean() })
    .partial()
    .parse(await c.req.json());
  if (b.groupId) await checkGroup(orgId, b.groupId);
  const [r] = await db
    .update(routingRules)
    .set({ ...b, conditions: b.conditions ? clean(b.conditions) : undefined })
    .where(and(eq(routingRules.orgId, orgId), eq(routingRules.id, c.req.param("id"))))
    .returning();
  if (!r) throw notFound("Rule not found");
  return c.json({ rule: r });
});

routingRoutes.post("/rules/reorder", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const { ids } = z.object({ ids: z.array(z.string()).max(500) }).parse(await c.req.json());
  await Promise.all(
    ids.map((rid, position) =>
      db
        .update(routingRules)
        .set({ position })
        .where(and(eq(routingRules.orgId, orgId), eq(routingRules.id, rid))),
    ),
  );
  return c.json({ ok: true });
});

routingRoutes.delete("/rules/:id", requireAdmin, async (c) => {
  await db
    .delete(routingRules)
    .where(and(eq(routingRules.orgId, c.get("orgId")), eq(routingRules.id, c.req.param("id"))));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- availability

routingRoutes.get("/me", async (c) => {
  const [s] = await db
    .select()
    .from(agentStatus)
    .where(and(eq(agentStatus.orgId, c.get("orgId")), eq(agentStatus.userId, c.get("user").id)));
  const [{ open } = { open: 0 }] = await db
    .select({ open: sql<number>`count(*)`.mapWith(Number) })
    .from(tickets)
    .where(
      and(
        eq(tickets.orgId, c.get("orgId")),
        eq(tickets.assigneeId, c.get("user").id),
        inArray(tickets.status, ["open", "pending"]),
      ),
    );
  return c.json({ status: s?.status ?? "available", open });
});

routingRoutes.put("/me", async (c) => {
  const { status } = z.object({ status: z.enum(["available", "away"]) }).parse(await c.req.json());
  await setAvailability(c.get("orgId"), c.get("user").id, status);
  return c.json({ status });
});

// ---------------------------------------------------------------- preview & log

/** Where would this ticket go right now? Nothing is assigned. */
routingRoutes.get("/preview", async (c) => {
  const orgId = c.get("orgId");
  const n = Number(String(c.req.query("ticket") ?? "").replace(/\D/g, ""));
  const t = n ? await getTicketByNumber(orgId, n) : undefined;
  if (!t) throw notFound("Ticket not found");
  const d = await decide(orgId, t.id);
  if (!d) throw notFound("Ticket not found");
  return c.json({
    ticket: { number: t.number, subject: t.subject, assigneeId: t.assigneeId },
    rule: d.ruleLabel,
    group: d.group?.name ?? null,
    assignee: d.outcome?.person ? { id: d.outcome.person.userId, name: d.outcome.person.name } : null,
    pick: d.outcome?.person ? d.outcome.pick : null,
    why: d.why,
  });
});

routingRoutes.get("/log", async (c) => {
  const orgId = c.get("orgId");
  const rows = await db
    .select({
      id: spans.id,
      name: spans.name,
      summary: spans.summary,
      attributes: spans.attributes,
      at: spans.startedAt,
      number: tickets.number,
      subject: tickets.subject,
    })
    .from(spans)
    .innerJoin(tickets, eq(tickets.id, spans.ticketId))
    .where(
      and(eq(spans.orgId, orgId), like(spans.name, "route.%"), gte(spans.startedAt, new Date(Date.now() - 86_400_000))),
    )
    .orderBy(desc(spans.startedAt))
    .limit(40);
  return c.json({ entries: rows });
});
