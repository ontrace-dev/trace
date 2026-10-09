import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { customers, messages, ticketFields, tickets } from "../db/schema.ts";
import { bus } from "../lib/bus.ts";
import { id } from "../lib/ids.ts";
import type { FieldOption, TicketFieldValue } from "../lib/types.ts";

/**
 * Ticket fields: the classification ("type") plus custom properties. A field's value comes from trace
 * (filled during triage), from the customer record (read live), or from people. Values people set are
 * never overwritten by trace; when someone changes trace's value it counts as a correction, which
 * feeds the next classification as an example and the accuracy number in settings.
 */

export type FieldDef = typeof ticketFields.$inferSelect;
type Value = TicketFieldValue["value"];

export const DEFAULT_TYPES: FieldOption[] = [
  { value: "bug", color: "danger" },
  { value: "feature request", color: "info" },
  { value: "question", color: "neutral" },
  { value: "incident", color: "warn" },
  { value: "billing", color: "ok" },
  { value: "how-to", color: "neutral" },
];

const TYPE_FIELD = {
  key: "type",
  label: "Type",
  type: "select" as const,
  options: DEFAULT_TYPES,
  source: "ai" as const,
  aiInstruction:
    "What kind of ticket this is for the support team. bug = something is broken or behaves wrongly; feature request = asks for something the product doesn't do; incident = an outage or problem affecting many customers; billing = invoices, charges, plans; how-to = asks how to do something the product supports; question = anything else.",
  shown: "header" as const,
  system: true,
  position: 0,
};

/** All field definitions of a workspace, creating the built-in classification on first use. */
export async function getFields(orgId: string): Promise<FieldDef[]> {
  const rows = await db
    .select()
    .from(ticketFields)
    .where(eq(ticketFields.orgId, orgId))
    .orderBy(asc(ticketFields.position), asc(ticketFields.createdAt));
  if (rows.some((r) => r.key === "type")) return rows;
  await db
    .insert(ticketFields)
    .values({ id: id("fld"), orgId, ...TYPE_FIELD })
    .onConflictDoNothing();
  return getFields(orgId);
}

export interface ResolvedField {
  key: string;
  label: string;
  type: FieldDef["type"];
  options: FieldOption[];
  shown: FieldDef["shown"];
  source: FieldDef["source"];
  requiredToResolve: boolean;
  system: boolean;
  value: Value;
  /** Where the current value came from. */
  setBy: "ai" | "human" | "customer" | null;
  corrected: boolean;
}

const empty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && !v.length);

/** Field definitions with this ticket's values (customer-record fields read live). */
export function resolveFields(
  defs: FieldDef[],
  values: Record<string, TicketFieldValue>,
  customerAttrs: Record<string, unknown> | null | undefined,
): ResolvedField[] {
  return defs.map((f) => {
    const stored = values[f.key];
    const fromCustomer =
      f.source === "customer" && f.customerAttribute ? customerAttrs?.[f.customerAttribute] : undefined;
    const live = !empty(fromCustomer) && (typeof fromCustomer !== "object" || Array.isArray(fromCustomer));
    return {
      key: f.key,
      label: f.label,
      type: f.type,
      options: f.options,
      shown: f.shown,
      source: f.source,
      requiredToResolve: f.requiredToResolve,
      system: f.system,
      // A value someone typed wins over the customer record; the record wins over trace's guess.
      value: stored?.source === "human" ? stored.value : live ? (fromCustomer as Value) : (stored?.value ?? null),
      setBy: stored?.source === "human" ? "human" : live ? "customer" : (stored?.source ?? null),
      corrected: !!stored?.corrected,
    };
  });
}

/** Coerce a value to a field's type; throws a readable error for invalid input. */
export function coerce(f: Pick<FieldDef, "type" | "options" | "label">, v: unknown): Value {
  if (empty(v)) return null;
  const opts = f.options.map((o) => o.value);
  const pick = (x: unknown) => {
    const s = String(x).trim().toLowerCase().replace(/_/g, " ");
    const hit = opts.find((o) => o.toLowerCase() === s);
    if (!hit) throw new Error(`“${String(x)}” is not an option of ${f.label}`);
    return hit;
  };
  switch (f.type) {
    case "number": {
      const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.-]/g, ""));
      if (!Number.isFinite(n)) throw new Error(`${f.label} must be a number`);
      return n;
    }
    case "checkbox":
      return v === true || v === "true" || v === 1 || v === "yes";
    case "select":
      return pick(Array.isArray(v) ? v[0] : v);
    case "multiselect":
      return [...new Set((Array.isArray(v) ? v : String(v).split(",")).map(pick))];
    case "url": {
      const s = String(v).trim();
      if (!/^https?:\/\//i.test(s)) throw new Error(`${f.label} must be a link (https://…)`);
      return s.slice(0, 500);
    }
    default:
      return String(v).trim().slice(0, 500);
  }
}

