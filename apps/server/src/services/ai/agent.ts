import type Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { drafts, tickets } from "../../db/schema.ts";
import { bus } from "../../lib/bus.ts";
import { id } from "../../lib/ids.ts";
import { truncate } from "../../lib/text.ts";
import type { AiSettings, SimulatedActionCall, Source } from "../../lib/types.ts";
import { executeAction, validateInput } from "../actions/executor.ts";
import { requestApproval, runActionNow } from "../actions/runs.ts";
import { type AgentToolset, loadToolset, toolsetPrompt } from "../actions/toolset.ts";
import { aiFieldSpecs, applyAiFields, classificationExamples, type FieldDef, getFields } from "../fields.ts";
import { APPROVAL_REASON, checkMcpInput, runMcpNow, spanName } from "../mcp/tools.ts";
import { hitToSource, searchKnowledge } from "../knowledge/search.ts";
import {
  addMessage,
  type Customer,
  getCustomer,
  getMessages,
  getTicket,
  type Message,
  type Ticket,
  updateTicket,
} from "../tickets.ts";
import { Trace } from "../tracer.ts";
import { getOrg, getSettings } from "../workspace.ts";
import { callClaude, type ClaudeHandle, describeError, getClaude } from "./client.ts";
import { heuristicAgent } from "./heuristic.ts";
import { bumpCitations, searchTickets, ticketResolution } from "./knowledge.ts";

export type Sources = Source[];

export interface AgentOutcome {
  kind: "reply" | "escalate";
  body: string;
  confidence: number;
  sources: Sources;
  resolves: boolean;
  reason?: string;
  internalNote?: string;
  triage?: Triage;
}

export interface Triage {
  priority?: Ticket["priority"];
  tags?: string[];
  intent?: string;
  language?: string;
  sentiment?: string;
  summary?: string;
  /** Ticket field values trace found (classification under "type"). */
  fields?: Record<string, unknown>;
}

export interface AgentContext {
  orgId: string;
  orgName: string;
  ai: AiSettings;
  ticket: Ticket;
  /** May be a synthetic (unsaved) customer in simulations — then `id` is empty. */
  customer?: Customer;
  history: Message[];
  ticketRef: string;
  toolset: AgentToolset;
  /** Ticket fields trace fills during triage, and recent human corrections of the classification. */
  fields: FieldDef[];
  fieldExamples: { subject: string; summary: string | null; value: string; was: string | null }[];
  /** Simulation: write actions are not executed and nothing is persisted. */
  dryRun: boolean;
}

export interface AgentRun {
  outcome: AgentOutcome;
  provider: "claude" | "local";
  actionCalls: SimulatedActionCall[];
  /** Approval requests created during this run (live mode only). */
  pendingApprovals: number;
}

export async function loadContext(orgId: string, ticketId: string): Promise<AgentContext | null> {
  const ticket = await getTicket(orgId, ticketId);
  if (!ticket) return null;
  const [settings, org, history, customer, toolset, defs, fieldExamples] = await Promise.all([
    getSettings(orgId),
    getOrg(orgId),
    getMessages(ticketId),
    getCustomer(ticket.customerId),
    loadToolset(orgId),
    getFields(orgId),
    classificationExamples(orgId),
  ]);
  return {
    orgId,
    orgName: org?.name ?? "the company",
    ai: settings.ai,
    ticket,
    customer,
    history,
    ticketRef: `${settings.ticketPrefix}-${ticket.number}`,
    toolset,
    fields: aiFieldSpecs(defs, customer?.attributes),
    fieldExamples,
    dryRun: false,
  };
}

export function transcript(history: Message[]) {
  return history
    .filter((m) => m.kind !== "event")
    .map((m) => {
      const who =
        m.authorType === "customer"
          ? `Customer (${m.authorName ?? "unknown"})`
          : m.kind === "note"
            ? `Internal note by ${m.authorType === "ai" ? "AI agent" : (m.authorName ?? "agent")}`
            : m.authorType === "ai"
              ? "AI agent"
              : `Support agent ${m.authorName ?? ""}`.trim();
      return `[${m.createdAt.toISOString()}] ${who}:\n${m.body}`;
    })
    .join("\n\n");
}

