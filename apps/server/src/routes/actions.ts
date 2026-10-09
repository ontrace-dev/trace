import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.ts";
import { actionRuns, actions, procedures, tickets, workspaceSecrets } from "../db/schema.ts";
import { encrypt } from "../lib/crypto.ts";
import { badRequest, notFound } from "../lib/http.ts";
import { id } from "../lib/ids.ts";
import { executeAction } from "../services/actions/executor.ts";
import { getPreset, presets } from "../services/actions/presets.ts";
import { approveRun, rejectRun } from "../services/actions/runs.ts";
import { ACTION_NAME_RE, RESERVED_TOOL_NAMES } from "../services/actions/toolset.ts";
import { getCustomer, getTicket, getTicketByNumber } from "../services/tickets.ts";
import { getSettings } from "../services/workspace.ts";
import { type AppEnv, requireAdmin } from "./middleware.ts";

/** Actions, procedures, secrets and action-run approvals. Mounted at /api/w/:wid/automation */
export const actionsRoutes = new Hono<AppEnv>();

const parameterSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "parameter names are lowercase snake_case"),
  type: z.enum(["string", "number", "integer", "boolean"]),
  description: z.string().default(""),
  required: z.boolean().default(true),
  enum: z.array(z.string()).optional(),
});

const actionFields = {
  name: z.string(),
  title: z.string().min(1),
  description: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable(),
  bodyFormat: z.enum(["json", "form", "none"]),
  parameters: z.array(parameterSchema),
  requiresApproval: z.boolean(),
  readOnly: z.boolean(),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(500).max(60_000),
};
const createSchema = z.object({
  ...actionFields,
  headers: actionFields.headers.default({}),
  body: actionFields.body.default(null),
  bodyFormat: actionFields.bodyFormat.default("json"),
  parameters: actionFields.parameters.default([]),
  requiresApproval: actionFields.requiresApproval.default(true),
  readOnly: actionFields.readOnly.default(false),
  enabled: actionFields.enabled.default(true),
  timeoutMs: actionFields.timeoutMs.default(10_000),
  method: actionFields.method.default("GET"),
});
// No defaults on patch: zod applies .default() even under .partial().
const patchSchema = z.object(actionFields).partial();

async function checkName(orgId: string, name: string, exceptId?: string) {
  if (!ACTION_NAME_RE.test(name))
    throw badRequest("Name must be lowercase snake_case (2–49 chars, starting with a letter)");
  if (RESERVED_TOOL_NAMES.has(name)) throw badRequest(`"${name}" is reserved for a built-in agent tool`);
  const [dupe] = await db
    .select({ id: actions.id })
    .from(actions)
    .where(and(eq(actions.orgId, orgId), eq(actions.name, name)));
  if (dupe && dupe.id !== exceptId) throw badRequest(`An action named "${name}" already exists`);
}

function checkBody(body: string | null | undefined, format: string | undefined) {
  if (!body?.trim() || format === "none") return;
  try {
    JSON.parse(body);
  } catch {
    throw badRequest('Body template must be valid JSON (placeholders go inside strings: "{{param}}")');
  }
}

// ---------------------------------------------------------------- actions

actionsRoutes.get("/actions", async (c) => {
  const rows = await db
    .select()
    .from(actions)
    .where(eq(actions.orgId, c.get("orgId")))
    .orderBy(asc(actions.name));
  return c.json({ actions: rows });
});

actionsRoutes.post("/actions", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const b = createSchema.parse(await c.req.json());
  await checkName(orgId, b.name);
  checkBody(b.body, b.bodyFormat);
  const [row] = await db
    .insert(actions)
    .values({ id: id("act"), orgId, ...b })
    .returning();
  return c.json({ action: row });
});

actionsRoutes.get("/presets", (c) => c.json({ presets: presets() }));