const show = (v: Value) => (Array.isArray(v) ? v.join(", ") : v == null ? "empty" : String(v));

/** A person sets a field. Records an event on the ticket; marks corrections of trace's values. */
export async function setFieldValue(
  orgId: string,
  ticketId: string,
  key: string,
  raw: unknown,
  actor: { id?: string | null; name?: string | null },
) {
  const defs = await getFields(orgId);
  const f = defs.find((d) => d.key === key);
  if (!f) throw new Error(`Unknown field ${key}`);
  const value = coerce(f, raw);
  const [t] = await db
    .select({ fields: tickets.fields })
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), eq(tickets.id, ticketId)));
  if (!t) throw new Error("ticket not found");
  const prev = t.fields[key];
  if (prev && JSON.stringify(prev.value) === JSON.stringify(value) && prev.source === "human") return;
  const wasAi = prev?.source === "ai" || (prev?.source === "human" && prev.corrected);
  const next: TicketFieldValue = {
    value,
    source: "human",
    at: new Date().toISOString(),
    by: actor.id ?? null,
    corrected: wasAi && JSON.stringify(prev?.aiValue ?? prev?.value) !== JSON.stringify(value),
    aiValue: prev?.source === "ai" ? prev.value : prev?.aiValue,
  };
  await db
    .update(tickets)
    .set({ fields: sql`${tickets.fields} || ${JSON.stringify({ [key]: next })}::jsonb` })
    .where(eq(tickets.id, ticketId));
  const [m] = await db
    .insert(messages)
    .values({
      id: id("msg"),
      orgId,
      ticketId,
      kind: "event",
      authorType: "agent",
      authorId: actor.id ?? null,
      authorName: actor.name ?? null,
      body: `${actor.name ?? "Someone"} set ${f.label.toLowerCase()} to ${show(value)}`,
      meta: { event: { type: "field", from: prev?.value ?? null, to: value } } as never,
    })
    .returning();
  bus.publish({ type: "message.created", orgId, ticketId, messageId: m!.id, authorType: "agent", kind: "event" });
  bus.publish({ type: "ticket.updated", orgId, ticketId, changes: ["fields"], actorId: actor.id ?? undefined });
}

/** Fields trace should fill for this ticket: ai fields, and customer fields the record doesn't have. */
export function aiFieldSpecs(defs: FieldDef[], customerAttrs: Record<string, unknown> | null | undefined) {
  return defs.filter(
    (f) =>
      f.source === "ai" ||
      (f.source === "customer" &&
        !!f.aiInstruction.trim() &&
        (!f.customerAttribute || empty(customerAttrs?.[f.customerAttribute]))),
  );
}