const toneGuide: Record<AiSettings["tone"], string> = {
  friendly: "Warm, human and direct. Contractions are fine. No corporate filler.",
  formal: "Polite and professional. Complete sentences, no slang.",
  concise: "Short and to the point. Lead with the answer; at most a few sentences.",
};

function systemPrompt(ctx: AgentContext) {
  const extra = toolsetPrompt(ctx.toolset);
  return `You are ${ctx.ai.agentName}, the AI support agent for ${ctx.orgName}, working inside the trace helpdesk.

Your job on each ticket: understand what the customer needs, gather evidence with your tools, take the actions a procedure calls for, and either submit a reply or hand the ticket to a human.

How to work:
1. Call update_ticket first with your triage: priority, a few lowercase tags, a short intent label (snake_case), the customer's language (ISO code), sentiment, and a one-sentence summary of the whole conversation so far.
2. Search the knowledge base and similar past tickets for anything relevant. Look up the customer profile when account details matter.
3. Finish by calling exactly one of submit_reply or escalate_to_human.

Rules for replies:
- Only state facts that are supported by the knowledge base, past resolutions, action results, the customer profile or the conversation. Never invent policies, prices, timelines or actions you did not take.
- Knowledge marked visibility="internal" (e.g. Jira issues, internal wiki pages) is context for you: use it to understand the situation, but never quote it, link it or reveal internal details to the customer.
- Reply in the customer's language. Address them by first name when known.
- Tone: ${toneGuide[ctx.ai.tone]}
- Plain text with light markdown (bold, lists, links) is fine. No subject line, no placeholders like [Name].
- Cite the ids of the knowledge documents or tickets you relied on in source_ids.
- confidence is your honest probability (0–1) that the reply fully and correctly resolves the request without a human. Use low values when information is missing.
- Escalate when the request needs something you cannot do with your tools, when policy is unclear, or when the customer is upset and asks for a person. When escalating, you may still include a suggested_reply for the human to review.
${extra ? `\n${extra}\n` : ""}${fieldsPrompt(ctx) ? `\n${fieldsPrompt(ctx)}\n` : ""}${ctx.ai.guidance.trim() ? `\nTeam guidance (follow it):\n${ctx.ai.guidance.trim()}\n` : ""}`;
}

/** JSON schema for one ticket field in update_ticket (null = not found in the conversation). */
function fieldSchema(f: FieldDef): Record<string, unknown> {
  const description = [f.label, f.aiInstruction.trim()].filter(Boolean).join(" — ");
  const opts = f.options.map((o) => o.value);
  switch (f.type) {
    case "select":
      return { type: ["string", "null"], enum: [...opts, null], description };
    case "multiselect":
      return { type: ["array", "null"], items: { type: "string", enum: opts }, description };
    case "number":
      return { type: ["number", "null"], description };
    case "checkbox":
      return { type: ["boolean", "null"], description };
    default:
      return { type: ["string", "null"], description };
  }
}

/** update_ticket with this workspace's fields added. */
function triageTool(ctx: AgentContext): Anthropic.Beta.BetaTool {
  const base = coreTools[0]!;
  if (!ctx.fields.length) return base;
  const schema = base.input_schema as { properties: Record<string, unknown>; required: string[] };
  return {
    ...base,
    description: `${base.description} Also fill the ticket fields from the conversation (null when unknown).`,
    input_schema: {
      ...schema,
      properties: {
        ...schema.properties,
        fields: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(ctx.fields.map((f) => [f.key, fieldSchema(f)])),
          required: ctx.fields.map((f) => f.key),
        },
      },
      required: [...schema.required, "fields"],
    } as Anthropic.Beta.BetaTool["input_schema"],
  };
}

function fieldsPrompt(ctx: AgentContext) {
  if (!ctx.fields.length) return "";
  const lines = [
    "Ticket fields: in update_ticket.fields, fill each field only from what the conversation, the customer profile or your tool results actually say; use null when you don't know. Never guess ids or versions.",
  ];
  if (ctx.fieldExamples.length)
    lines.push(
      `The team corrected these classifications recently — learn from them:\n${ctx.fieldExamples
        .map(
          (e) => `- "${e.subject}"${e.summary ? ` (${e.summary})` : ""} → ${e.value}${e.was ? ` (not ${e.was})` : ""}`,
        )
        .join("\n")}`,
    );
  return lines.join("\n");
}