actionsRoutes.post("/actions/from-preset", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const b = z.object({ presetId: z.string(), overrides: patchSchema.optional() }).parse(await c.req.json());
  const preset = getPreset(b.presetId);
  if (!preset) throw notFound("Unknown preset");
  const { id: presetId, group: _g, secrets: _s, setup: _setup, ...fields } = preset;
  const values = { ...fields, ...b.overrides };
  // Pick a free name if the preset was added before.
  let name = values.name;
  for (let i = 2; ; i++) {
    const [dupe] = await db
      .select({ id: actions.id })
      .from(actions)
      .where(and(eq(actions.orgId, orgId), eq(actions.name, name)));
    if (!dupe) break;
    name = `${values.name}_${i}`;
  }
  await checkName(orgId, name);
  const [row] = await db
    .insert(actions)
    .values({ id: id("act"), orgId, ...values, name, preset: presetId, timeoutMs: values.timeoutMs ?? 10_000 })
    .returning();
  return c.json({ action: row });
});

actionsRoutes.patch("/actions/:id", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const b = patchSchema.parse(await c.req.json());
  const [cur] = await db
    .select()
    .from(actions)
    .where(and(eq(actions.orgId, orgId), eq(actions.id, c.req.param("id"))));
  if (!cur) throw notFound("Action not found");
  if (b.name !== undefined && b.name !== cur.name) await checkName(orgId, b.name, cur.id);
  checkBody(b.body === undefined ? cur.body : b.body, b.bodyFormat ?? cur.bodyFormat);
  const [row] = await db.update(actions).set(b).where(eq(actions.id, cur.id)).returning();
  return c.json({ action: row });
});

actionsRoutes.delete("/actions/:id", requireAdmin, async (c) => {
  await db.delete(actions).where(and(eq(actions.orgId, c.get("orgId")), eq(actions.id, c.req.param("id"))));
  return c.json({ ok: true });
});

/** Really executes the action (with an optional ticket for {{customer.*}} / {{ticket.*}}). */
actionsRoutes.post("/actions/:id/test", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const b = z
    .object({
      input: z.record(z.string(), z.unknown()).default({}),
      ticket: z.string().optional(),
      customerEmail: z.string().optional(),
    })
    .parse(await c.req.json().catch(() => ({})));
  const [action] = await db
    .select()
    .from(actions)
    .where(and(eq(actions.orgId, orgId), eq(actions.id, c.req.param("id"))));
  if (!action) throw notFound("Action not found");
  let ticket = undefined;
  if (b.ticket) {
    const ref = b.ticket.replace(/^[A-Z]+-/i, "");
    ticket = /^\d+$/.test(ref) ? await getTicketByNumber(orgId, Number(ref)) : await getTicket(orgId, ref);
    if (!ticket) throw badRequest(`Ticket ${b.ticket} not found`);
  }
  let customer = ticket ? await getCustomer(ticket.customerId) : undefined;
  if (!customer && b.customerEmail) {
    customer = {
      id: "",
      orgId,
      email: b.customerEmail,
      name: null,
      company: null,
      avatarUrl: null,
      externalId: null,
      attributes: {},
      slackUserId: null,
      createdAt: new Date(),
      lastSeenAt: null,
    };
  }
  const result = await executeAction(action, b.input, { orgId, ticket, customer });
  return c.json({ result });
});

// ---------------------------------------------------------------- procedures

const procedureSchema = z.object({
  name: z.string().min(1),
  trigger: z.string().min(1),
  instructions: z.string().min(1),
  enabled: z.boolean().optional(),
});

actionsRoutes.get("/procedures", async (c) => {
  const rows = await db
    .select()
    .from(procedures)
    .where(eq(procedures.orgId, c.get("orgId")))
    .orderBy(asc(procedures.position), asc(procedures.createdAt));
  return c.json({ procedures: rows });
});

actionsRoutes.post("/procedures", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const b = procedureSchema.parse(await c.req.json());
  const existing = await db
    .select({ position: procedures.position })
    .from(procedures)
    .where(eq(procedures.orgId, orgId));
  const position = existing.reduce((m, r) => Math.max(m, r.position + 1), 0);
  const [row] = await db
    .insert(procedures)
    .values({ id: id("proc"), orgId, ...b, enabled: b.enabled ?? true, position })
    .returning();
  return c.json({ procedure: row });
});

