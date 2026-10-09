import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { customers, messages, testCases, testRuns, tickets } from "../../db/schema.ts";
import { id } from "../../lib/ids.ts";
import { truncate } from "../../lib/text.ts";
import type { SimulationResult, TestResult } from "../../lib/types.ts";
import { callClaude, describeError, getClaude, textOf } from "../ai/client.ts";
import { judgeResult, type TestCase } from "../ai/judge.ts";
import { simulateAgent } from "../ai/simulate.ts";
import { getSettings } from "../workspace.ts";

const CONCURRENCY = 2;

const emptySimulation = (error: string): SimulationResult => ({
  outcome: "escalate",
  body: "",
  confidence: 0,
  sources: [],
  reason: error,
  policy: { autoSend: false, why: "run failed" },
  actions: [],
  spans: [],
  provider: "local",
  durationMs: 0,
});

/** Simulate one case and grade it. Never throws: failures become failed results. */
export async function runCase(orgId: string, tc: TestCase): Promise<TestResult> {
  const ranAt = new Date().toISOString();
  try {
    const simulation = await simulateAgent(orgId, {
      message: tc.message,
      subject: tc.subject || undefined,
      channel: tc.channel,
      customerEmail: tc.customerEmail,
    });
    const j = await judgeResult(orgId, tc, simulation);
    return { ranAt, ...j, simulation };
  } catch (err) {
    const msg = describeError(err);
    return {
      ranAt,
      passed: false,
      score: 0,
      verdict: `The simulation failed: ${msg}`,
      outcomeMatched: false,
      simulation: emptySimulation(msg),
    };
  }
}

/** Start a background run over the given cases (all cases when omitted). Returns the run row. */
export async function startRun(orgId: string, userId: string, caseIds?: string[]) {
  const cases = await db
    .select()
    .from(testCases)
    .where(and(eq(testCases.orgId, orgId), caseIds?.length ? inArray(testCases.id, caseIds) : undefined))
    .orderBy(asc(testCases.createdAt));
  const [run] = await db
    .insert(testRuns)
    .values({
      id: id("trun"),
      orgId,
      total: cases.length,
      startedBy: userId,
      status: cases.length ? "running" : "done",
      finishedAt: cases.length ? null : new Date(),
    })
    .returning();
  if (cases.length) void execute(run!.id, orgId, cases);
  return run!;
}

async function execute(runId: string, orgId: string, cases: TestCase[]) {
  const queue = [...cases];
  const worker = async () => {
    for (let tc = queue.shift(); tc; tc = queue.shift()) {
      const result = await runCase(orgId, tc);
      await db.update(testCases).set({ lastResult: result }).where(eq(testCases.id, tc.id));
      await db
        .update(testRuns)
        .set({
          completed: sql`${testRuns.completed} + 1`,
          passed: sql`${testRuns.passed} + ${result.passed ? 1 : 0}`,
        })
        .where(eq(testRuns.id, runId));
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cases.length) }, worker));
    await db.update(testRuns).set({ status: "done", finishedAt: new Date() }).where(eq(testRuns.id, runId));
  } catch (err) {
    console.error("[testing] run failed", err);
    await db.update(testRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(testRuns.id, runId));
  }
}

/** Turn recently resolved tickets into test cases: first customer message → expected resolution. */
export async function importFromTickets(orgId: string, limit = 10) {
  const imported = await db
    .select({ id: testCases.sourceTicketId })
    .from(testCases)
    .where(and(eq(testCases.orgId, orgId), isNotNull(testCases.sourceTicketId)));
  const skip = new Set(imported.map((r) => r.id));
  const candidates = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      channel: tickets.channel,
      email: customers.email,
    })
    .from(tickets)
    .leftJoin(customers, eq(customers.id, tickets.customerId))
    .where(and(eq(tickets.orgId, orgId), inArray(tickets.status, ["resolved", "closed"])))
    .orderBy(desc(sql`coalesce(${tickets.resolvedAt}, ${tickets.lastMessageAt})`))
    .limit(limit * 4);

  const settings = await getSettings(orgId);
  const claude = getClaude(settings.ai);
  const created: TestCase[] = [];
  for (const t of candidates) {
    if (created.length >= limit) break;
    if (skip.has(t.id)) continue;
    const msgs = await db
      .select()
      .from(messages)
      .where(and(eq(messages.ticketId, t.id), eq(messages.kind, "message")))
      .orderBy(asc(messages.createdAt));
    const first = msgs.find((m) => m.authorType === "customer");
    const answer = [...msgs].reverse().find((m) => m.authorType === "agent" || m.authorType === "ai");
    if (!first || !answer) continue;
    const expectation = await expectationFrom(claude, t.subject, first.body, answer.body);
    const [tc] = await db
      .insert(testCases)
      .values({
        id: id("tc"),
        orgId,
        name: truncate(t.subject, 80),
        subject: t.subject,
        message: first.body,
        channel: t.channel === "web" ? "email" : t.channel,
        customerEmail: t.email,
        expectation,
        expectedOutcome: "reply",
        sourceTicketId: t.id,
      })
      .returning();
    created.push(tc!);
  }
  return created;
}

async function expectationFrom(
  claude: ReturnType<typeof getClaude>,
  subject: string,
  question: string,
  answer: string,
) {
  const fallback = () => {
    const sentences = answer
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.length > 3 && !/^(hi|hello|hey|thanks)\b/i.test(s))
      .slice(0, 2)
      .join(" ");
    return `Should convey: ${truncate(sentences || answer, 400)}`;
  };
  if (!claude) return fallback();
  try {
    const res = await callClaude(claude, {
      max_tokens: 1500,
      system:
        "From a resolved support ticket, write 1-3 short, checkable criteria that any good answer to the customer must satisfy (facts, steps, commitments). Generalize away names, amounts and ids. Output only the criteria.",
      messages: [
        {
          role: "user",
          content: `Subject: ${subject}\n\nCustomer:\n${question}\n\nFinal answer from support:\n${answer}`,
        },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { criteria: { type: "array", items: { type: "string" } } },
            required: ["criteria"],
          },
        },
      },
    });
    const { criteria } = JSON.parse(textOf(res)) as { criteria: string[] };
    return criteria.length ? criteria.map((c) => `- ${c}`).join("\n") : fallback();
  } catch (err) {
    console.warn("[testing] could not summarize expectation:", describeError(err));
    return fallback();
  }
}