const coreTools: Anthropic.Beta.BetaTool[] = [
  {
    name: "update_ticket",
    description:
      "Record triage for the ticket: priority, tags, intent, language, sentiment and a one-sentence summary. Call this first.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        tags: { type: "array", items: { type: "string" }, description: "1-4 short lowercase tags" },
        intent: { type: "string", description: "snake_case intent label, e.g. refund_duplicate" },
        language: { type: "string", description: "ISO 639-1 code of the customer's language" },
        sentiment: { type: "string", enum: ["positive", "neutral", "negative", "angry"] },
        summary: { type: "string", description: "One sentence summary of the conversation" },
      },
      required: ["priority", "tags", "intent", "language", "sentiment", "summary"],
    },
  },
  {
    name: "search_knowledge_base",
    description:
      "Semantic + keyword search over all connected knowledge: help-center articles, docs sites, Confluence, Notion, Zendesk, uploaded files and Jira issues. Works across languages. Returns the best passages with ids, origin and visibility.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string", description: "A natural-language question or keywords" } },
      required: ["query"],
    },
  },
  {
    name: "search_past_tickets",
    description: "Search previously handled tickets (any customer) for similar issues and how they were resolved.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "get_customer_profile",
    description: "Get the customer's profile, account attributes (plan, MRR, …) and their recent tickets.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: "submit_reply",
    description: "Submit the final reply to the customer. Ends your turn.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        body: { type: "string", description: "The reply text to send to the customer" },
        confidence: { type: "number", description: "0-1 probability this fully resolves the request" },
        source_ids: { type: "array", items: { type: "string" } },
        resolves_issue: { type: "boolean", description: "True if no further action is needed" },
      },
      required: ["body", "confidence", "source_ids", "resolves_issue"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand the ticket to a human agent. Ends your turn. Provide the reason, an internal note with what you found, and optionally a suggested reply.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string" },
        internal_note: { type: "string" },
        suggested_reply: { type: "string", description: "Draft reply for the human, or empty string" },
        source_ids: { type: "array", items: { type: "string" } },
      },
      required: ["reason", "internal_note", "suggested_reply", "source_ids"],
    },
  },
];

interface ToolRuntime {
  ctx: AgentContext;
  trace: Trace;
  seen: Map<string, Source>;
  triage?: Triage;
  actionCalls: SimulatedActionCall[];
  pendingApprovals: number;
}

export async function knowledgeToolResult(rt: Pick<ToolRuntime, "ctx" | "seen">, query: string) {
  const hits = await searchKnowledge(rt.ctx.orgId, query, { limit: 6 });
  if (!hits.length) return "No matching knowledge.";
  return hits
    .map((h) => {
      const src = hitToSource(h);
      rt.seen.set(src.id, src);
      const meta = h.origin === "jira" ? ` status="${String(h.metadata.status ?? "")}"` : "";
      return `<document id="${src.id}" title="${h.title}" origin="${h.origin}" visibility="${h.visibility}"${meta}>\n${truncate(h.content, 2200)}\n</document>`;
    })
    .join("\n");
}

async function runCoreTool(rt: ToolRuntime, name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "update_ticket": {
      rt.triage = input as Triage;
      return "Triage recorded.";
    }
    case "search_knowledge_base":
      return knowledgeToolResult(rt, String(input.query ?? ""));
    case "search_past_tickets": {
      const rows = await searchTickets(rt.ctx.orgId, String(input.query ?? ""), {
        excludeTicketId: rt.ctx.ticket.id,
        limit: 5,
      });
      if (!rows.length) return "No similar tickets.";
      const out: string[] = [];
      for (const r of rows) {
        const resolution = await ticketResolution(r.id);
        rt.seen.set(r.id, { type: "ticket", id: r.id, title: r.subject });
        out.push(
          `<ticket id="${r.id}" number="${r.number}" status="${r.status}" subject="${r.subject}">\nsummary: ${r.aiSummary ?? "n/a"}\nlast reply: ${resolution ?? "none"}\n</ticket>`,
        );
      }
      return out.join("\n");
    }
    case "get_customer_profile": {
      const c = rt.ctx.customer;
      if (!c) return "No customer profile (anonymous visitor).";
      const recent = c.id
        ? await db
            .select({
              number: tickets.number,
              subject: tickets.subject,
              status: tickets.status,
              createdAt: tickets.createdAt,
            })
            .from(tickets)
            .where(and(eq(tickets.customerId, c.id), ne(tickets.id, rt.ctx.ticket.id)))
            .orderBy(desc(tickets.createdAt))
            .limit(5)
        : [];
      return JSON.stringify({
        name: c.name,
        email: c.email,
        company: c.company,
        attributes: c.attributes,
        customer_since: c.createdAt,
        recent_tickets: recent,
      });
    }
    default:
      return `Unknown tool ${name}`;
  }
}

