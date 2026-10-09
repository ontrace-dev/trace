import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.ts";
import { ticketFields } from "../db/schema.ts";
import { badRequest, notFound } from "../lib/http.ts";
import { id } from "../lib/ids.ts";
import { classificationStats, getFields } from "../services/fields.ts";
import { type AppEnv, requireAdmin } from "./middleware.ts";

/** Ticket field definitions (classification + custom properties). Mounted at /api/w/:wid/fields */
export const fieldsRoutes = new Hono<AppEnv>();

const option = z.object({ value: z.string().trim().min(1).max(60), color: z.string().max(20).optional() });
const fieldBody = {
  label: z.string().trim().min(1).max(60),
  type: z.enum(["text", "number", "select", "multiselect", "checkbox", "date", "url"]),
  options: z.array(option).max(100),
  source: z.enum(["ai", "customer", "manual"]),
  customerAttribute: z.string().trim().max(60).nullable(),
  aiInstruction: z.string().max(1000),
  shown: z.enum(["header", "panel", "hidden"]),
  requiredToResolve: z.boolean(),
};

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const keyFrom = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "f_$1")
    .slice(0, 40) || "field";

function check(b: {
  type?: string;
  options?: { value: string }[];
  source?: string;
  customerAttribute?: string | null;
}) {
  if ((b.type === "select" || b.type === "multiselect") && b.options && !b.options.length)
    throw badRequest("Add at least one option");
  if (b.source === "customer" && b.customerAttribute !== undefined && !b.customerAttribute)
    throw badRequest("Name the customer attribute to read, e.g. org_id");
  if (b.options && new Set(b.options.map((o) => o.value.toLowerCase())).size !== b.options.length)
    throw badRequest("Options must be unique");
}

fieldsRoutes.get("/", async (c) => {
  const orgId = c.get("orgId");
  const [fields, stats] = await Promise.all([getFields(orgId), classificationStats(orgId)]);
  return c.json({ fields, stats });
});

fieldsRoutes.post("/", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const b = z
    .object({
      ...fieldBody,
      key: z.string().optional(),
      options: fieldBody.options.default([]),
      source: fieldBody.source.default("manual"),
      customerAttribute: fieldBody.customerAttribute.default(null),
      aiInstruction: fieldBody.aiInstruction.default(""),
      shown: fieldBody.shown.default("panel"),
      requiredToResolve: fieldBody.requiredToResolve.default(false),
    })
    .parse(await c.req.json());
  check(b);
  const key = b.key?.trim() || keyFrom(b.label);
  if (!KEY_RE.test(key)) throw badRequest("Key must be lowercase snake_case");
  const existing = await getFields(orgId);
  if (existing.some((f) => f.key === key)) throw badRequest(`A field with key “${key}” already exists`);
  const [f] = await db
    .insert(ticketFields)
    .values({ id: id("fld"), orgId, ...b, key, position: existing.length })
    .returning();
  return c.json({ field: f }, 201);
});

fieldsRoutes.patch("/:id", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  // No defaults on patch: zod applies .default() even under .partial().
  const b = z
    .object(fieldBody)
    .partial()
    .parse(await c.req.json());
  const [cur] = await db
    .select()
    .from(ticketFields)
    .where(and(eq(ticketFields.orgId, orgId), eq(ticketFields.id, c.req.param("id"))));
  if (!cur) throw notFound("Field not found");
  check({ ...cur, ...b });
  if (cur.system && b.type && b.type !== cur.type) throw badRequest("The classification stays a single choice");
  const [f] = await db.update(ticketFields).set(b).where(eq(ticketFields.id, cur.id)).returning();
  return c.json({ field: f });
});

fieldsRoutes.post("/reorder", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const { ids } = z.object({ ids: z.array(z.string()).max(200) }).parse(await c.req.json());
  await Promise.all(
    ids.map((fid, position) =>
      db
        .update(ticketFields)
        .set({ position })
        .where(and(eq(ticketFields.orgId, orgId), eq(ticketFields.id, fid))),
    ),
  );
  return c.json({ ok: true });
});

fieldsRoutes.delete("/:id", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const [cur] = await db
    .select()
    .from(ticketFields)
    .where(and(eq(ticketFields.orgId, orgId), eq(ticketFields.id, c.req.param("id"))));
  if (!cur) throw notFound("Field not found");
  if (cur.system) throw badRequest("The classification can't be deleted");
  await db.delete(ticketFields).where(eq(ticketFields.id, cur.id));
  // Values stay on old tickets' JSON; they're simply no longer shown. Clean them up to keep the API tidy.
  await db.execute(
    sql`update tickets set fields = fields - ${cur.key} where org_id = ${orgId} and fields ? ${cur.key}`,
  );
  return c.json({ ok: true });
});
