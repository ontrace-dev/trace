import type Anthropic from "@anthropic-ai/sdk";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { customers, tickets } from "../../db/schema.ts";
import { truncate } from "../../lib/text.ts";
import { getMessages, getTicketByNumber } from "../tickets.ts";
import { getOrg, getSettings } from "../workspace.ts";
import { loadContext, type Sources, transcript } from "./agent.ts";
import { callClaude, getClaude, textOf } from "./client.ts";
import { hitToSource, searchKnowledge } from "../knowledge/search.ts";
import { searchTickets } from "./knowledge.ts";

export interface AskResult {
  answer: string;
  sources: Sources;
  offline: boolean;
}

const askTools: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_knowledge_base",
    description:
      "Search all knowledge: help articles, docs sites, Confluence, Notion, Zendesk, files and Jira issues (semantic, multilingual).",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "search_tickets",
    description: "Search tickets by keywords. Returns number, subject, status, summary.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "get_ticket",
    description: "Read the full conversation of a ticket by its number (e.g. 4821).",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { number: { type: "integer" } },
      required: ["number"],
    },
  },
  {
    name: "queue_stats",
    description: "Current counts of tickets by status and AI state, plus the oldest open tickets.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
  },
];

async function queueStats(orgId: string) {
  const byStatus = await db
    .select({ status: tickets.status, n: count() })
    .from(tickets)
    .where(eq(tickets.orgId, orgId))
    .groupBy(tickets.status);
  const byAi = await db
    .select({ state: tickets.aiState, n: count() })
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), inArray(tickets.status, ["open", "pending"])))
    .groupBy(tickets.aiState);
  const oldest = await db
    .select({
      number: tickets.number,
      subject: tickets.subject,
      createdAt: tickets.createdAt,
      priority: tickets.priority,
    })
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), eq(tickets.status, "open")))
    .orderBy(tickets.createdAt)
    .limit(5);
  return { byStatus, openByAiState: byAi, oldestOpen: oldest };
}

/** "Ask trace anything" — answers questions about the workspace's tickets and knowledge. */
export async function askWorkspace(orgId: string, question: string): Promise<AskResult> {
  const settings = await getSettings(orgId);
  const org = await getOrg(orgId);
  const claude = getClaude(settings.ai);
  const seen = new Map<string, Sources[number]>();

  if (!claude) {
    const [arts, tks] = await Promise.all([
      searchKnowledge(orgId, question, { limit: 4 }),
      searchTickets(orgId, question, { limit: 5 }),
    ]);
    const lines = [
      "AI is running in offline mode (no ANTHROPIC_API_KEY), so here are the closest matches:",
      ...arts.map((a) => `- ${a.origin === "article" ? "Article" : a.origin}: **${a.title}**`),
      ...tks.map((t) => `- ${settings.ticketPrefix}-${t.number}: ${t.subject} (${t.status})`),
    ];
    if (!arts.length && !tks.length) lines.push("- Nothing matched your question.");
    return {
      answer: lines.join("\n"),
      sources: [...arts.map(hitToSource), ...tks.map((t) => ({ type: "ticket" as const, id: t.id, title: t.subject }))],
      offline: true,
    };
  }

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: question }];
  const system = `You are ${settings.ai.agentName}, the AI copilot inside the trace helpdesk for ${org?.name ?? "this team"}. Support agents ask you questions about their queue, customers, past tickets and the knowledge base. Use your tools to look things up before answering; never guess ticket contents. Ticket references look like ${settings.ticketPrefix}-123. Be concise and use markdown lists where useful.`;
  for (let turn = 0; turn < 6; turn++) {
    const res = await callClaude(claude, { max_tokens: 8000, system, tools: askTools, messages });
    if (res.stop_reason === "refusal")
      return { answer: "I can't help with that request.", sources: [], offline: false };
    messages.push({ role: "assistant", content: res.content });
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!uses.length && res.stop_reason !== "pause_turn") {
      return { answer: textOf(res), sources: [...seen.values()], offline: false };
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      const input = u.input as Record<string, unknown>;
      let out = "";
      if (u.name === "search_knowledge_base") {
        const rows = await searchKnowledge(orgId, String(input.query), { limit: 6 });
        out =
          rows
            .map((r) => {
              const src = hitToSource(r);
              seen.set(src.id, src);
              return `<document id="${src.id}" title="${r.title}" origin="${r.origin}" visibility="${r.visibility}"${r.url ? ` url="${r.url}"` : ""}>${truncate(r.content, 1500)}</document>`;
            })
            .join("\n") || "No results.";
      } else if (u.name === "search_tickets") {
        const rows = await searchTickets(orgId, String(input.query), { limit: 8 });
        rows.forEach((r) => seen.set(r.id, { type: "ticket", id: r.id, title: r.subject }));
        out = JSON.stringify(
          rows.map((r) => ({
            number: r.number,
            subject: r.subject,
            status: r.status,
            customer: r.customerName,
            summary: r.aiSummary,
            created: r.createdAt,
          })),
        );
      } else if (u.name === "get_ticket") {
        const t = await getTicketByNumber(orgId, Number(input.number));
        if (!t) out = "Ticket not found.";
        else {
          seen.set(t.id, { type: "ticket", id: t.id, title: t.subject });
          const history = await getMessages(t.id);
          out = `Ticket ${settings.ticketPrefix}-${t.number} "${t.subject}" status=${t.status} priority=${t.priority} tags=${t.tags.join(",")}\n\n${truncate(transcript(history), 12000)}`;
        }
      } else if (u.name === "queue_stats") {
        out = JSON.stringify(await queueStats(orgId));
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content: out });
    }
    if (results.length) messages.push({ role: "user", content: results });
  }
  return {
    answer: "I couldn't finish looking that up — try a more specific question.",
    sources: [...seen.values()],
    offline: false,
  };
}