/** Execute (or simulate, or queue for approval) an action the model called. */
async function runActionTool(
  rt: ToolRuntime,
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError?: boolean }> {
  const action = rt.ctx.toolset.actions.get(name)!;
  const { reason, ...raw } = input;
  const ctx = rt.ctx;
  // Validate up front: a malformed call goes back to the model, never to a human approver.
  let params: Record<string, unknown>;
  try {
    params = validateInput(action.parameters, raw);
  } catch (err) {
    await rt.trace.event(`action.${name}`, "integration", `rejected input: ${(err as Error).message}`, { input: raw });
    return {
      content: `Invalid input for ${name}: ${(err as Error).message}. Fix the arguments and call it again.`,
      isError: true,
    };
  }

  if (ctx.dryRun) {
    if (action.readOnly) {
      const span = rt.trace.start(`action.${name}`, "integration");
      const res = await executeAction(action, params, { orgId: ctx.orgId, ticket: ctx.ticket, customer: ctx.customer });
      await span.end({
        status: res.ok ? "ok" : "error",
        summary: res.ok ? `read-only · ${res.status}` : res.error,
        attributes: { input: params, output: truncate(res.output, 1500) },
      });
      rt.actionCalls.push({ name, input: params, mode: "executed", output: res.ok ? res.output : res.error });
      return res.ok
        ? { content: res.output || "(empty response)" }
        : { content: `Action failed: ${res.error}\n${res.output}`, isError: true };
    }
    const mode = action.requiresApproval ? "approval" : "simulated";
    rt.actionCalls.push({ name, input: params, mode });
    await rt.trace.event(
      `action.${name}`,
      "integration",
      mode === "approval" ? "simulation · would wait for human approval" : "simulation · not executed",
      { input: params },
    );
    return {
      content:
        mode === "approval"
          ? "SIMULATION: in production this action would now wait for a human to approve it. It has not run. Finish the turn as you would after requesting approval."
          : "SIMULATION: the action was not executed. Assume it succeeded with a typical response and continue.",
    };
  }

  if (action.requiresApproval) {
    const run = await requestApproval({
      orgId: ctx.orgId,
      ticketId: ctx.ticket.id,
      action,
      input: { ...params, reason: String(reason ?? "") },
      reason: String(reason ?? ""),
      traceId: rt.trace.id,
      agentName: ctx.ai.agentName,
    });
    rt.pendingApprovals++;
    rt.actionCalls.push({ name, input: params, mode: "approval" });
    await rt.trace.event(`action.${name}`, "integration", "queued for human approval", {
      input: params,
      runId: run.id,
    });
    return {
      content: `Queued for human approval (run ${run.id}). It has NOT been executed. Do not tell the customer it is done. Finish now with escalate_to_human describing what you requested; you'll be run again with the result.`,
    };
  }

  const res = await runActionNow({ orgId: ctx.orgId, ticketId: ctx.ticket.id, action, input: params, trace: rt.trace });
  rt.actionCalls.push({
    name,
    input: params,
    mode: "executed",
    output: res.ok ? truncate(res.output, 500) : res.error,
  });
  return res.ok
    ? { content: res.output || `(HTTP ${res.status}, empty response)` }
    : { content: `Action failed: ${res.error}${res.output ? `\n${res.output}` : ""}`, isError: true };
}

