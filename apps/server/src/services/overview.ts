import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { customers, drafts, messages, tickets } from "../db/schema.ts";
import { markdownToPlain } from "../lib/text.ts";
import { listTickets, unreadFor } from "./queries.ts";

/**
 * The Home page: a handful of plain counts, the open tickets in the order you should look at them,
 * and a feed of what just happened (who wrote, who replied, what the AI did).
 */

const DAY = 86_400_000;

export interface ActivityItem {
  id: string;
  at: string;
  actor: "customer" | "team" | "ai" | "system";
  /** "Anna Møller", "Sam Kim", "AI" */
  who: string;
  /** "opened a ticket", "replied", "drafted a reply" … */
  what: string;
  number: number;
  subject: string;
  preview: string | null;
}

async function stats(orgId: string, userId: string) {
  const since = new Date(Date.now() - DAY);
  const [[t], [u]] = await Promise.all([
    db
      .select({
        open: sql<number>`count(*) filter (where ${tickets.status} = 'open')`.mapWith(Number),
        pending: sql<number>`count(*) filter (where ${tickets.status} = 'pending')`.mapWith(Number),
        mine: sql<number>`count(*) filter (where ${tickets.status} in ('open','pending') and ${tickets.assigneeId} = ${userId})`.mapWith(
          Number,
        ),
        unassigned:
          sql<number>`count(*) filter (where ${tickets.status} in ('open','pending') and ${tickets.assigneeId} is null)`.mapWith(
            Number,
          ),
        overdue:
          sql<number>`count(*) filter (where ${tickets.status} = 'open' and ${tickets.firstRespondedAt} is null and ${tickets.firstResponseDueAt} < now())`.mapWith(
            Number,
          ),
        drafts:
          sql<number>`count(*) filter (where ${tickets.status} in ('open','pending') and ${tickets.aiState} = 'draft_ready')`.mapWith(
            Number,
          ),
        solved: sql<number>`count(*) filter (where ${tickets.resolvedAt} >= ${since.toISOString()})`.mapWith(Number),
        solvedByAi:
          sql<number>`count(*) filter (where ${tickets.resolvedAt} >= ${since.toISOString()} and ${tickets.aiState} = 'auto_replied')`.mapWith(
            Number,
          ),
      })
      .from(tickets)
      .where(eq(tickets.orgId, orgId)),
    db
      .select({ n: count() })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), unreadFor(userId))),
  ]);
  return { ...t!, unread: u?.n ?? 0 };
}

async function activity(orgId: string): Promise<ActivityItem[]> {
  const [msgs, ds] = await Promise.all([
    db
      .select({
        id: messages.id,
        kind: messages.kind,
        authorType: messages.authorType,
        authorName: messages.authorName,
        body: messages.body,
        meta: messages.meta,
        createdAt: messages.createdAt,
        number: tickets.number,
        subject: tickets.subject,
        customer: sql<string | null>`coalesce(${customers.name}, ${customers.email})`,
        opening: sql<boolean>`${messages.createdAt} = (select min(f.created_at) from ${messages} f where f.ticket_id = ${tickets.id} and f.kind = 'message')`,
      })
      .from(messages)
      .innerJoin(tickets, eq(tickets.id, messages.ticketId))
      .leftJoin(customers, eq(customers.id, tickets.customerId))
      .where(eq(messages.orgId, orgId))
      .orderBy(desc(messages.createdAt))
      .limit(30),
    db
      .select({
        id: drafts.id,
        createdAt: drafts.createdAt,
        confidence: drafts.confidence,
        number: tickets.number,
        subject: tickets.subject,
      })
      .from(drafts)
      .innerJoin(tickets, eq(tickets.id, drafts.ticketId))
      // Replaced or thrown-away drafts aren't news.
      .where(and(eq(drafts.orgId, orgId), inArray(drafts.status, ["pending", "sent"])))
      .orderBy(desc(drafts.createdAt))
      .limit(10),
  ]);
  const items: ActivityItem[] = msgs.map((m) => {
    const base = { id: m.id, at: m.createdAt.toISOString(), number: m.number, subject: m.subject };
    const preview = m.kind === "event" ? null : markdownToPlain(m.body).slice(0, 140) || null;
    if (m.kind === "event") return { ...base, actor: "system", who: "", what: m.body, preview: null };
    if (m.authorType === "customer")
      return {
        ...base,
        actor: "customer",
        who: m.customer ?? m.authorName ?? "A customer",
        what: m.opening ? "opened a ticket" : "replied",
        preview,
      };
    if (m.authorType === "ai")
      return {
        ...base,
        actor: "ai",
        who: "AI",
        what: m.meta.action ? "ran an action" : m.kind === "note" ? "added a note" : "replied to the customer",
        preview,
      };
    return {
      ...base,
      actor: m.authorType === "system" ? "system" : "team",
      who: m.authorName ?? "Someone",
      what: m.kind === "note" ? "added an internal note" : "replied",
      preview,
    };
  });
  const seen = new Set<number>();
  for (const d of ds) {
    if (seen.has(d.number)) continue;
    seen.add(d.number);
    items.push({
      id: d.id,
      at: d.createdAt.toISOString(),
      actor: "ai",
      who: "AI",
      what: `drafted a reply (${Math.round(d.confidence * 100)}% confident)`,
      number: d.number,
      subject: d.subject,
      preview: null,
    });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 25);
}

/** Open and pending tickets, unread first, then customers who have waited longest. */
async function queue(orgId: string, userId: string) {
  const rows = await listTickets(orgId, { status: ["open", "pending"] }, userId, { limit: 100 });
  const waitingSince = (t: (typeof rows)[number]) => new Date(t.lastCustomerMessageAt ?? t.createdAt).getTime();
  return rows
    .sort(
      (a, b) =>
        Number(b.unread) - Number(a.unread) ||
        Number(a.status === "pending") - Number(b.status === "pending") ||
        waitingSince(a) - waitingSince(b),
    )
    .slice(0, 15);
}

export async function overview(orgId: string, userId: string) {
  const [s, a, q] = await Promise.all([stats(orgId, userId), activity(orgId), queue(orgId, userId)]);
  return { stats: s, activity: a, tickets: q };
}
