import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { customers } from "../../db/schema.ts";
import type { SimulationResult } from "../../lib/types.ts";
import { loadToolset } from "../actions/toolset.ts";
import { aiFieldSpecs, classificationExamples, getFields } from "../fields.ts";
import type { Customer, Message, Ticket } from "../tickets.ts";
import { Trace } from "../tracer.ts";
import { getOrg, getSettings } from "../workspace.ts";
import { type AgentContext, policyAllowsAutoSend, runAgentCore } from "./agent.ts";

export interface SimulationInput {
  message: string;
  subject?: string;
  channel?: Ticket["channel"];
  /** Use a real customer's profile (plan, history) if one exists with this email. */
  customerEmail?: string | null;
  customerName?: string | null;
  /** Earlier turns, oldest first, for multi-turn tests. */
  history?: { from: "customer" | "agent"; body: string }[];
  /** Override AI settings for what-if runs (e.g. a different mode or guidance) without saving them. */
  aiOverrides?: Record<string, unknown>;
}

/**
 * Run the real agent — same prompt, tools, knowledge, procedures and policy — against a hypothetical
 * conversation. Nothing is written: no ticket, no messages, no spans; write actions are simulated and
 * only read-only actions really execute.
 */
export async function simulateAgent(orgId: string, input: SimulationInput): Promise<SimulationResult> {
  const t0 = performance.now();
  const [settings, org, toolset] = await Promise.all([getSettings(orgId), getOrg(orgId), loadToolset(orgId)]);
  const now = new Date();
  const email = input.customerEmail?.trim().toLowerCase() || null;
  const [existing] = email
    ? await db
        .select()
        .from(customers)
        .where(and(eq(customers.orgId, orgId), eq(customers.email, email)))
    : [];
  const customer: Customer | undefined =
    existing ??
    (email || input.customerName
      ? {
          id: "",
          orgId,
          email,
          name: input.customerName ?? email?.split("@")[0] ?? "Customer",
          company: null,
          avatarUrl: null,
          externalId: null,
          attributes: {},
          slackUserId: null,
          createdAt: now,
          lastSeenAt: now,
        }
      : undefined);

  const subject = input.subject?.trim() || input.message.slice(0, 70);
  const ticket: Ticket = {
    id: "tkt_simulation",
    orgId,
    number: 0,
    subject,
    status: "open",
    priority: "normal",
    channel: input.channel ?? "email",
    channelId: null,
    customerId: customer?.id || null,
    assigneeId: null,
    tags: [],
    aiState: "processing",
    aiSummary: null,
    aiIntent: null,
    aiLanguage: null,
    aiSentiment: null,
    aiConfidence: null,
    firstResponseDueAt: null,
    firstRespondedAt: null,
    resolvedAt: null,
    lastMessageAt: now,
    lastCustomerMessageAt: now,
    email: null,
    slack: null,
    discord: null,
    widgetVisitorId: null,
    assignedAt: null,
    routing: null,
    fields: {},
    createdAt: now,
    updatedAt: now,
  };
  const turns = [...(input.history ?? []), { from: "customer" as const, body: input.message }];
  const history: Message[] = turns.map((t, i) => ({
    id: `msg_sim_${i}`,
    orgId,
    ticketId: ticket.id,
    kind: "message",
    authorType: t.from === "customer" ? "customer" : "agent",
    authorId: null,
    authorName: t.from === "customer" ? (customer?.name ?? "Customer") : "Support",
    body: t.body,
    html: null,
    attachments: [],
    externalId: null,
    meta: {},
    createdAt: new Date(now.getTime() - (turns.length - i) * 60_000),
  }));

  const ctx: AgentContext = {
    orgId,
    orgName: org?.name ?? "the company",
    ai: { ...settings.ai, ...input.aiOverrides, enabled: true },
    ticket,
    customer,
    history,
    ticketRef: `${settings.ticketPrefix}-TEST`,
    toolset,
    fields: aiFieldSpecs(await getFields(orgId), customer?.attributes),
    fieldExamples: await classificationExamples(orgId),
    dryRun: true,
  };
  const trace = new Trace(orgId, null, false);
  const run = await runAgentCore(ctx, trace);
  const policy = policyAllowsAutoSend(ctx, run.outcome);
  const waitsForApproval = run.actionCalls.some((a) => a.mode === "approval");
  return {
    outcome: run.outcome.kind,
    body: run.outcome.body,
    confidence: run.outcome.confidence,
    sources: run.outcome.sources,
    reason: run.outcome.reason,
    internalNote: run.outcome.internalNote,
    triage: run.outcome.triage,
    policy: waitsForApproval
      ? { autoSend: false, why: "an action would wait for human approval first" }
      : { autoSend: policy.ok, why: policy.why },
    actions: run.actionCalls,
    spans: [...trace.collected].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    provider: run.provider,
    durationMs: Math.round(performance.now() - t0),
  };
}