/** Call (or simulate, or queue for approval) a tool from a connected MCP server. */
async function runMcpTool(
  rt: ToolRuntime,
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError?: boolean }> {
  const tool = rt.ctx.toolset.mcp.get(name)!;
  const { [APPROVAL_REASON]: reason, ...args } = input;
  const ctx = rt.ctx;
  try {
    checkMcpInput(tool, args);
  } catch (err) {
    await rt.trace.event(spanName(tool), "integration", `rejected input: ${(err as Error).message}`, { input: args });
    return {
      content: `Invalid input for ${name}: ${(err as Error).message}. Fix the arguments and call it again.`,
      isError: true,
    };
  }

  if (ctx.dryRun && !tool.readOnly) {
    const mode = tool.requiresApproval ? "approval" : "simulated";
    rt.actionCalls.push({ name, input: args, mode });
    await rt.trace.event(
      spanName(tool),
      "integration",
      mode === "approval" ? "simulation · would wait for human approval" : "simulation · not executed",
      { input: args },
    );
    return {
      content:
        mode === "approval"
          ? "SIMULATION: in production this call would now wait for a human to approve it. It has not run. Finish the turn as you would after requesting approval."
          : "SIMULATION: the call was not executed. Assume it succeeded with a typical response and continue.",
    };
  }

  if (!ctx.dryRun && tool.requiresApproval) {
    const run = await requestApproval({
      orgId: ctx.orgId,
      ticketId: ctx.ticket.id,
      action: { id: null, name, title: `${tool.serverName}: ${tool.title ?? tool.name}` },
      mcpToolId: tool.id,
      input: args,
      reason: typeof reason === "string" ? reason : "",
      traceId: rt.trace.id,
      agentName: ctx.ai.agentName,
    });
    rt.pendingApprovals++;
    rt.actionCalls.push({ name, input: args, mode: "approval" });
    await rt.trace.event(spanName(tool), "integration", "queued for human approval", { input: args, runId: run.id });
    return {
      content: `Queued for human approval (run ${run.id}). It has NOT been executed. Do not tell the customer it is done. Finish now with escalate_to_human describing what you requested; you'll be run again with the result.`,
    };
  }

  // Read-only calls run in simulations too (against the real server); nothing is recorded on a ticket then.
  const res = await runMcpNow({
    orgId: ctx.orgId,
    ticketId: ctx.dryRun ? null : ctx.ticket.id,
    tool,
    input: args,
    trace: rt.trace,
  });
  rt.actionCalls.push({ name, input: args, mode: "executed", output: res.ok ? truncate(res.output, 500) : res.error });
  return res.ok
    ? { content: res.output || "(empty result)" }
    : { content: `Tool failed: ${res.error}${res.output ? `\n${res.output}` : ""}`, isError: true };
}

