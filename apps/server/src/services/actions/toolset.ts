import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { actions, procedures } from "../../db/schema.ts";
import { type AgentMcpTool, loadMcpToolset, mcpAgentTool, mcpPrompt } from "../mcp/tools.ts";
import type { Action } from "./executor.ts";

export type Procedure = typeof procedures.$inferSelect;

/** Names the built-in agent tools use; actions can't shadow them. */
export const RESERVED_TOOL_NAMES = new Set([
  "update_ticket",
  "search_knowledge_base",
  "search_past_tickets",
  "get_customer_profile",
  "submit_reply",
  "escalate_to_human",
]);

export const ACTION_NAME_RE = /^[a-z][a-z0-9_]{1,48}$/;

export interface AgentToolset {
  actions: Map<string, Action>;
  procedures: Procedure[];
  /** Tools from connected MCP servers, by the name the model sees. */
  mcp: Map<string, AgentMcpTool>;
  mcpPrompt: string;
  tools: Anthropic.Beta.BetaTool[];
}

export function actionTool(a: Action): Anthropic.Beta.BetaTool {
  const properties: Record<string, unknown> = {};
  for (const p of a.parameters) {
    properties[p.name] = {
      type: p.type,
      description: p.description,
      ...(p.enum?.length ? { enum: p.enum } : {}),
    };
  }
  const required = a.parameters.filter((p) => p.required).map((p) => p.name);
  if (a.requiresApproval) {
    properties.reason = {
      type: "string",
      description: "Why this action is needed for this customer — shown to the human who approves it.",
    };
    required.push("reason");
  }
  const flags = [
    a.requiresApproval ? "needs human approval before it runs" : null,
    a.readOnly ? "read-only" : "changes data",
  ]
    .filter(Boolean)
    .join(", ");
  return {
    name: a.name,
    description: `${a.title}: ${a.description} (${flags})`,
    input_schema: { type: "object", properties, required },
  };
}

/** Enabled actions (as tools) and procedures for a workspace. */
export async function loadToolset(orgId: string): Promise<AgentToolset> {
  const [acts, procs, mcpSet] = await Promise.all([
    db
      .select()
      .from(actions)
      .where(and(eq(actions.orgId, orgId), eq(actions.enabled, true)))
      .orderBy(asc(actions.name)),
    db
      .select()
      .from(procedures)
      .where(and(eq(procedures.orgId, orgId), eq(procedures.enabled, true)))
      .orderBy(asc(procedures.position), asc(procedures.createdAt)),
    loadMcpToolset(orgId),
  ]);
  const usable = acts.filter((a) => ACTION_NAME_RE.test(a.name) && !RESERVED_TOOL_NAMES.has(a.name));
  const actionNames = new Set(usable.map((a) => a.name));
  for (const name of mcpSet.tools.keys())
    if (actionNames.has(name) || RESERVED_TOOL_NAMES.has(name)) mcpSet.tools.delete(name);
  return {
    actions: new Map(usable.map((a) => [a.name, a])),
    procedures: procs,
    mcp: mcpSet.tools,
    mcpPrompt: mcpPrompt(mcpSet),
    tools: [...usable.map(actionTool), ...[...mcpSet.tools.values()].map(mcpAgentTool)],
  };
}

/** Procedures and action guidance appended to the agent's system prompt. */
export function toolsetPrompt(ts: AgentToolset) {
  const parts: string[] = [];
  if (ts.actions.size) {
    parts.push(`Actions:
You also have action tools that call ${"real"} systems (billing, orders, issue trackers). Use them when a procedure or the request clearly needs them, and pass exactly the values you know — never guess ids.
- Read-only actions run immediately; use their results as evidence.
- Actions that need approval are queued for a human. After requesting one, do not claim it has happened. Finish the turn with escalate_to_human, explaining what you requested and why; you will be run again with the result once a human decides.
- If an action fails, don't retry more than once; escalate with what you found.`);
  }
  if (ts.mcpPrompt) parts.push(ts.mcpPrompt);
  if (ts.procedures.length) {
    parts.push(
      `Procedures (when one matches the request, follow its steps in order):\n${ts.procedures
        .map((p) => `<procedure name="${p.name}">\nWhen: ${p.trigger}\n${p.instructions.trim()}\n</procedure>`)
        .join("\n")}`,
    );
  }
  return parts.join("\n\n");
}
