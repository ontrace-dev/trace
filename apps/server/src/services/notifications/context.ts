import { and, count, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { tickets } from "../../db/schema.ts";
import type { Customer, Ticket } from "../tickets.ts";

/** Account context shown next to every ticket in chat: who the customer is and their history. */
export interface AccountContext {
  /** Primitive customer attributes (plan, MRR, NPS, region, …), most useful first. */
  attributes: [string, string][];
  openTickets: number;
  lifetimeTickets: number;
  recent: { number: number; subject: string; status: string; createdAt: Date }[];
  customerSince: Date | null;
}

const PREFERRED = ["plan", "mrr", "arr", "tier", "nps", "region", "seats", "company"];

export async function loadAccountContext(ticket: Ticket, customer?: Customer | null): Promise<AccountContext | null> {
  if (!customer?.id) return null;
  const [[stats], recent] = await Promise.all([
    db
      .select({
        lifetime: count(),
        open: db.$count(
          tickets,
          and(eq(tickets.customerId, customer.id), inArray(tickets.status, ["open", "pending"])),
        ),
      })
      .from(tickets)
      .where(eq(tickets.customerId, customer.id)),
    db
      .select({
        number: tickets.number,
        subject: tickets.subject,
        status: tickets.status,
        createdAt: tickets.createdAt,
      })
      .from(tickets)
      .where(and(eq(tickets.customerId, customer.id), ne(tickets.id, ticket.id)))
      .orderBy(desc(tickets.createdAt))
      .limit(3),
  ]);
  const attrs = Object.entries(customer.attributes ?? {})
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v) && String(v).trim() !== "")
    .map(([k, v]) => [k.replace(/_/g, " "), String(v)] as [string, string])
    .sort(([a], [b]) => {
      const ia = PREFERRED.indexOf(a.toLowerCase());
      const ib = PREFERRED.indexOf(b.toLowerCase());
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    })
    .slice(0, 6);
  if (customer.company && !attrs.some(([k]) => k.toLowerCase() === "company"))
    attrs.push(["company", customer.company]);
  return {
    attributes: attrs,
    openTickets: Number(stats?.open ?? 0),
    lifetimeTickets: Number(stats?.lifetime ?? 0),
    recent,
    customerSince: customer.createdAt ?? null,
  };
}

/** "3d", "5mo" — compact ages for chat messages. */
export function age(d: Date) {
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / (86400 * 30))}mo`;
}

/** One-line account summary: "plan scale · mrr €2,480 · nps 94 · 2 open / 5 tickets". */
export function accountLine(a: AccountContext) {
  return [
    ...a.attributes.map(([k, v]) => `${k} ${v}`),
    `${a.openTickets} open / ${a.lifetimeTickets} ticket${a.lifetimeTickets === 1 ? "" : "s"}`,
  ].join(" · ");
}
