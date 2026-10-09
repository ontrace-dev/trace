import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { actionRuns, actions, tickets } from "../../db/schema.ts";
import { bus } from "../../lib/bus.ts";
import { id } from "../../lib/ids.ts";
import { truncate } from "../../lib/text.ts";
import { getAgentMcpTool, runMcpNow } from "../mcp/tools.ts";
import { addMessage, getCustomer, getTicket } from "../tickets.ts";
import { Trace } from "../tracer.ts";
import { type Action, type ActionResult, executeAction } from "./executor.ts";

export type ActionRun = typeof actionRuns.$inferSelect;

const fmtInput = (input: Record<string, unknown>) =>
  Object.entries(input)
    .filter(([k]) => k !== "reason")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ") || "no parameters";

export async function listRuns(orgId: string, ticketId: string) {
  return db
    .select()
    .from(actionRuns)
    .where(and(eq(actionRuns.orgId, orgId), eq(actionRuns.ticketId, ticketId)))
    .orderBy(desc(actionRuns.createdAt));
}

/** Run an action now (no approval needed) and record the run. */
export async function runActionNow(opts: {
  orgId: string;
  ticketId: string | null;
  action: Action;
  input: Record<string, unknown>;
  trace: Trace;
  requestedBy?: "ai" | "agent";
}) {
  const { orgId, ticketId, action, input, trace } = opts;
  const ticket = ticketId ? await getTicket(orgId, ticketId) : undefined;
  const customer = ticket ? await getCustomer(ticket.customerId) : undefined;
  const span = trace.start(`action.${action.name}`, "integration");
  const result = await executeAction(action, input, { orgId, ticket, customer });
  await span.end({
    status: result.ok ? "ok" : "error",
    summary: result.ok
      ? `${result.request.method} → ${result.status} · ${result.durationMs}ms`
      : (result.error ?? "failed"),
    attributes: { input, request: result.request, status: result.status, output: truncate(result.output, 1500) },
  });
  if (ticketId) {
    await db.insert(actionRuns).values({
      id: id("run"),
      orgId,
      ticketId,
      actionId: action.id,
      actionName: action.name,
      actionTitle: action.title,
      input,
      status: result.ok ? "succeeded" : "failed",
      httpStatus: result.status,
      output: result.output,
      error: result.error ?? null,
      requestedBy: opts.requestedBy ?? "ai",
      traceId: trace.id,
      finishedAt: new Date(),
    });
  }
  return result;
}

/** Queue a consequential action (or MCP tool call) for human approval and leave a note on the ticket. */
export async function requestApproval(opts: {
  orgId: string;
  ticketId: string;
  action: { id: string | null; name: string; title: string };
  /** Set for MCP tool calls; `action` then describes the tool. */
  mcpToolId?: string;
  input: Record<string, unknown>;
  reason: string;
  traceId: string;
  agentName: string;
}) {
  const { orgId, ticketId, action, input, reason } = opts;
  // The same request twice (e.g. on a re-run) collapses into the existing pending run.
  const pending = await db
    .select()
    .from(actionRuns)
    .where(
      and(
        eq(actionRuns.ticketId, ticketId),
        eq(actionRuns.actionName, action.name),
        eq(actionRuns.status, "pending_approval"),
      ),
    );
  const dupe = pending.find((r) => JSON.stringify(r.input) === JSON.stringify(input));
  if (dupe) return dupe;
  const [run] = await db
    .insert(actionRuns)
    .values({
      id: id("run"),
      orgId,
      ticketId,
      actionId: opts.mcpToolId ? null : action.id,
      mcpToolId: opts.mcpToolId ?? null,
      actionName: action.name,
      actionTitle: action.title,
      input,
      reason,
      status: "pending_approval",
      requestedBy: "ai",
      traceId: opts.traceId,
    })
    .returning();
  await addMessage(orgId, ticketId, {
    kind: "note",
    authorType: "ai",
    authorName: opts.agentName,
    body: `**Approval needed:** ${action.title} (${fmtInput(input)})${reason ? `\n\n${reason}` : ""}`,
    meta: { via: "ai", action: { runId: run!.id, name: action.name, status: "pending_approval" } },
  });
  return run!;
}

