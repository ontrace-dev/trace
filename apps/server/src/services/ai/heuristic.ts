import { heuristicFields } from "../fields.ts";
import { truncate } from "../../lib/text.ts";
import type { Trace } from "../tracer.ts";
import type { AgentContext, AgentOutcome, Triage } from "./agent.ts";
import { hitToSource, searchKnowledge } from "../knowledge/search.ts";
import { searchTickets } from "./knowledge.ts";

/**
 * Offline agent used when no Anthropic key is configured. It is intentionally conservative:
 * it triages with keyword rules, finds the best article and drafts a reply for a human —
 * it never claims high confidence, so it never auto-sends.
 */

const INTENTS: { intent: string; tags: string[]; words: string[]; priority?: Triage["priority"] }[] = [
  {
    intent: "billing_issue",
    tags: ["billing"],
    words: ["invoice", "charged", "charge", "refund", "payment", "billing", "receipt", "vat", "card"],
  },
  {
    intent: "login_issue",
    tags: ["auth"],
    words: ["login", "log in", "password", "sso", "2fa", "sign in", "locked", "reset"],
  },
  {
    intent: "bug_report",
    tags: ["bug"],
    words: ["error", "broken", "bug", "crash", "500", "429", "blank page", "not working", "fails"],
  },
  {
    intent: "outage",
    tags: ["outage"],
    words: ["down", "outage", "unavailable", "cannot access", "everyone"],
    priority: "urgent",
  },
  { intent: "data_export", tags: ["data"], words: ["export", "import", "csv", "download", "backup"] },
  {
    intent: "sales_question",
    tags: ["sales"],
    words: ["pricing", "plan", "seats", "upgrade", "quote", "trial", "discount"],
  },
  {
    intent: "security_question",
    tags: ["trust"],
    words: ["soc 2", "soc2", "gdpr", "dpa", "security", "pen test", "compliance"],
  },
  {
    intent: "feature_request",
    tags: ["feature"],
    words: ["feature", "would be great", "could you add", "roadmap", "request"],
  },
];

const LANGS: { code: string; words: string[] }[] = [
  { code: "de", words: ["ich", "nicht", "und", "bitte", "danke", "wir", "ist", "das", "rechnung"] },
  { code: "fr", words: ["je", "pas", "merci", "nous", "est", "le", "la", "facture", "bonjour"] },
  { code: "es", words: ["hola", "gracias", "no", "es", "factura", "nosotros", "por", "favor"] },
  { code: "da", words: ["jeg", "ikke", "tak", "vi", "er", "faktura", "hej"] },
];

export function heuristicTriage(text: string): Triage {
  const lower = text.toLowerCase();
  let best = { intent: "general_question", tags: [] as string[], priority: undefined as Triage["priority"], score: 0 };
  for (const i of INTENTS) {
    const score = i.words.filter((w) => lower.includes(w)).length;
    if (score > best.score) best = { intent: i.intent, tags: i.tags, priority: i.priority, score };
  }
  const tokens = lower.split(/[^\p{L}]+/u);
  let language = "en";
  let langScore = 1;
  for (const l of LANGS) {
    const score = l.words.filter((w) => tokens.includes(w)).length;
    if (score > langScore) {
      language = l.code;
      langScore = score;
    }
  }
  const urgent = /(urgent|asap|immediately|right now|production|asap|critical)/.test(lower);
  const angry = /(unacceptable|ridiculous|angry|furious|worst|cancel)/.test(lower);
  return {
    intent: best.intent,
    tags: best.tags,
    priority: best.priority ?? (urgent ? "high" : "normal"),
    language,
    sentiment: angry ? "negative" : "neutral",
    summary: truncate(text.replace(/\s+/g, " "), 140),
  };
}

export async function heuristicAgent(orgId: string, ctx: AgentContext, trace: Trace): Promise<AgentOutcome> {
  const lastCustomer = [...ctx.history].reverse().find((m) => m.authorType === "customer" && m.kind === "message");
  const body = lastCustomer?.body ?? "";
  // Simulations derive the subject from the message; don't read it twice.
  const text = body.startsWith(ctx.ticket.subject) ? body : `${ctx.ticket.subject}\n${body}`;

  const triage = await trace.span(
    "intent.classify",
    "ai",
    async () => ({ ...heuristicTriage(text), fields: heuristicFields(text, ctx.fields) }),
    (t) => ({
      summary: `${t.intent} · ${t.language} · ${t.priority} (local rules)`,
      attributes: { provider: "local" },
    }),
  );

  const articles = await trace.span(
    "tool.search_knowledge_base",
    "tool",
    // Offline replies quote the source verbatim, so only public knowledge qualifies.
    () => searchKnowledge(orgId, text, { limit: 3, includeInternal: false }),
    (r) => ({ summary: r.length ? `${r.length} documents · top: ${r[0]!.title}` : "no knowledge matched" }),
  );
  const similar = await trace.span(
    "tool.search_past_tickets",
    "tool",
    () => searchTickets(orgId, text, { excludeTicketId: ctx.ticket.id, limit: 3, status: ["resolved", "closed"] }),
    (r) => ({ summary: `${r.length} similar resolved tickets` }),
  );

  const first = ctx.customer?.name?.split(/\s+/)[0];
  const greeting = first ? `Hi ${first},` : "Hi there,";
  const top = articles[0];
  if (top) {
    const excerpt = top.content
      .split(/\n{2,}|\n…\n/)
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith("#"))
      .slice(0, 2)
      .join("\n\n");
    const body = `${greeting}\n\nThanks for reaching out! Here's what should help:\n\n${truncate(excerpt, 900)}\n\nMore details are in our guide "${top.title}". If that doesn't solve it, just reply here and we'll dig in.\n\n— ${ctx.ai.agentName}`;
    await trace.event("reply.compose", "ai", `1 source cited · template reply (offline mode)`);
    return {
      kind: "reply",
      body,
      confidence: Math.min(0.6, 0.35 + 0.1 * articles.length + 0.05 * similar.length),
      sources: [
        hitToSource(top),
        ...similar.slice(0, 2).map((s) => ({ type: "ticket" as const, id: s.id, title: s.subject })),
      ],
      resolves: false,
      triage,
    };
  }
  await trace.event("reply.compose", "ai", "no grounding found · holding reply drafted");
  return {
    kind: "reply",
    body: `${greeting}\n\nThanks for getting in touch — we've received your message about "${ctx.ticket.subject}" and are looking into it now. We'll follow up here as soon as we have an answer.\n\n— ${ctx.ai.agentName}`,
    confidence: 0.2,
    sources: similar.slice(0, 2).map((s) => ({ type: "ticket" as const, id: s.id, title: s.subject })),
    resolves: false,
    triage,
  };
}
