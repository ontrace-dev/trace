import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { actionRuns, customers, drafts, messages, spans, tickets, user, views } from "../db/schema.ts";
import type { ViewFilters } from "../lib/types.ts";
import { filtersToWhere, type SystemView, systemViewFilters } from "./queries.ts";

/**
 * The landing page: what needs a human now, what's spiking, what the AI did, and how every queue looks.
 * Everything is "last 24 hours" rather than "today" so it's the same for every timezone.
 */

const DAY = 86_400_000;
const SOON_MS = 60 * 60_000;
const ACTIVE = ["open", "pending"] as const;

// ---------------------------------------------------------------- queues (views overview)

export interface QueueStats {
  total: number;
  waiting: number;
  unassigned: number;
  urgent: number;
  slaBreached: number;
  slaSoon: number;
  drafts: number;
  approvals: number;
  escalated: number;
  oldestWaitingAt: string | null;
  /** New tickets per day for the last 7 days, oldest first. */
  trend: number[];
}

async function queueStats(orgId: string, filters: ViewFilters, userId: string): Promise<QueueStats> {
  const where = filtersToWhere(orgId, filters, userId);
  const active = sql`${tickets.status} in ('open','pending')`;
  const [[agg], perDay] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)`.mapWith(Number),
        waiting: sql<number>`count(*) filter (where ${tickets.status} = 'open')`.mapWith(Number),
        unassigned: sql<number>`count(*) filter (where ${active} and ${tickets.assigneeId} is null)`.mapWith(Number),
        urgent: sql<number>`count(*) filter (where ${active} and ${tickets.priority} in ('high','urgent'))`.mapWith(
          Number,
        ),
        slaBreached:
          sql<number>`count(*) filter (where ${tickets.status} = 'open' and ${tickets.firstRespondedAt} is null and ${tickets.firstResponseDueAt} < now())`.mapWith(
            Number,
          ),
        slaSoon:
          sql<number>`count(*) filter (where ${tickets.status} = 'open' and ${tickets.firstRespondedAt} is null and ${tickets.firstResponseDueAt} between now() and now() + interval '1 hour')`.mapWith(
            Number,
          ),
        drafts: sql<number>`count(*) filter (where ${active} and ${tickets.aiState} = 'draft_ready')`.mapWith(Number),
        approvals: sql<number>`count(*) filter (where ${active} and ${tickets.aiState} = 'awaiting_approval')`.mapWith(
          Number,
        ),
        escalated: sql<number>`count(*) filter (where ${active} and ${tickets.aiState} = 'escalated')`.mapWith(Number),
        oldestWaitingAt: sql<
          string | null
        >`min(coalesce(${tickets.lastCustomerMessageAt}, ${tickets.createdAt})) filter (where ${tickets.status} = 'open')`,
      })
      .from(tickets)
      .leftJoin(customers, eq(customers.id, tickets.customerId))
      .where(where),
    db
      .select({
        d: sql<number>`floor(extract(epoch from (now() - ${tickets.createdAt})) / 86400)`.mapWith(Number),
        n: sql<number>`count(*)`.mapWith(Number),
      })
      .from(tickets)
      .leftJoin(customers, eq(customers.id, tickets.customerId))
      .where(and(where, gte(tickets.createdAt, new Date(Date.now() - 7 * DAY))))
      .groupBy(sql`1`),
  ]);
  const trend = Array.from({ length: 7 }, () => 0);
  for (const r of perDay) if (r.d >= 0 && r.d < 7) trend[6 - r.d]! += r.n;
  return {
    ...agg!,
    oldestWaitingAt: agg!.oldestWaitingAt ? new Date(agg!.oldestWaitingAt).toISOString() : null,
    trend,
  };
}

export interface QueueRow {
  id: string;
  name: string;
  icon: string;
  system: boolean;
  filters: ViewFilters;
  stats: QueueStats;
}

const SYSTEM_QUEUES: { id: SystemView; name: string; icon: string }[] = [
  { id: "inbox", name: "Inbox", icon: "inbox" },
  { id: "ai", name: "AI queue", icon: "sparkles" },
  { id: "unassigned", name: "Unassigned", icon: "user-x" },
  { id: "mine", name: "Assigned to me", icon: "user" },
];

export async function queuesOverview(orgId: string, userId: string): Promise<QueueRow[]> {
  const custom = await db.select().from(views).where(eq(views.orgId, orgId)).orderBy(views.position, views.createdAt);
  const all = [
    ...SYSTEM_QUEUES.map((q) => ({ ...q, system: true, filters: systemViewFilters(q.id, userId) })),
    ...custom.map((v) => ({ id: v.id, name: v.name, icon: v.icon, system: false, filters: v.filters })),
  ];
  return Promise.all(all.map(async (q) => ({ ...q, stats: await queueStats(orgId, q.filters, userId) })));
}

// ---------------------------------------------------------------- needs you

export type NeedKind =
  | "approval"
  | "sla_breached"
  | "escalated"
  | "ai_error"
  | "sla_soon"
  | "mine_waiting"
  | "urgent_unassigned"
  | "draft_ready";

const WEIGHT: Record<NeedKind, number> = {
  approval: 100,
  sla_breached: 90,
  escalated: 80,
  ai_error: 75,
  sla_soon: 70,
  mine_waiting: 60,
  urgent_unassigned: 50,
  draft_ready: 40,
};

export interface NeedItem {
  ticketId: string;
  number: number;
  subject: string;
  priority: string;
  channel: string;
  status: string;
  aiSummary: string | null;
  aiConfidence: number | null;
  aiIntent: string | null;
  aiSentiment: string | null;
  /** When the AI agent first worked the ticket (its first AI span). */
  aiAt: string | null;
  /** The pending AI draft, if any. */
  draft: { confidence: number; sources: number } | null;
  assigneeName: string | null;
  customerName: string | null;
  customerEmail: string | null;
  firstResponseDueAt: string | null;
  waitingSince: string;
  kinds: NeedKind[];
  approval: { runId: string; title: string; reason: string | null; requestedAt: string } | null;
  score: number;
}

async function needsYou(orgId: string, userId: string) {
  const soon = new Date(Date.now() + SOON_MS);
  const [rows, runs] = await Promise.all([
    db
      .select({
        id: tickets.id,
        number: tickets.number,
        subject: tickets.subject,
        priority: tickets.priority,
        channel: tickets.channel,
        status: tickets.status,
        aiState: tickets.aiState,
        aiSummary: tickets.aiSummary,
        aiConfidence: tickets.aiConfidence,
        aiIntent: tickets.aiIntent,
        aiSentiment: tickets.aiSentiment,
        aiAt: sql<
          string | null
        >`(select min(${spans.startedAt}) from ${spans} where ${spans.ticketId} = ${tickets.id} and ${spans.kind} = 'ai')`,
        draft: sql<{
          confidence: number;
          sources: number;
        } | null>`(select json_build_object('confidence', ${drafts.confidence}, 'sources', jsonb_array_length(${drafts.sources})) from ${drafts} where ${drafts.ticketId} = ${tickets.id} and ${drafts.status} = 'pending' order by ${drafts.createdAt} desc limit 1)`,
        assigneeId: tickets.assigneeId,
        assigneeName: user.name,
        customerName: customers.name,
        customerEmail: customers.email,
        firstResponseDueAt: tickets.firstResponseDueAt,
        firstRespondedAt: tickets.firstRespondedAt,
        lastCustomerMessageAt: tickets.lastCustomerMessageAt,
        createdAt: tickets.createdAt,
      })
      .from(tickets)
      .leftJoin(customers, eq(customers.id, tickets.customerId))
      .leftJoin(user, eq(user.id, tickets.assigneeId))
      .where(
        and(
          eq(tickets.orgId, orgId),
          inArray(tickets.status, [...ACTIVE]),
          or(
            inArray(tickets.aiState, ["escalated", "awaiting_approval", "draft_ready", "error"]),
            and(eq(tickets.status, "open"), isNull(tickets.firstRespondedAt), lt(tickets.firstResponseDueAt, soon)),
            and(eq(tickets.status, "open"), eq(tickets.assigneeId, userId)),
            and(isNull(tickets.assigneeId), inArray(tickets.priority, ["high", "urgent"])),
          ),
        ),
      )
      .orderBy(desc(tickets.lastMessageAt))
      .limit(300),
    db
      .select({
        id: actionRuns.id,
        ticketId: actionRuns.ticketId,
        title: actionRuns.actionTitle,
        reason: actionRuns.reason,
        createdAt: actionRuns.createdAt,
      })
      .from(actionRuns)
      .where(and(eq(actionRuns.orgId, orgId), eq(actionRuns.status, "pending_approval")))
      .orderBy(actionRuns.createdAt),
  ]);
  const approvals = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (r.ticketId && !approvals.has(r.ticketId)) approvals.set(r.ticketId, r);

  const now = Date.now();
  const items: NeedItem[] = [];
  for (const t of rows) {
    const kinds: NeedKind[] = [];
    const due = t.firstResponseDueAt?.getTime();
    const unanswered = t.status === "open" && !t.firstRespondedAt && due != null;
    if (approvals.has(t.id) || t.aiState === "awaiting_approval") kinds.push("approval");
    if (unanswered && due! < now) kinds.push("sla_breached");
    if (t.aiState === "escalated") kinds.push("escalated");
    if (t.aiState === "error") kinds.push("ai_error");
    if (unanswered && due! >= now && due! < now + SOON_MS) kinds.push("sla_soon");
    if (t.assigneeId === userId && t.status === "open") kinds.push("mine_waiting");
    if (!t.assigneeId && (t.priority === "high" || t.priority === "urgent")) kinds.push("urgent_unassigned");
    if (t.aiState === "draft_ready") kinds.push("draft_ready");
    if (!kinds.length) continue;
    kinds.sort((a, b) => WEIGHT[b] - WEIGHT[a]);
    const waitingSince = t.lastCustomerMessageAt ?? t.createdAt;
    const ageHours = (now - waitingSince.getTime()) / 3_600_000;
    const run = approvals.get(t.id);
    items.push({
      ticketId: t.id,
      number: t.number,
      subject: t.subject,
      priority: t.priority,
      channel: t.channel,
      status: t.status,
      aiSummary: t.aiSummary,
      aiConfidence: t.aiConfidence,
      assigneeName: t.assigneeName,
      customerName: t.customerName,
      customerEmail: t.customerEmail,
      firstResponseDueAt: t.firstResponseDueAt?.toISOString() ?? null,
      waitingSince: waitingSince.toISOString(),
      kinds,
      aiIntent: t.aiIntent,
      aiSentiment: t.aiSentiment,
      aiAt: t.aiAt ? new Date(t.aiAt).toISOString() : null,
      draft: t.draft,
      approval: run
        ? { runId: run.id, title: run.title, reason: run.reason, requestedAt: run.createdAt.toISOString() }
        : null,
      // Reason first; then priority, then how long the customer has waited (capped so old tickets don't drown news).
      score:
        WEIGHT[kinds[0]!] + (t.priority === "urgent" ? 15 : t.priority === "high" ? 8 : 0) + Math.min(ageHours, 48) / 8,
    });
  }
  items.sort((a, b) => b.score - a.score);
  const counts = Object.fromEntries(Object.keys(WEIGHT).map((k) => [k, 0])) as Record<NeedKind, number>;
  for (const i of items) for (const k of i.kinds) counts[k]++;
  return { items: items.slice(0, 40), total: items.length, counts };
}

// ---------------------------------------------------------------- what's hot

export interface HotTopic {
  kind: "intent" | "tag";
  key: string;
  recent: number;
  /** Average per day over the 7 days before the last 24 hours. */
  baseline: number;
  /** recent ÷ baseline, with a floor on the baseline so brand-new topics don't read as ∞. */
  lift: number;
  daily: number[];
  open: number;
  samples: { number: number; subject: string }[];
}

async function hotTopics(orgId: string): Promise<HotTopic[]> {
  const since = new Date(Date.now() - 8 * DAY);
  const rows = await db
    .select({
      number: tickets.number,
      subject: tickets.subject,
      status: tickets.status,
      intent: tickets.aiIntent,
      tags: tickets.tags,
      createdAt: tickets.createdAt,
    })
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), gte(tickets.createdAt, since)))
    .orderBy(desc(tickets.createdAt));
  const now = Date.now();
  const buckets = new Map<string, { kind: HotTopic["kind"]; key: string; rows: typeof rows }>();
  for (const r of rows) {
    const keys: [HotTopic["kind"], string][] = [
      ...(r.intent ? [["intent", r.intent] as [HotTopic["kind"], string]] : []),
      ...r.tags.map((t) => ["tag", t] as [HotTopic["kind"], string]),
    ];
    for (const [kind, key] of keys) {
      const k = `${kind}:${key}`;
      if (!buckets.has(k)) buckets.set(k, { kind, key, rows: [] });
      buckets.get(k)!.rows.push(r);
    }
  }
  const topics: HotTopic[] = [];
  const recentNumbers = new Map<string, number[]>();
  for (const b of buckets.values()) {
    const daily = Array.from({ length: 8 }, () => 0);
    for (const r of b.rows) {
      const d = Math.floor((now - r.createdAt.getTime()) / DAY);
      if (d >= 0 && d < 8) daily[7 - d]!++;
    }
    const recent = daily[7]!;
    if (recent < 2) continue;
    const baseline = daily.slice(0, 7).reduce((a, n) => a + n, 0) / 7;
    const recentRows = b.rows.filter((r) => now - r.createdAt.getTime() < DAY);
    recentNumbers.set(
      `${b.kind}:${b.key}`,
      recentRows.map((r) => r.number),
    );
    topics.push({
      kind: b.kind,
      key: b.key,
      recent,
      baseline: Math.round(baseline * 10) / 10,
      lift: Math.round((recent / Math.max(baseline, 0.5)) * 10) / 10,
      daily,
      open: recentRows.filter((r) => r.status === "open" || r.status === "pending").length,
      samples: recentRows.slice(0, 3).map((r) => ({ number: r.number, subject: r.subject })),
    });
  }
  // An intent and a tag often describe the same wave (billing_issue / #billing, login_issue / #auth):
  // skip a topic when most of its tickets are already covered by a stronger one.
  topics.sort((a, b) => b.recent - b.baseline - (a.recent - a.baseline) || b.recent - a.recent);
  const out: (HotTopic & { members: Set<number> })[] = [];
  for (const t of topics) {
    const members = new Set(recentNumbers.get(`${t.kind}:${t.key}`));
    const covered = out.some((o) => [...members].filter((n) => o.members.has(n)).length >= members.size * 0.66);
    if (covered) continue;
    out.push({ ...t, members });
    if (out.length === 4) break;
  }
  return out.map(({ members: _m, ...t }) => t);
}

// ---------------------------------------------------------------- pulse & AI

async function pulse(orgId: string) {
  const day = new Date(Date.now() - DAY);
  // Raw fragments take ISO strings (the driver binds Date objects only through typed operators).
  const dayIso = day.toISOString();
  const twoDaysIso = new Date(Date.now() - 2 * DAY).toISOString();
  const [[t], [ai], [d], [frt]] = await Promise.all([
    db
      .select({
        active: sql<number>`count(*) filter (where ${tickets.status} in ('open','pending'))`.mapWith(Number),
        waiting: sql<number>`count(*) filter (where ${tickets.status} = 'open')`.mapWith(Number),
        pending: sql<number>`count(*) filter (where ${tickets.status} = 'pending')`.mapWith(Number),
        new24h: sql<number>`count(*) filter (where ${tickets.createdAt} >= ${dayIso})`.mapWith(Number),
        newPrev24h:
          sql<number>`count(*) filter (where ${tickets.createdAt} >= ${twoDaysIso} and ${tickets.createdAt} < ${dayIso})`.mapWith(
            Number,
          ),
        resolved24h: sql<number>`count(*) filter (where ${tickets.resolvedAt} >= ${dayIso})`.mapWith(Number),
        resolvedByAi24h:
          sql<number>`count(*) filter (where ${tickets.resolvedAt} >= ${dayIso} and ${tickets.aiState} = 'auto_replied')`.mapWith(
            Number,
          ),
        slaBreached:
          sql<number>`count(*) filter (where ${tickets.status} = 'open' and ${tickets.firstRespondedAt} is null and ${tickets.firstResponseDueAt} < now())`.mapWith(
            Number,
          ),
        escalated:
          sql<number>`count(*) filter (where ${tickets.status} in ('open','pending') and ${tickets.aiState} = 'escalated')`.mapWith(
            Number,
          ),
      })
      .from(tickets)
      .where(eq(tickets.orgId, orgId)),
    db
      .select({
        worked: sql<number>`count(distinct ${spans.ticketId})`.mapWith(Number),
      })
      .from(spans)
      .where(and(eq(spans.orgId, orgId), eq(spans.kind, "ai"), gte(spans.startedAt, day))),
    db
      .select({
        drafted: sql<number>`count(*)`.mapWith(Number),
        sent: sql<number>`count(*) filter (where ${drafts.status} = 'sent')`.mapWith(Number),
        avgConfidence: sql<number | null>`avg(${drafts.confidence})`.mapWith((v) => (v == null ? null : Number(v))),
        autoReplies:
          sql<number>`(select count(*) from ${messages} where ${messages.orgId} = ${orgId} and ${messages.authorType} = 'ai' and ${messages.kind} = 'message' and ${messages.createdAt} >= ${dayIso})`.mapWith(
            Number,
          ),
        approvals:
          sql<number>`(select count(*) from ${actionRuns} where ${actionRuns.orgId} = ${orgId} and ${actionRuns.status} = 'pending_approval')`.mapWith(
            Number,
          ),
      })
      .from(drafts)
      .where(and(eq(drafts.orgId, orgId), gte(drafts.createdAt, day))),
    db
      .select({
        median: sql<
          number | null
        >`percentile_cont(0.5) within group (order by extract(epoch from (${tickets.firstRespondedAt} - ${tickets.createdAt})))`,
      })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), gte(tickets.firstRespondedAt, day))),
  ]);
  return {
    tickets: t!,
    ai: { worked: ai?.worked ?? 0, ...d!, escalated: t!.escalated },
    medianFirstResponseSeconds: frt?.median == null ? null : Number(frt.median),
  };
}

export async function homeData(orgId: string, userId: string) {
  const [needs, hot, p, queues] = await Promise.all([
    needsYou(orgId, userId),
    hotTopics(orgId),
    pulse(orgId),
    queuesOverview(orgId, userId),
  ]);
  return { needs, hot, pulse: p, queues };
}