actionsRoutes.patch("/procedures/:id", requireAdmin, async (c) => {
  const b = procedureSchema.partial().parse(await c.req.json());
  const [row] = await db
    .update(procedures)
    .set(b)
    .where(and(eq(procedures.orgId, c.get("orgId")), eq(procedures.id, c.req.param("id"))))
    .returning();
  if (!row) throw notFound("Procedure not found");
  return c.json({ procedure: row });
});

actionsRoutes.post("/procedures/reorder", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const { ids } = z.object({ ids: z.array(z.string()) }).parse(await c.req.json());
  await db.transaction(async (tx) => {
    for (const [position, pid] of ids.entries()) {
      await tx
        .update(procedures)
        .set({ position })
        .where(and(eq(procedures.orgId, orgId), eq(procedures.id, pid)));
    }
  });
  return c.json({ ok: true });
});

actionsRoutes.delete("/procedures/:id", requireAdmin, async (c) => {
  await db.delete(procedures).where(and(eq(procedures.orgId, c.get("orgId")), eq(procedures.id, c.req.param("id"))));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- secrets (values are write-only)

const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

actionsRoutes.get("/secrets", requireAdmin, async (c) => {
  const rows = await db
    .select({
      id: workspaceSecrets.id,
      name: workspaceSecrets.name,
      createdAt: workspaceSecrets.createdAt,
      updatedAt: workspaceSecrets.updatedAt,
    })
    .from(workspaceSecrets)
    .where(eq(workspaceSecrets.orgId, c.get("orgId")))
    .orderBy(asc(workspaceSecrets.name));
  return c.json({ secrets: rows });
});

actionsRoutes.put("/secrets/:name", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const name = c.req.param("name");
  if (!SECRET_NAME.test(name)) throw badRequest("Secret names are UPPER_SNAKE_CASE, e.g. STRIPE_SECRET_KEY");
  const { value } = z.object({ value: z.string().min(1) }).parse(await c.req.json());
  await db
    .insert(workspaceSecrets)
    .values({ id: id("sec"), orgId, name, value: encrypt(value) })
    .onConflictDoUpdate({
      target: [workspaceSecrets.orgId, workspaceSecrets.name],
      set: { value: encrypt(value), updatedAt: new Date() },
    });
  return c.json({ ok: true });
});

actionsRoutes.delete("/secrets/:name", requireAdmin, async (c) => {
  await db
    .delete(workspaceSecrets)
    .where(and(eq(workspaceSecrets.orgId, c.get("orgId")), eq(workspaceSecrets.name, c.req.param("name"))));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- action runs & approvals

actionsRoutes.get("/runs", async (c) => {
  const orgId = c.get("orgId");
  const status = c.req.query("status");
  const statuses = status ? (status.split(",") as (typeof actionRuns.$inferSelect.status)[]) : undefined;
  const rows = await db
    .select({
      run: actionRuns,
      ticketNumber: tickets.number,
      ticketSubject: tickets.subject,
    })
    .from(actionRuns)
    .leftJoin(tickets, eq(tickets.id, actionRuns.ticketId))
    .where(and(eq(actionRuns.orgId, orgId), statuses ? inArray(actionRuns.status, statuses) : undefined))
    .orderBy(desc(actionRuns.createdAt))
    .limit(100);
  const settings = await getSettings(orgId);
  return c.json({
    runs: rows.map((r) => ({
      ...r.run,
      ticketNumber: r.ticketNumber,
      ticketSubject: r.ticketSubject,
      ticketRef: r.ticketNumber != null ? `${settings.ticketPrefix}-${r.ticketNumber}` : null,
    })),
  });
});

actionsRoutes.post("/runs/:id/approve", async (c) => {
  const u = c.get("user");
  const b = z
    .object({ input: z.record(z.string(), z.unknown()).optional() })
    .parse(await c.req.json().catch(() => ({})));
  try {
    const { run, result } = await approveRun(c.get("orgId"), c.req.param("id"), { id: u.id, name: u.name }, b.input);
    return c.json({ run, result });
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : String(err));
  }
});

actionsRoutes.post("/runs/:id/reject", async (c) => {
  const u = c.get("user");
  const b = z.object({ note: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
  try {
    const run = await rejectRun(c.get("orgId"), c.req.param("id"), { id: u.id, name: u.name }, b.note);
    return c.json({ run });
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : String(err));
  }
});
