import { and, desc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { articles, customers, messages, tickets } from "../../db/schema.ts";
import { truncate } from "../../lib/text.ts";

const STOP = new Set(
  "a an and are as at be but by can do for from has have hi hello how i if in is it its me my no not of on or our please so that the their them then there they this to us was we were what when where which who why will with you your yes thanks thank hey".split(
    " ",
  ),
);

/** Extract meaningful keywords for full-text search from free text. */
export function keywords(text: string, max = 8) {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s#-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, max);
}

const docExpr = sql`to_tsvector('simple', coalesce(${articles.title}, '') || ' ' || coalesce(${articles.body}, ''))`;

/** Crude English stemming so "charged" matches "charge", "refunds" matches "refund". */
export function stem(w: string) {
  if (w.length <= 4) return w;
  return w.replace(/(ing|ed|es|s)$/, "");
}

export async function searchArticles(orgId: string, query: string, limit = 5, includeDrafts = false) {
  const terms = keywords(query, 10);
  if (!terms.length) return [];
  const tsq = terms
    .map((t) => t.replace(/[':&|!()]/g, ""))
    .filter(Boolean)
    .join(" | ");
  const rank = sql<number>`ts_rank(${docExpr}, to_tsquery('simple', ${tsq}))`;
  const rows = await db
    .select({
      id: articles.id,
      title: articles.title,
      body: articles.body,
      status: articles.status,
      tags: articles.tags,
      rank,
    })
    .from(articles)
    .where(
      and(
        eq(articles.orgId, orgId),
        includeDrafts ? undefined : eq(articles.status, "published"),
        sql`${docExpr} @@ to_tsquery('simple', ${tsq})`,
      ),
    )
    .orderBy(desc(rank))
    .limit(limit);
  return rows;
}

export async function searchTickets(
  orgId: string,
  query: string,
  opts: { limit?: number; excludeTicketId?: string; status?: ("open" | "pending" | "resolved" | "closed")[] } = {},
) {
  const terms = keywords(query, 8).map(stem);
  if (!terms.length) return [];
  const likeAny = or(
    ...terms.flatMap((t) => [
      ilike(tickets.subject, `%${t}%`),
      ilike(tickets.aiSummary, `%${t}%`),
      sql`exists (select 1 from ${messages} m where m.ticket_id = ${tickets.id} and m.kind = 'message' and m.body ilike ${`%${t}%`})`,
    ]),
  );
  const rows = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      status: tickets.status,
      tags: tickets.tags,
      aiSummary: tickets.aiSummary,
      createdAt: tickets.createdAt,
      customerName: customers.name,
    })
    .from(tickets)
    .leftJoin(customers, eq(customers.id, tickets.customerId))
    .where(
      and(
        eq(tickets.orgId, orgId),
        opts.excludeTicketId ? ne(tickets.id, opts.excludeTicketId) : undefined,
        opts.status ? inArray(tickets.status, opts.status) : undefined,
        likeAny,
      ),
    )
    .orderBy(desc(tickets.lastMessageAt))
    .limit((opts.limit ?? 5) * 4);
  // Score by number of matching terms so the best matches come first.
  return rows
    .map((r) => {
      const hay = `${r.subject} ${r.aiSummary ?? ""}`.toLowerCase();
      // Subject/summary hits rank above body-only hits.
      return { ...r, score: terms.filter((t) => hay.includes(t)).length };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 5);
}

/** The last public agent/AI reply on a ticket — its "resolution" for retrieval purposes. */
export async function ticketResolution(ticketId: string) {
  const [m] = await db
    .select({ body: messages.body })
    .from(messages)
    .where(
      and(eq(messages.ticketId, ticketId), eq(messages.kind, "message"), inArray(messages.authorType, ["agent", "ai"])),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return m ? truncate(m.body, 600) : null;
}

export async function bumpCitations(ids: string[]) {
  if (!ids.length) return;
  await db
    .update(articles)
    .set({ citations: sql`${articles.citations} + 1` })
    .where(inArray(articles.id, ids));
}