/** Apply values trace found. Never touches values a person set; invalid values are dropped. */
export async function applyAiFields(orgId: string, ticketId: string, found: Record<string, unknown>) {
  const defs = await getFields(orgId);
  const [t] = await db.select({ fields: tickets.fields }).from(tickets).where(eq(tickets.id, ticketId));
  if (!t) return {};
  const patch: Record<string, TicketFieldValue> = {};
  for (const f of defs) {
    if (!(f.key in found) || t.fields[f.key]?.source === "human") continue;
    try {
      const value = coerce(f, found[f.key]);
      if (value == null) continue;
      patch[f.key] = { value, source: "ai", at: new Date().toISOString() };
    } catch {
      /* the model picked something that isn't an option — leave it empty */
    }
  }
  if (Object.keys(patch).length) {
    await db
      .update(tickets)
      .set({ fields: sql`${tickets.fields} || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(tickets.id, ticketId));
    bus.publish({ type: "ticket.updated", orgId, ticketId, changes: ["fields"] });
  }
  return patch;
}

/** Recent tickets where people corrected trace's classification: few-shot examples for the next one. */
export async function classificationExamples(orgId: string, limit = 8) {
  return db
    .select({
      subject: tickets.subject,
      summary: tickets.aiSummary,
      value: sql<string>`${tickets.fields} -> 'type' ->> 'value'`,
      was: sql<string | null>`${tickets.fields} -> 'type' ->> 'aiValue'`,
    })
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), sql`(${tickets.fields} -> 'type' ->> 'corrected')::boolean is true`))
    .orderBy(desc(tickets.updatedAt))
    .limit(limit);
}

/** "trace classified 412 · people changed 19" for the last 30 days. */
export async function classificationStats(orgId: string) {
  const [r] = await db
    .select({
      classified:
        sql<number>`count(*) filter (where (${tickets.fields} -> 'type' ->> 'source') = 'ai' or (${tickets.fields} -> 'type' ->> 'corrected')::boolean is true or (${tickets.fields} -> 'type' -> 'aiValue') is not null)`.mapWith(
          Number,
        ),
      corrected:
        sql<number>`count(*) filter (where (${tickets.fields} -> 'type' ->> 'corrected')::boolean is true)`.mapWith(
          Number,
        ),
    })
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), sql`${tickets.createdAt} > now() - interval '30 days'`));
  return r ?? { classified: 0, corrected: 0 };
}

/** Field values for a ticket (with the customer record), ready for the API. */
export async function ticketFieldValues(
  orgId: string,
  ticket: { fields: Record<string, TicketFieldValue>; customerId: string | null },
) {
  const defs = await getFields(orgId);
  const attrs = ticket.customerId
    ? (await db.select({ a: customers.attributes }).from(customers).where(eq(customers.id, ticket.customerId)))[0]?.a
    : null;
  return resolveFields(defs, ticket.fields ?? {}, attrs);
}

// ---------------------------------------------------------------- offline extraction

const TYPE_RULES: [string, RegExp][] = [
  ["incident", /\b(outage|down for everyone|is down|all (?:our )?users|nobody can|status page|degraded)\b/i],
  [
    "bug",
    /\b(bug|error|broken|crash|fails?|failing|doesn'?t work|not working|500|exception|blank page|wrong|loops?)\b|funktioniert nicht|kaputt/i,
  ],
  [
    "feature request",
    /\b(feature|would be (?:great|nice)|could you add|wish|please add|support for|roadmap|request)\b/i,
  ],
  ["billing", /\b(invoice|charge[ds]?|refund|billing|payment|plan|subscription|seats?|vat)\b|rechnung/i],
  ["how-to", /\b(how (?:do|can) i|how to|where (?:do|can) i|is there a way)\b|wie kann ich/i],
];

/** Rule-based field values for the offline agent (no API key). */
export function heuristicFields(text: string, specs: FieldDef[]): Record<string, Value> {
  const out: Record<string, Value> = {};
  const lower = text.toLowerCase();
  for (const f of specs) {
    if (f.key === "type") {
      const hit = TYPE_RULES.find(([, re]) => re.test(text));
      const value = hit?.[0] ?? (text.includes("?") ? "question" : null);
      if (value && f.options.some((o) => o.value === value)) out[f.key] = value;
      continue;
    }
    if (f.type === "select" || f.type === "multiselect") {
      const hits = f.options.map((o) => o.value).filter((o) => lower.includes(o.toLowerCase()));
      if (hits.length) out[f.key] = f.type === "select" ? hits[0]! : hits;
      continue;
    }
    const hint = `${f.key} ${f.label} ${f.aiInstruction}`.toLowerCase();
    let m: RegExpMatchArray | null = null;
    if (/version/.test(hint)) m = text.match(/\b(?:v(?:ersion)?\s*)?(\d+\.\d+(?:\.\d+)?)\b/i);
    else if (/org/.test(hint))
      m = text.match(/\b(?:org(?:anization)?[\s_-]?id[:#\s]*)([A-Za-z0-9_-]{4,})|\b(org_[A-Za-z0-9]{4,})\b/i);
    else if (/url|link/.test(hint) || f.type === "url") m = text.match(/(https?:\/\/[^\s)>"]+)/i);
    else if (/e-?mail/.test(hint)) m = text.match(/([\w.+-]+@[\w-]+\.[\w.]+)/);
    else if (f.type === "number") m = text.match(/\b(\d+)\s*(?:users?|seats?|accounts?|people)\b/i);
    const v = m?.slice(1).find(Boolean);
    if (v) out[f.key] = v;
  }
  return out;
}