export type RewriteMode = "improve" | "shorten" | "friendlier" | "formal" | "translate" | "fix";

const rewriteInstructions: Record<RewriteMode, string> = {
  improve: "Improve clarity and flow while keeping the meaning and all facts.",
  shorten: "Make it noticeably shorter without losing any facts or commitments.",
  friendlier: "Make the tone warmer and more human, without adding new claims.",
  formal: "Make the tone more formal and professional.",
  translate: "Translate it into the target language, keeping tone and formatting.",
  fix: "Fix spelling and grammar only.",
};

export async function rewriteText(orgId: string, text: string, mode: RewriteMode, language?: string) {
  const settings = await getSettings(orgId);
  const claude = getClaude(settings.ai);
  if (!claude) return { text, offline: true };
  const res = await callClaude(claude, {
    max_tokens: 4000,
    system:
      "You rewrite customer-support replies. Output only the rewritten reply text — no preamble, no quotes, no explanations.",
    messages: [
      {
        role: "user",
        content: `${rewriteInstructions[mode]}${mode === "translate" ? ` Target language: ${language ?? "English"}.` : ""}\n\n<reply>\n${text}\n</reply>`,
      },
    ],
  });
  return { text: textOf(res) || text, offline: false };
}

export async function summarizeTicket(orgId: string, ticketId: string) {
  const ctx = await loadContext(orgId, ticketId);
  if (!ctx) throw new Error("ticket not found");
  const claude = getClaude(ctx.ai);
  if (!claude) {
    const first = ctx.history.find((m) => m.authorType === "customer");
    return { summary: truncate(first?.body.replace(/\s+/g, " ") ?? ctx.ticket.subject, 200), offline: true };
  }
  const res = await callClaude(claude, {
    max_tokens: 2000,
    system:
      "Summarize support conversations for a busy agent: 2-4 short bullet points covering the problem, what has been tried, and what is pending. Output only the bullets.",
    messages: [{ role: "user", content: `Ticket "${ctx.ticket.subject}"\n\n${transcript(ctx.history)}` }],
  });
  const summary = textOf(res);
  await db
    .update(tickets)
    .set({ aiSummary: summary.split("\n")[0]?.replace(/^[-*]\s*/, "") ?? summary })
    .where(eq(tickets.id, ticketId));
  return { summary, offline: false };
}

/** Turn a resolved ticket into a draft help-center article ("knowledge that writes itself"). */
export async function articleFromTicket(orgId: string, ticketId: string) {
  const ctx = await loadContext(orgId, ticketId);
  if (!ctx) throw new Error("ticket not found");
  const claude = getClaude(ctx.ai);
  if (!claude) {
    const q = ctx.history.find((m) => m.authorType === "customer")?.body ?? "";
    const a = [...ctx.history].reverse().find((m) => m.kind === "message" && m.authorType !== "customer")?.body ?? "";
    return {
      title: ctx.ticket.subject,
      body: `## The problem\n\n${q}\n\n## The answer\n\n${a}`,
      offline: true,
    };
  }
  const res = await callClaude(claude, {
    max_tokens: 6000,
    system:
      "You turn resolved support conversations into reusable help-center articles. Remove all customer-specific data (names, emails, ids, amounts). Write in markdown with short sections.",
    messages: [{ role: "user", content: `Ticket "${ctx.ticket.subject}"\n\n${transcript(ctx.history)}` }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            body: { type: "string", description: "Markdown article body" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["title", "body", "tags"],
        },
      },
    },
  });
  const parsed = JSON.parse(textOf(res)) as { title: string; body: string; tags: string[] };
  return { ...parsed, offline: false };
}

export async function customerCount(orgId: string) {
  const [r] = await db.select({ n: count() }).from(customers).where(eq(customers.orgId, orgId));
  return r?.n ?? 0;
}

export async function recentTicketsForCustomer(customerId: string) {
  return db
    .select({
      id: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      status: tickets.status,
      createdAt: tickets.createdAt,
    })
    .from(tickets)
    .where(eq(tickets.customerId, customerId))
    .orderBy(desc(tickets.createdAt))
    .limit(10);
}