async function claudeAgent(h: ClaudeHandle, ctx: AgentContext, trace: Trace): Promise<AgentRun> {
  const rt: ToolRuntime = { ctx, trace, seen: new Map(), actionCalls: [], pendingApprovals: 0 };
  const done = (outcome: AgentOutcome): AgentRun => ({
    outcome,
    provider: "claude",
    actionCalls: rt.actionCalls,
    pendingApprovals: rt.pendingApprovals,
  });
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `Ticket ${ctx.ticketRef} — "${ctx.ticket.subject}" (channel: ${ctx.ticket.channel}, current priority: ${ctx.ticket.priority}, tags: ${ctx.ticket.tags.join(", ") || "none"})
Customer: ${ctx.customer ? `${ctx.customer.name ?? ""} <${ctx.customer.email ?? "no email"}>` : "anonymous visitor"}

Conversation so far:
${transcript(ctx.history)}

Handle the latest customer message${ctx.history.some((m) => m.meta.action) ? " (internal notes show the results of actions humans approved or rejected — use them)" : ""}.`,
    },
  ];
  const system = systemPrompt(ctx);
  const tools = [triageTool(ctx), ...coreTools.slice(1), ...ctx.toolset.tools];

  for (let turn = 0; turn < 10; turn++) {
    const span = trace.start("model.turn", "ai");
    const response = await callClaude(h, { max_tokens: 16000, system, tools, messages }).catch(async (err) => {
      await span.end({ status: "error", summary: describeError(err) });
      throw err;
    });
    await span.end({
      summary: `${response.model} · ${response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0)} in / ${response.usage.output_tokens} out`,
      attributes: {
        model: response.model,
        stop_reason: response.stop_reason,
        input_tokens: response.usage.input_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    });

    if (response.stop_reason === "refusal") {
      return done({
        kind: "escalate",
        body: "",
        confidence: 0,
        sources: [],
        resolves: false,
        reason: "The model declined to handle this request.",
        triage: rt.triage,
      });
    }
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "pause_turn") continue;

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!toolUses.length) {
      // Plain text without a finishing tool — treat as a low-confidence draft.
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      return done({ kind: "reply", body: text, confidence: 0.3, sources: [], resolves: false, triage: rt.triage });
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    let finished: AgentOutcome | null = null;
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      if (tu.name === "submit_reply" || tu.name === "escalate_to_human") {
        const ids = (input.source_ids as string[]) ?? [];
        const sources = ids.map((i) => rt.seen.get(i)).filter((s): s is Source => !!s);
        if (tu.name === "submit_reply") {
          await trace.event(
            "reply.compose",
            "ai",
            `${ids.length} sources cited · confidence ${Number(input.confidence).toFixed(2)}`,
            { confidence: input.confidence },
          );
          finished = {
            kind: "reply",
            body: String(input.body ?? "").trim(),
            confidence: Math.max(0, Math.min(1, Number(input.confidence ?? 0))),
            sources,
            resolves: Boolean(input.resolves_issue),
            triage: rt.triage,
          };
        } else {
          finished = {
            kind: "escalate",
            body: String(input.suggested_reply ?? "").trim(),
            confidence: 0,
            sources,
            resolves: false,
            reason: String(input.reason ?? ""),
            internalNote: String(input.internal_note ?? ""),
            triage: rt.triage,
          };
        }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: "Done." });
        continue;
      }
      if (rt.ctx.toolset.actions.has(tu.name)) {
        const r = await runActionTool(rt, tu.name, input);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, is_error: r.isError });
        continue;
      }
      if (rt.ctx.toolset.mcp.has(tu.name)) {
        const r = await runMcpTool(rt, tu.name, input);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, is_error: r.isError });
        continue;
      }
      const toolSpan = trace.start(`tool.${tu.name}`, "tool");
      try {
        const out = await runCoreTool(rt, tu.name, input);
        await toolSpan.end({
          summary:
            tu.name === "update_ticket"
              ? `${rt.triage?.intent} · ${rt.triage?.language} · ${rt.triage?.priority}`
              : truncate(String(input.query ?? out.split("\n")[0] ?? ""), 120),
          attributes: { input, result_chars: out.length },
        });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      } catch (err) {
        await toolSpan.end({ status: "error", summary: String(err) });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: `Error: ${String(err)}`, is_error: true });
      }
    }
    if (finished) return done(finished);
    messages.push({ role: "user", content: results });
  }
  return done({
    kind: "escalate",
    body: "",
    confidence: 0,
    sources: [],
    resolves: false,
    reason: "The agent ran out of steps.",
    triage: rt.triage,
  });
}

/** Run the agent's reasoning for a context (live or simulated). Falls back to local heuristics. */
export async function runAgentCore(ctx: AgentContext, trace: Trace): Promise<AgentRun> {
  const claude = getClaude(ctx.ai);
  if (claude) {
    try {
      return await claudeAgent(claude, ctx, trace);
    } catch (err) {
      await trace.event("agent.error", "ai", describeError(err));
      console.error("[ai] agent failed, falling back to heuristics:", describeError(err));
    }
  }
  const outcome = await heuristicAgent(ctx.orgId, ctx, trace);
  return { outcome, provider: "local", actionCalls: [], pendingApprovals: 0 };
}

export function policyAllowsAutoSend(ctx: AgentContext, outcome: AgentOutcome) {
  const ai = ctx.ai;
  const isWidget = ctx.ticket.channel === "widget";
  const instant = isWidget && ai.widgetInstantAnswers;
  if (outcome.kind === "escalate") return { ok: false, why: `escalated: ${outcome.reason ?? "needs a human"}` };
  if (ai.mode !== "auto" && !instant) return { ok: false, why: "mode is draft — a human approves every reply" };
  if (outcome.confidence < ai.autoSendThreshold) {
    return { ok: false, why: `confidence ${outcome.confidence.toFixed(2)} < threshold ${ai.autoSendThreshold}` };
  }
  const lastCustomer = [...ctx.history].reverse().find((m) => m.authorType === "customer")?.body ?? "";
  const hay =
    `${ctx.ticket.subject} ${lastCustomer} ${outcome.triage?.intent ?? ""} ${(outcome.triage?.tags ?? []).join(" ")}`.toLowerCase();
  const hit = ai.neverAutoSend.find((t) => t.trim() && hay.includes(t.trim().toLowerCase()));
  if (hit) return { ok: false, why: `"${hit}" is on the never-auto-send list` };
  return { ok: true, why: instant && ai.mode !== "auto" ? "widget instant answer" : "confident and within policy" };
}