async function finishRun(run: ActionRun, result: ActionResult) {
  const [updated] = await db
    .update(actionRuns)
    .set({
      status: result.ok ? "succeeded" : "failed",
      httpStatus: result.status,
      output: result.output,
      error: result.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(actionRuns.id, run.id))
    .returning();
  return updated!;
}

/** A human approves: execute, record the result on the ticket, and let the agent continue. */
export async function approveRun(
  orgId: string,
  runId: string,
  reviewer: { id: string; name: string },
  inputOverride?: Record<string, unknown>,
) {
  const [run] = await db
    .select()
    .from(actionRuns)
    .where(and(eq(actionRuns.orgId, orgId), eq(actionRuns.id, runId)));
  if (!run) throw new Error("action run not found");
  if (run.status !== "pending_approval") throw new Error(`run is already ${run.status}`);
  if (run.mcpToolId) {
    return approveMcpRun(orgId, run, reviewer, inputOverride);
  }
  const [action] = run.actionId ? await db.select().from(actions).where(eq(actions.id, run.actionId)) : [];
  if (!action) throw new Error("the action was deleted");
  const input = inputOverride ? { ...inputOverride, reason: run.input.reason } : run.input;
  await db
    .update(actionRuns)
    .set({ status: "running", input, reviewedBy: reviewer.id, reviewedByName: reviewer.name, reviewedAt: new Date() })
    .where(eq(actionRuns.id, run.id));

  const ticket = run.ticketId ? await getTicket(orgId, run.ticketId) : undefined;
  const customer = ticket ? await getCustomer(ticket.customerId) : undefined;
  const trace = new Trace(orgId, run.ticketId);
  const span = trace.start(`action.${action.name}`, "integration");
  const { reason: _reason, ...callInput } = input;
  const result = await executeAction(action, callInput, { orgId, ticket, customer });
  await span.end({
    status: result.ok ? "ok" : "error",
    summary: `approved by ${reviewer.name} · ${result.ok ? `${result.request.method} → ${result.status}` : result.error}`,
    attributes: {
      input: callInput,
      request: result.request,
      status: result.status,
      output: truncate(result.output, 1500),
    },
  });
  const updated = await finishRun(run, result);
  if (run.ticketId) {
    await addMessage(orgId, run.ticketId, {
      kind: "note",
      authorType: "agent",
      authorId: reviewer.id,
      authorName: reviewer.name,
      body: result.ok
        ? `**Approved and executed:** ${action.title} (${fmtInput(callInput)}) → HTTP ${result.status}\n\n\`\`\`\n${truncate(result.output, 1200)}\n\`\`\``
        : `**Approved, but it failed:** ${action.title} — ${result.error}${result.output ? `\n\n\`\`\`\n${truncate(result.output, 800)}\n\`\`\`` : ""}`,
      meta: { via: "web", action: { runId: run.id, name: action.name, status: updated.status } },
    });
    await continueAgent(orgId, run.ticketId);
  }
  return { run: updated, result };
}

async function approveMcpRun(
  orgId: string,
  run: ActionRun,
  reviewer: { id: string; name: string },
  inputOverride?: Record<string, unknown>,
) {
  const tool = run.mcpToolId ? await getAgentMcpTool(orgId, run.mcpToolId) : undefined;
  if (!tool) throw new Error("the MCP tool was removed from its server");
  const input = inputOverride ?? run.input;
  await db
    .update(actionRuns)
    .set({ status: "running", input, reviewedBy: reviewer.id, reviewedByName: reviewer.name, reviewedAt: new Date() })
    .where(eq(actionRuns.id, run.id));
  const trace = new Trace(orgId, run.ticketId);
  // ticketId null: the run row already exists, only the span is new.
  const result = await runMcpNow({
    orgId,
    ticketId: null,
    tool,
    input,
    trace,
    summaryPrefix: `approved by ${reviewer.name} · `,
  });
  const [updated] = await db
    .update(actionRuns)
    .set({
      status: result.ok ? "succeeded" : "failed",
      output: result.output,
      error: result.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(actionRuns.id, run.id))
    .returning();
  if (run.ticketId) {
    await addMessage(orgId, run.ticketId, {
      kind: "note",
      authorType: "agent",
      authorId: reviewer.id,
      authorName: reviewer.name,
      body: result.ok
        ? `**Approved and executed:** ${run.actionTitle} (${fmtInput(input)})\n\n\`\`\`\n${truncate(result.output, 1200)}\n\`\`\``
        : `**Approved, but it failed:** ${run.actionTitle} — ${result.error}`,
      meta: { via: "web", action: { runId: run.id, name: run.actionName, status: updated!.status } },
    });
    await continueAgent(orgId, run.ticketId);
  }
  return {
    run: updated!,
    result: {
      ok: result.ok,
      status: null,
      output: result.output,
      error: result.error,
      durationMs: result.durationMs,
      request: { method: "MCP", url: `${tool.serverName}/${tool.name}` },
    } satisfies ActionResult,
  };
}

export async function rejectRun(orgId: string, runId: string, reviewer: { id: string; name: string }, note?: string) {
  const [run] = await db
    .select()
    .from(actionRuns)
    .where(and(eq(actionRuns.orgId, orgId), eq(actionRuns.id, runId)));
  if (!run) throw new Error("action run not found");
  if (run.status !== "pending_approval") throw new Error(`run is already ${run.status}`);
  const [updated] = await db
    .update(actionRuns)
    .set({
      status: "rejected",
      reviewedBy: reviewer.id,
      reviewedByName: reviewer.name,
      reviewedAt: new Date(),
      error: note ?? null,
      finishedAt: new Date(),
    })
    .where(eq(actionRuns.id, run.id))
    .returning();
  if (run.ticketId) {
    await addMessage(orgId, run.ticketId, {
      kind: "note",
      authorType: "agent",
      authorId: reviewer.id,
      authorName: reviewer.name,
      body: `**Rejected:** ${run.actionTitle} (${fmtInput(run.input)})${note ? ` — ${note}` : ""}`,
      meta: { via: "web", action: { runId: run.id, name: run.actionName, status: "rejected" } },
    });
    await continueAgent(orgId, run.ticketId);
  }
  return updated!;
}

/** Once no approvals are pending, re-run the agent so it can tell the customer what happened. */
async function continueAgent(orgId: string, ticketId: string) {
  const stillPending = await db
    .select({ id: actionRuns.id })
    .from(actionRuns)
    .where(and(eq(actionRuns.ticketId, ticketId), eq(actionRuns.status, "pending_approval")))
    .limit(1);
  if (stillPending.length) return;
  await db.update(tickets).set({ aiState: "processing" }).where(eq(tickets.id, ticketId));
  bus.publish({ type: "ai.state", orgId, ticketId, state: "processing" });
  const { enqueueAgent } = await import("../ai/queue.ts");
  enqueueAgent(orgId, ticketId, { force: true, immediate: true });
}
