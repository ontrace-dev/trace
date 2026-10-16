import { and, arrayOverlaps, count, desc, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.ts";
import { customers, drafts, messages, ticketReads, tickets, user, views } from "../db/schema.ts";
import { markdownToPlain } from "../lib/text.ts";
import type { ViewFilters } from "../lib/types.ts";

export type SystemView = "inbox" | "unassigned" | "ai" | "mine" | "resolved" | "all";

export function systemViewFilters(view: SystemView, userId: string): ViewFilters {
  switch (view) {
    case "inbox":
      return { status: ["open", "pending"] };
    case "unassigned":
      return { status: ["open", "pending"], assignee: "none" };
    case "ai":
      return { status: ["open", "pending"], aiState: ["draft_ready", "escalated", "processing", "awaiting_approval"] };
    case "mine":
      return { status: ["open", "pending"], assignee: userId };
    case "resolved":
      return { status: ["resolved", "closed"] };
    default:
      return {};
  }
}

/**
 * Unread for this teammate: an active ticket whose latest public message is from the customer, and that
 * they haven't opened since that message arrived. Answered tickets aren't unread, even if never opened.
 */
export function unreadFor(userId: string) {
  return sql<boolean>`(
    ${tickets.lastCustomerMessageAt} is not null
    and ${tickets.status} in ('open', 'pending')
    and (select ${messages.authorType} from ${messages}
         where ${messages.ticketId} = ${tickets.id} and ${messages.kind} = 'message'
         order by ${messages.createdAt} desc limit 1) = 'customer'
    and not exists (select 1 from ${ticketReads}
         where ${ticketReads.ticketId} = ${tickets.id} and ${ticketReads.userId} = ${userId}
           and ${ticketReads.readAt} >= ${tickets.lastCustomerMessageAt})
  )`;
}

/** How many customer messages arrived since this teammate last opened the ticket and since anyone replied. */
export function unreadCountFor(userId: string) {
  return sql<number>`(
    select count(*)::int from ${messages} m
    where m.ticket_id = ${tickets.id} and m.kind = 'message' and m.author_type = 'customer'
      and m.created_at > coalesce((select ${ticketReads.readAt} from ${ticketReads}
            where ${ticketReads.ticketId} = ${tickets.id} and ${ticketReads.userId} = ${userId}), '-infinity')
      and m.created_at > coalesce((select max(r.created_at) from ${messages} r
            where r.ticket_id = ${tickets.id} and r.kind = 'message' and r.author_type in ('agent', 'ai')), '-infinity')
  )`;
}

export async function markRead(userId: string, ticketId: string) {
  await db
    .insert(ticketReads)
    .values({ userId, ticketId, readAt: new Date() })
    .onConflictDoUpdate({ target: [ticketReads.userId, ticketReads.ticketId], set: { readAt: new Date() } });
}

export function filtersToWhere(orgId: string, f: ViewFilters, userId: string): SQL | undefined {
  const conds: (SQL | undefined)[] = [eq(tickets.orgId, orgId)];
  if (f.status?.length) conds.push(inArray(tickets.status, f.status));
  if (f.priority?.length) conds.push(inArray(tickets.priority, f.priority));
  if (f.channel?.length) conds.push(inArray(tickets.channel, f.channel as never[]));
  if (f.aiState?.length) conds.push(inArray(tickets.aiState, f.aiState as never[]));
  if (f.tags?.length) conds.push(arrayOverlaps(tickets.tags, f.tags));
  if (f.assignee === "none") conds.push(isNull(tickets.assigneeId));
  else if (f.assignee === "me") conds.push(eq(tickets.assigneeId, userId));
  else if (f.assignee) conds.push(eq(tickets.assigneeId, f.assignee));
  if (f.q?.trim()) {
    const q = `%${f.q.trim()}%`;
    const num = Number(f.q.replace(/\D/g, ""));
    conds.push(
      or(
        ilike(tickets.subject, q),
        ilike(customers.email, q),
        ilike(customers.name, q),
        ilike(tickets.aiSummary, q),
        Number.isFinite(num) && num > 0 ? eq(tickets.number, num) : undefined,
      ),
    );
  }
  return and(...conds);
}

export async function listTickets(
  orgId: string,
  filters: ViewFilters,
  userId: string,
  opts: { limit?: number; before?: Date; unreadOnly?: boolean } = {},
) {
  const where = and(
    filtersToWhere(orgId, filters, userId),
    opts.before ? lt(tickets.lastMessageAt, opts.before) : undefined,
    opts.unreadOnly ? unreadFor(userId) : undefined,
  );
  const lastMessage = (col: typeof messages.body | typeof messages.authorType) =>
    db
      .select({ v: col })
      .from(messages)
      .where(and(eq(messages.ticketId, tickets.id), eq(messages.kind, "message")))
      .orderBy(desc(messages.createdAt))
      .limit(1);
  const rows = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      status: tickets.status,
      priority: tickets.priority,
      channel: tickets.channel,
      tags: tickets.tags,
      aiState: tickets.aiState,
      aiConfidence: tickets.aiConfidence,
      aiSummary: tickets.aiSummary,
      assigneeId: tickets.assigneeId,
      assigneeName: user.name,
      lastMessageAt: tickets.lastMessageAt,
      lastCustomerMessageAt: tickets.lastCustomerMessageAt,
      firstResponseDueAt: tickets.firstResponseDueAt,
      firstRespondedAt: tickets.firstRespondedAt,
      createdAt: tickets.createdAt,
      customer: {
        id: customers.id,
        name: customers.name,
        email: customers.email,
        avatarUrl: customers.avatarUrl,
      },
      preview: sql<string | null>`(${lastMessage(messages.body)})`,
      /** Who wrote the latest public message: whose turn it is at a glance. */
      lastAuthorType: sql<"customer" | "agent" | "ai" | "system" | null>`(${lastMessage(messages.authorType)})`,
      unread: unreadFor(userId),
      unreadCount: unreadCountFor(userId),
    })
    .from(tickets)
    .leftJoin(customers, eq(customers.id, tickets.customerId))
    .leftJoin(user, eq(user.id, tickets.assigneeId))
    .where(where)
    .orderBy(desc(tickets.lastMessageAt))
    .limit(opts.limit ?? 50);
  return rows.map((r) => ({ ...r, preview: r.preview ? markdownToPlain(r.preview).slice(0, 160) : null }));
}

export async function countTickets(orgId: string, filters: ViewFilters, userId: string) {
  const [r] = await db
    .select({ n: count() })
    .from(tickets)
    .leftJoin(customers, eq(customers.id, tickets.customerId))
    .where(filtersToWhere(orgId, filters, userId));
  return r?.n ?? 0;
}

export async function sidebarCounts(orgId: string, userId: string) {
  const sys: SystemView[] = ["inbox", "unassigned", "ai", "mine", "resolved"];
  const out: Record<string, number> = {};
  await Promise.all(
    sys.map(async (v) => {
      out[v] = await countTickets(orgId, systemViewFilters(v, userId), userId);
    }),
  );
  const [unread] = await db
    .select({ n: count() })
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), unreadFor(userId)));
  out.unread = unread?.n ?? 0;
  const vs = await db.select().from(views).where(eq(views.orgId, orgId));
  await Promise.all(
    vs.map(async (v) => {
      out[v.id] = await countTickets(orgId, v.filters, userId);
    }),
  );
  return out;
}

export async function pendingDraftFor(ticketId: string) {
  const [d] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.ticketId, ticketId), eq(drafts.status, "pending")))
    .orderBy(desc(drafts.createdAt))
    .limit(1);
  return d ?? null;
}