const running = new Set<string>();

/** Run the AI agent on a ticket: triage, research, act, then reply or draft or escalate. */
export async function runTicketAgent(orgId: string, ticketId: string, opts: { force?: boolean } = {}) {
  if (running.has(ticketId)) return;
  running.add(ticketId);
  const trace = new Trace(orgId, ticketId);
  try {
    const ctx = await loadContext(orgId, ticketId);
    if (!ctx || !ctx.ai.enabled) return;
    const last = ctx.history.filter((m) => m.kind === "message").at(-1);
    if (!opts.force && last?.authorType !== "customer") return;

    await setAiState(orgId, ticketId, "processing");
    await trace.event("message.received", "system", `${ctx.ticket.channel} · ${ctx.customer?.email ?? "anonymous"}`, {
      channel: ctx.ticket.channel,
    });

    const { outcome, pendingApprovals } = await runAgentCore(ctx, trace);

    // Apply triage.
    if (outcome.triage && ctx.ai.autoTriage) {
      const t = outcome.triage;
      await db
        .update(tickets)
        .set({
          aiIntent: t.intent ?? ctx.ticket.aiIntent,
          aiLanguage: t.language ?? ctx.ticket.aiLanguage,
          aiSentiment: t.sentiment ?? ctx.ticket.aiSentiment,
          aiSummary: t.summary ?? ctx.ticket.aiSummary,
        })
        .where(eq(tickets.id, ticketId));
      const tags = [...new Set([...ctx.ticket.tags, ...(t.tags ?? []).map((x) => x.toLowerCase())])].slice(0, 6);
      await updateTicket(
        orgId,
        ticketId,
        { priority: t.priority && rank(t.priority) > rank(ctx.ticket.priority) ? t.priority : undefined, tags },
        { type: "ai", name: ctx.ai.agentName },
      );
      await trace.event("triage.apply", "system", `${t.intent ?? "?"} · ${t.language ?? "?"} · ${t.priority ?? "?"}`, {
        ...t,
      });
      if (t.fields && Object.keys(t.fields).length) {
        const set = await applyAiFields(orgId, ticketId, t.fields);
        if (Object.keys(set).length)
          await trace.event(
            "fields.apply",
            "system",
            Object.entries(set)
              .map(([k, v]) => `${k}: ${Array.isArray(v.value) ? v.value.join(", ") : String(v.value)}`)
              .join(" · "),
            { fields: set },
          );
      }
    }

    // Actions are waiting for a human: park the ticket until they decide (the agent re-runs afterwards).
    if (pendingApprovals > 0) {
      if (outcome.internalNote?.trim()) {
        await addMessage(orgId, ticketId, {
          kind: "note",
          authorType: "ai",
          authorName: ctx.ai.agentName,
          body: outcome.internalNote,
          meta: { sources: outcome.sources, via: "ai" },
        });
      }
      if (ctx.ticket.channel === "widget") await widgetHoldingMessage(orgId, ctx);
      await db
        .update(tickets)
        .set({ aiState: "awaiting_approval", aiConfidence: null })
        .where(eq(tickets.id, ticketId));
      await trace.event(
        "policy.check",
        "system",
        `hold: ${pendingApprovals} action${pendingApprovals === 1 ? "" : "s"} awaiting human approval`,
      );
      bus.publish({ type: "ticket.escalated", orgId, ticketId, reason: "an action needs approval" });
      bus.publish({ type: "ai.state", orgId, ticketId, state: "awaiting_approval" });
      return;
    }

    if (outcome.kind === "escalate") {
      const note = [outcome.reason && `**Escalated:** ${outcome.reason}`, outcome.internalNote]
        .filter(Boolean)
        .join("\n\n");
      await addMessage(orgId, ticketId, {
        kind: "note",
        authorType: "ai",
        authorName: ctx.ai.agentName,
        body: note || "Escalated to a human.",
        meta: { sources: outcome.sources, via: "ai" },
      });
      if (ctx.ticket.channel === "widget") await widgetHoldingMessage(orgId, ctx);
      if (outcome.body) await createDraft(orgId, ticketId, outcome, trace.id);
      await db.update(tickets).set({ aiState: "escalated", aiConfidence: 0 }).where(eq(tickets.id, ticketId));
      await trace.event("ticket.escalate", "system", outcome.reason ?? "needs a human");
      bus.publish({ type: "ticket.escalated", orgId, ticketId, reason: outcome.reason ?? "" });
      bus.publish({ type: "ai.state", orgId, ticketId, state: "escalated" });
      return;
    }

    if (!outcome.body) {
      await setAiState(orgId, ticketId, "none");
      return;
    }

    const policy = policyAllowsAutoSend(ctx, outcome);
    await trace.event(
      "policy.check",
      "system",
      policy.ok ? `auto-send: ${policy.why}` : `hold for review: ${policy.why}`,
      {
        allowed: policy.ok,
      },
    );

    if (policy.ok) {
      await trace.span(
        "reply.send",
        "integration",
        () =>
          addMessage(orgId, ticketId, {
            authorType: "ai",
            authorName: ctx.ai.agentName,
            body: outcome.body,
            meta: { sources: outcome.sources, via: "ai" },
          }),
        () => ({ summary: `delivered via ${ctx.ticket.channel}` }),
      );
      await bumpCitations(outcome.sources.filter((s) => s.type === "article").map((s) => s.id));
      await db
        .update(tickets)
        .set({ aiState: "auto_replied", aiConfidence: outcome.confidence })
        .where(eq(tickets.id, ticketId));
      bus.publish({ type: "ai.state", orgId, ticketId, state: "auto_replied" });
    } else {
      if (ctx.ticket.channel === "widget") await widgetHoldingMessage(orgId, ctx);
      await createDraft(orgId, ticketId, outcome, trace.id);
    }
  } catch (err) {
    console.error("[ai] runTicketAgent failed", err);
    await trace.event("agent.error", "system", describeError(err)).catch(() => {});
    await setAiState(orgId, ticketId, "error").catch(() => {});
  } finally {
    running.delete(ticketId);
  }
}

