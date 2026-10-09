import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import {
  agentStatus,
  customers,
  routingGroupMembers,
  routingGroups,
  routingRules,
  tickets,
  user,
} from "../../db/schema.ts";
import type { RoutingConditions, RoutingSettings, RoutingTrigger, TicketRouting } from "../../lib/types.ts";
import { updateTicket } from "../tickets.ts";
import { Trace } from "../tracer.ts";
import { getSettings } from "../workspace.ts";

/**
 * Auto-assignment. trace answers first; a ticket is routed to a person only when it needs one
 * (hand-off, approval, low confidence, first reply about to slip). Rules pick a group from what
 * triage found; inside the group we pick a person (same customer → fewest open / round robin),
 * skipping people who are away or full. Every decision is a span on the ticket's trace.
 */

export const defaultRouting = (): RoutingSettings => ({
  enabled: false,
  triggers: {
    handoff: true,
    approval: true,
    lowConfidence: true,
    confidenceBelow: 0.7,
    slaSoon: true,
    slaMinutes: 15,
    everyTicket: false,
  },
  method: "least_open",
  maxOpenPerAgent: 20,
  stickyHours: 72,
  skipAway: true,
  reassign: { enabled: true, minutesBeforeDue: 10, maxTimes: 2 },
  fallbackGroupId: null,
});

export async function getRouting(orgId: string): Promise<RoutingSettings> {
  const s = await getSettings(orgId);
  const d = defaultRouting();
  const r = s.routing ?? d;
  return { ...d, ...r, triggers: { ...d.triggers, ...r.triggers }, reassign: { ...d.reassign, ...r.reassign } };
}

type Rule = typeof routingRules.$inferSelect;
type TicketRow = typeof tickets.$inferSelect;

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
/** Customer attributes are free-form; only plain strings and numbers take part in rules. */
const scalar = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
const mrrOf = (v: unknown) => {
  const raw = scalar(v).trim();
  const n = Number(raw.replace(/[^\d.]/g, ""));
  return raw && Number.isFinite(n) ? n : null;
};

/** Does a rule match? `any`: one set condition is enough; `all`: every set condition must hold. */
export function ruleMatches(
  rule: Pick<Rule, "conditions" | "match">,
  t: Pick<TicketRow, "aiIntent" | "aiLanguage" | "tags" | "channel" | "priority">,
  customerAttrs: Record<string, unknown>,
) {
  const c = rule.conditions;
  const checks: boolean[] = [];
  if (c.intents?.length) checks.push(!!t.aiIntent && c.intents.map(norm).includes(norm(t.aiIntent)));
  if (c.tags?.length) checks.push(c.tags.map(norm).some((x) => t.tags.map(norm).includes(x)));
  if (c.languages?.length)
    checks.push(!!t.aiLanguage && c.languages.map(norm).includes(norm(t.aiLanguage).slice(0, 2)));
  if (c.channels?.length) checks.push(c.channels.includes(t.channel));
  if (c.priorities?.length) checks.push(c.priorities.includes(t.priority));
  if (c.plans?.length) checks.push(c.plans.map(norm).includes(norm(scalar(customerAttrs.plan))));
  if (c.minMrr != null) {
    const mrr = mrrOf(customerAttrs.mrr);
    checks.push(mrr != null && mrr >= c.minMrr);
  }
  if (!checks.length) return true;
  return rule.match === "all" ? checks.every(Boolean) : checks.some(Boolean);
}

