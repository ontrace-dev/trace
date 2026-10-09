import { and, asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.ts";
import { testCases, testRuns } from "../db/schema.ts";
import { notFound } from "../lib/http.ts";
import { id } from "../lib/ids.ts";
import { simulateAgent } from "../services/ai/simulate.ts";
import { importFromTickets, startRun } from "../services/testing/runner.ts";
import type { AppEnv } from "./middleware.ts";

/**
 * Agent simulation playground and test suites. Mounted at /api/w/:wid/testing
 * Simulations and test runs never send messages, create tickets or run write actions,
 * so every workspace member may use them.
 */
export const testingRoutes = new Hono<AppEnv>();

const CHANNEL = z.enum(["email", "widget", "api", "slack", "discord", "web"]);
const OUTCOME = z.enum(["reply", "escalate", "any"]);

testingRoutes.post("/simulate", async (c) => {
  const b = z
    .object({
      message: z.string().min(1).max(20_000),
      subject: z.string().max(300).optional(),
      channel: CHANNEL.optional(),
      customerEmail: z.string().email().nullish().or(z.literal("")),
      customerName: z.string().nullish(),
      history: z
        .array(z.object({ from: z.enum(["customer", "agent"]), body: z.string().min(1) }))
        .max(20)
        .optional(),
      aiOverrides: z
        .object({
          mode: z.enum(["draft", "auto"]).optional(),
          autoSendThreshold: z.number().min(0).max(1).optional(),
          tone: z.enum(["friendly", "formal", "concise"]).optional(),
          guidance: z.string().max(10_000).optional(),
          widgetInstantAnswers: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .parse(await c.req.json());
  const result = await simulateAgent(c.get("orgId"), { ...b, customerEmail: b.customerEmail || null });
  return c.json(result);
});

// ---------------------------------------------------------------- cases

testingRoutes.get("/cases", async (c) => {
  const rows = await db
    .select()
    .from(testCases)
    .where(eq(testCases.orgId, c.get("orgId")))
    .orderBy(asc(testCases.createdAt));
  return c.json({ cases: rows });
});

const caseFields = {
  name: z.string().min(1).max(200),
  subject: z.string().max(300),
  message: z.string().min(1).max(20_000),
  channel: CHANNEL,
  customerEmail: z.string().email().nullable().or(z.literal("")),
  expectation: z.string().max(5000),
  expectedOutcome: OUTCOME,
};

testingRoutes.post("/cases", async (c) => {
  const b = z
    .object({
      ...caseFields,
      subject: caseFields.subject.optional(),
      channel: caseFields.channel.optional(),
      customerEmail: caseFields.customerEmail.optional(),
      expectation: caseFields.expectation.optional(),
      expectedOutcome: caseFields.expectedOutcome.optional(),
    })
    .parse(await c.req.json());
  const [row] = await db
    .insert(testCases)
    .values({
      id: id("tc"),
      orgId: c.get("orgId"),
      name: b.name,
      subject: b.subject ?? "",
      message: b.message,
      channel: b.channel ?? "email",
      customerEmail: b.customerEmail || null,
      expectation: b.expectation ?? "",
      expectedOutcome: b.expectedOutcome ?? "any",
    })
    .returning();
  return c.json({ case: row });
});

testingRoutes.patch("/cases/:id", async (c) => {
  // Explicit optional fields (no defaults): zod applies .default() even under .partial().
  const b = z
    .object({
      name: caseFields.name.optional(),
      subject: caseFields.subject.optional(),
      message: caseFields.message.optional(),
      channel: caseFields.channel.optional(),
      customerEmail: caseFields.customerEmail.optional(),
      expectation: caseFields.expectation.optional(),
      expectedOutcome: caseFields.expectedOutcome.optional(),
    })
    .parse(await c.req.json());
  const patch = { ...b, ...(b.customerEmail !== undefined ? { customerEmail: b.customerEmail || null } : {}) };
  const [row] = await db
    .update(testCases)
    .set(patch)
    .where(and(eq(testCases.orgId, c.get("orgId")), eq(testCases.id, c.req.param("id"))))
    .returning();
  if (!row) throw notFound("Test case not found");
  return c.json({ case: row });
});

testingRoutes.delete("/cases/:id", async (c) => {
  await db.delete(testCases).where(and(eq(testCases.orgId, c.get("orgId")), eq(testCases.id, c.req.param("id"))));
  return c.json({ ok: true });
});

testingRoutes.post("/cases/import", async (c) => {
  const { limit } = z
    .object({ limit: z.number().int().min(1).max(50).optional() })
    .parse(await c.req.json().catch(() => ({})));
  const created = await importFromTickets(c.get("orgId"), limit ?? 10);
  return c.json({ cases: created });
});

// ---------------------------------------------------------------- runs

testingRoutes.post("/runs", async (c) => {
  const { caseIds } = z.object({ caseIds: z.array(z.string()).optional() }).parse(await c.req.json().catch(() => ({})));
  const run = await startRun(c.get("orgId"), c.get("user").id, caseIds);
  return c.json({ run });
});

testingRoutes.get("/runs/latest", async (c) => {
  const [run] = await db
    .select()
    .from(testRuns)
    .where(eq(testRuns.orgId, c.get("orgId")))
    .orderBy(desc(testRuns.createdAt))
    .limit(1);
  return c.json({ run: run ?? null });
});

testingRoutes.get("/runs/:id", async (c) => {
  const [run] = await db
    .select()
    .from(testRuns)
    .where(and(eq(testRuns.orgId, c.get("orgId")), eq(testRuns.id, c.req.param("id"))));
  if (!run) throw notFound("Run not found");
  return c.json({ run });
});