const rank = (p: Ticket["priority"]) => ["low", "normal", "high", "urgent"].indexOf(p);

async function setAiState(orgId: string, ticketId: string, state: Ticket["aiState"]) {
  await db.update(tickets).set({ aiState: state }).where(eq(tickets.id, ticketId));
  bus.publish({ type: "ai.state", orgId, ticketId, state });
}

async function createDraft(orgId: string, ticketId: string, outcome: AgentOutcome, traceId: string) {
  await db
    .update(drafts)
    .set({ status: "superseded" })
    .where(and(eq(drafts.ticketId, ticketId), eq(drafts.status, "pending")));
  const draftId = id("drf");
  await db.insert(drafts).values({
    id: draftId,
    orgId,
    ticketId,
    body: outcome.body,
    confidence: outcome.confidence,
    sources: outcome.sources,
    reasoning: outcome.reason ?? null,
    traceId,
  });
  await db
    .update(tickets)
    .set({ aiState: outcome.kind === "escalate" ? "escalated" : "draft_ready", aiConfidence: outcome.confidence })
    .where(eq(tickets.id, ticketId));
  bus.publish({ type: "draft.ready", orgId, ticketId, draftId });
  bus.publish({ type: "ai.state", orgId, ticketId, state: "draft_ready" });
}

/** Widget visitors expect an immediate response; tell them a human is on it (once per ticket). */
async function widgetHoldingMessage(orgId: string, ctx: AgentContext) {
  if (!ctx.ai.widgetInstantAnswers) return;
  const already = ctx.history.some((m) => m.authorType === "ai" && m.kind === "message");
  if (already) return;
  await addMessage(orgId, ctx.ticket.id, {
    authorType: "ai",
    authorName: ctx.ai.agentName,
    body: "Thanks for the details — I've passed this to the team and a human will follow up here shortly.",
    meta: { via: "ai" },
    status: "open",
  });
}