/** "intent billing issue, refund · or tag #billing" */
export function describeConditions(c: RoutingConditions, match: "any" | "all" = "any") {
  const parts: string[] = [];
  const h = (xs: string[]) => xs.map((x) => x.replace(/_/g, " ")).join(", ");
  if (c.intents?.length) parts.push(`intent ${h(c.intents)}`);
  if (c.tags?.length) parts.push(`tag ${c.tags.map((t) => `#${t}`).join(" ")}`);
  if (c.languages?.length) parts.push(`language ${c.languages.join(", ")}`);
  if (c.channels?.length) parts.push(`channel ${c.channels.join(", ")}`);
  if (c.priorities?.length) parts.push(`priority ${c.priorities.join(", ")}`);
  if (c.plans?.length) parts.push(`plan ${c.plans.join(", ")}`);
  if (c.minMrr != null) parts.push(`MRR ≥ ${c.minMrr.toLocaleString()}`);
  return parts.length ? parts.join(match === "all" ? " and " : " or ") : "everything";
}

const ago = (d: Date) => {
  const h = (Date.now() - d.getTime()) / 3_600_000;
  return h < 1
    ? `${Math.max(1, Math.round(h * 60))}m ago`
    : h < 48
      ? `${Math.round(h)}h ago`
      : `${Math.round(h / 24)}d ago`;
};

interface Candidate {
  userId: string;
  name: string;
  open: number;
  lastAssignedAt: Date | null;
}

/** Everyone in a group who could take a ticket right now, with their open load. */
async function candidatesFor(orgId: string, groupId: string, settings: RoutingSettings, exclude?: string | null) {
  const members = await db
    .select({
      userId: routingGroupMembers.userId,
      name: user.name,
      status: agentStatus.status,
      lastAssignedAt: agentStatus.lastAssignedAt,
    })
    .from(routingGroupMembers)
    .innerJoin(user, eq(user.id, routingGroupMembers.userId))
    .leftJoin(agentStatus, and(eq(agentStatus.orgId, orgId), eq(agentStatus.userId, routingGroupMembers.userId)))
    .where(eq(routingGroupMembers.groupId, groupId));
  const ids = members.map((m) => m.userId);
  const loads = ids.length
    ? await db
        .select({ userId: tickets.assigneeId, n: sql<number>`count(*)`.mapWith(Number) })
        .from(tickets)
        .where(
          and(eq(tickets.orgId, orgId), inArray(tickets.assigneeId, ids), inArray(tickets.status, ["open", "pending"])),
        )
        .groupBy(tickets.assigneeId)
    : [];
  const load = new Map(loads.map((l) => [l.userId, l.n]));
  const all: Candidate[] = members.map((m) => ({
    userId: m.userId,
    name: m.name,
    open: load.get(m.userId) ?? 0,
    lastAssignedAt: m.lastAssignedAt,
  }));
  const away = new Set(members.filter((m) => m.status === "away").map((m) => m.userId));
  const usable = all.filter(
    (c) =>
      c.userId !== exclude &&
      !(settings.skipAway && away.has(c.userId)) &&
      !(settings.maxOpenPerAgent > 0 && c.open >= settings.maxOpenPerAgent),
  );
  return { all, usable, away: away.size, members: members.length };
}

async function pickPerson(
  orgId: string,
  t: TicketRow,
  groupId: string,
  settings: RoutingSettings,
  exclude?: string | null,
): Promise<{ person: Candidate; pick: string } | { person: null; why: string }> {
  const { usable, members, away } = await candidatesFor(orgId, groupId, settings, exclude);
  if (!usable.length)
    return {
      person: null,
      why: !members ? "group has nobody in it" : away === members ? "everyone is away" : "nobody available",
    };
  // Same customer, same person — if they're in this group and can take it.
  if (settings.stickyHours > 0 && t.customerId) {
    const since = new Date(Date.now() - settings.stickyHours * 3_600_000);
    const [prev] = await db
      .select({ assigneeId: tickets.assigneeId, at: tickets.lastMessageAt })
      .from(tickets)
      .where(
        and(
          eq(tickets.orgId, orgId),
          eq(tickets.customerId, t.customerId),
          ne(tickets.id, t.id),
          isNotNull(tickets.assigneeId),
          sql`${tickets.lastMessageAt} >= ${since.toISOString()}`,
        ),
      )
      .orderBy(desc(tickets.lastMessageAt))
      .limit(1);
    const person = prev && usable.find((c) => c.userId === prev.assigneeId);
    if (person) return { person, pick: `same customer ${ago(prev.at)}` };
  }
  const byRecency = (a: Candidate, b: Candidate) =>
    (a.lastAssignedAt?.getTime() ?? 0) - (b.lastAssignedAt?.getTime() ?? 0);
  if (settings.method === "round_robin") {
    const [person] = [...usable].sort(byRecency);
    return { person: person!, pick: usable.length > 1 ? "round robin" : "only one available" };
  }
  const sorted = [...usable].sort((a, b) => a.open - b.open || byRecency(a, b));
  const [person, next] = sorted;
  return {
    person: person!,
    pick: !next
      ? `only one available (${person!.open} open)`
      : next.open === person!.open
        ? `fewest open (${person!.open}, tie → longest since a ticket)`
        : `fewest open (${person!.open} vs ${next.open})`,
  };
}

export interface RouteResult {
  assigned: boolean;
  userId?: string;
  name?: string;
  groupName?: string;
  ruleLabel?: string;
  pick?: string;
  reason?: string;
}

/** Decide where a ticket would go, without assigning. Used by routeTicket and the settings preview. */
export async function decide(orgId: string, ticketId: string, opts: { exclude?: string | null } = {}) {
  const settings = await getRouting(orgId);
  const [row] = await db
    .select({ t: tickets, attrs: customers.attributes })
    .from(tickets)
    .leftJoin(customers, eq(customers.id, tickets.customerId))
    .where(and(eq(tickets.orgId, orgId), eq(tickets.id, ticketId)));
  if (!row) return null;
  const t = row.t;
  const rules = await db
    .select({ rule: routingRules, groupName: routingGroups.name })
    .from(routingRules)
    .innerJoin(routingGroups, eq(routingGroups.id, routingRules.groupId))
    .where(and(eq(routingRules.orgId, orgId), eq(routingRules.enabled, true)))
    .orderBy(asc(routingRules.position), asc(routingRules.createdAt));
  const idx = rules.findIndex((r) => ruleMatches(r.rule, t, (row.attrs ?? {}) as Record<string, unknown>));
  const fallback = settings.fallbackGroupId
    ? (
        await db
          .select()
          .from(routingGroups)
          .where(and(eq(routingGroups.orgId, orgId), eq(routingGroups.id, settings.fallbackGroupId)))
      )[0]
    : undefined;
  const matched = idx >= 0 ? rules[idx]! : null;
  const group = matched
    ? { id: matched.rule.groupId, name: matched.groupName }
    : fallback
      ? { id: fallback.id, name: fallback.name }
      : null;
  const ruleLabel = matched
    ? `${String(idx + 1).padStart(2, "0")} · ${describeConditions(matched.rule.conditions, matched.rule.match)}`
    : "fallback";
  if (!group)
    return {
      settings,
      ticket: t,
      group: null,
      ruleId: null,
      ruleLabel: "no rule matched",
      outcome: null,
      why: "no rule matched and there is no fallback group",
    };
  let outcome = await pickPerson(orgId, t, group.id, settings, opts.exclude);
  let finalGroup = group;
  if (!outcome.person && fallback && fallback.id !== group.id) {
    const first = outcome.why;
    outcome = await pickPerson(orgId, t, fallback.id, settings, opts.exclude);
    finalGroup = { id: fallback.id, name: fallback.name };
    if (outcome.person)
      outcome = { ...outcome, pick: `${first} in ${group.name} → ${fallback.name} · ${outcome.pick}` };
  }
  return {
    settings,
    ticket: t,
    group: finalGroup,
    matchedGroup: group,
    ruleId: matched?.rule.id ?? null,
    ruleLabel,
    outcome,
    why: outcome.person ? null : `${outcome.why} in ${finalGroup.name}`,
  };
}

const inflight = new Set<string>();

/** Route a ticket now. Returns what happened; never throws for "nobody available". */
export async function routeTicket(
  orgId: string,
  ticketId: string,
  trigger: RoutingTrigger,
  because: string,
): Promise<RouteResult> {
  if (inflight.has(ticketId)) return { assigned: false, reason: "already routing" };
  inflight.add(ticketId);
  try {
    const settings = await getRouting(orgId);
    if (!settings.enabled) return { assigned: false, reason: "routing is off" };
    const [current] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), eq(tickets.id, ticketId)));
    if (!current || !["open", "pending"].includes(current.status))
      return { assigned: false, reason: "ticket is closed" };
    const reassign = trigger === "reassign";
    if (current.assigneeId && !reassign) return { assigned: false, reason: "already assigned" };

    const d = await decide(orgId, ticketId, { exclude: reassign ? current.assigneeId : null });
    if (!d) return { assigned: false, reason: "ticket not found" };
    const trace = new Trace(orgId, ticketId);
    if (!d.outcome?.person) {
      await trace.event("route.unassigned", "system", `${because} · ${d.ruleLabel} · ${d.why}`, {
        trigger,
        rule: d.ruleLabel,
      });
      return { assigned: false, reason: d.why ?? "nobody available", ruleLabel: d.ruleLabel, groupName: d.group?.name };
    }
    const { person, pick } = d.outcome;
    const ai = (await getSettings(orgId)).ai;
    await updateTicket(orgId, ticketId, { assigneeId: person.userId }, { type: "ai", name: ai.agentName });
    const routing: TicketRouting = {
      auto: true,
      trigger,
      groupId: d.group!.id,
      groupName: d.group!.name,
      ruleId: d.ruleId,
      ruleLabel: d.ruleLabel,
      pick,
      because,
      at: new Date().toISOString(),
      reassignments: reassign ? (current.routing?.reassignments ?? 0) + 1 : 0,
    };
    await db.update(tickets).set({ routing, assignedAt: new Date() }).where(eq(tickets.id, ticketId));
    await db
      .insert(agentStatus)
      .values({ orgId, userId: person.userId, lastAssignedAt: new Date() })
      .onConflictDoUpdate({ target: [agentStatus.orgId, agentStatus.userId], set: { lastAssignedAt: new Date() } });
    const summary = reassign
      ? `reassigned → ${person.name} · ${because}`
      : `${d.ruleLabel === "fallback" ? "fallback" : `rule ${d.ruleLabel.slice(0, 2)}`} → ${d.group!.name} · ${person.name} · ${pick}`;
    await trace.event("route.assign", "system", summary, {
      trigger,
      because,
      group: d.group!.name,
      rule: d.ruleLabel,
      assignee: person.name,
      pick,
      previous: reassign ? current.assigneeId : undefined,
    });
    return {
      assigned: true,
      userId: person.userId,
      name: person.name,
      groupName: d.group!.name,
      ruleLabel: d.ruleLabel,
      pick,
    };
  } finally {
    inflight.delete(ticketId);
  }
}
