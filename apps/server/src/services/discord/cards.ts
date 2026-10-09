import type { drafts } from "../../db/schema.ts";
import { accountLine, type AccountContext, age } from "../notifications/context.ts";
import { truncate } from "../../lib/text.ts";
import type { Customer, Message, Ticket } from "../tickets.ts";

/** Button/modal custom ids: `trace:<action>:<ticketId>` (Discord caps custom ids at 100 chars). */
export const ACTIONS = {
  sendDraft: "sd",
  reply: "rp",
  assignMe: "am",
  resolve: "rs",
  reopen: "ro",
  replyModal: "rm",
} as const;
export type ActionCode = (typeof ACTIONS)[keyof typeof ACTIONS];

export const customId = (action: ActionCode, ticketId: string) => `trace:${action}:${ticketId}`;
export function parseCustomId(id: string): { action: ActionCode; ticketId: string } | null {
  const m = id.match(/^trace:(sd|rp|am|rs|ro|rm):(.+)$/);
  return m ? { action: m[1] as ActionCode, ticketId: m[2]! } : null;
}

// Discord API component/style numbers (kept literal so the payloads are plain JSON).
const ROW = 1;
const BUTTON = 2;
const TEXT_INPUT = 4;
const STYLE = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 } as const;

const PRIORITY_COLOR: Record<Ticket["priority"], number> = {
  urgent: 0xf87171,
  high: 0xfdba74,
  normal: 0xb9a3ff,
  low: 0x8a8a97,
};
const DONE_COLOR = 0x86efac;

const STATUS_LABEL: Record<Ticket["status"], string> = {
  open: "📥 open",
  pending: "⏳ pending",
  resolved: "✅ resolved",
  closed: "🔒 closed",
};

const AI_LABEL: Partial<Record<Ticket["aiState"], string>> = {
  processing: "✨ AI is working on it…",
  draft_ready: "✨ AI draft ready for review",
  auto_replied: "🤖 AI replied automatically",
  escalated: "🙋 AI escalated to a human",
  awaiting_approval: "⏳ AI is waiting for a human to approve an action — open in trace",
  error: "⚠️ AI run failed",
};

/** Quote a multi-line body as Discord markdown. */
export const quote = (s: string, max = 600) =>
  truncate(s.trim(), max)
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

/** Stop users' text from pinging @everyone/@here or roles when we echo it. */
export const NO_PINGS = { parse: [] as string[] };

export interface TicketCardInput {
  ticket: Ticket;
  ref: string;
  url: string;
  customer?: Customer;
  opener?: Message;
  draft?: typeof drafts.$inferSelect | null;
  assigneeName?: string | null;
  account?: AccountContext | null;
}

export interface CardPayload {
  content?: string;
  embeds: Record<string, unknown>[];
  components: Record<string, unknown>[];
  allowed_mentions: typeof NO_PINGS;
}

/** The ticket card posted to the notification channel and edited as the ticket changes. */
export function ticketCard(c: TicketCardInput): CardPayload {
  const t = c.ticket;
  const done = t.status === "resolved" || t.status === "closed";
  const who = c.customer
    ? `**${c.customer.name ?? "Customer"}**${c.customer.email ? ` · ${c.customer.email}` : ""}`
    : "Anonymous visitor";
  const description = [who, c.opener?.body ? quote(c.opener.body, 900) : null].filter(Boolean).join("\n\n");

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "Status", value: STATUS_LABEL[t.status], inline: true },
    { name: "Priority", value: t.priority, inline: true },
    { name: "Assignee", value: c.assigneeName ?? "unassigned", inline: true },
  ];
  if (c.account) {
    const recent = c.account.recent.map(
      (r) => `${r.subject.length > 40 ? `${r.subject.slice(0, 39)}…` : r.subject} (${r.status}, ${age(r.createdAt)})`,
    );
    fields.push({
      name: "Account",
      value: truncate(
        [accountLine(c.account), recent.length ? `Recent: ${recent.join(" · ")}` : null].filter(Boolean).join("\n"),
        1000,
      ),
    });
  }
  const ai: string[] = [];
  if (AI_LABEL[t.aiState]) ai.push(AI_LABEL[t.aiState]!);
  if (t.aiSummary) ai.push(`**Summary:** ${t.aiSummary}`);
  const triage = [
    t.aiIntent && `intent \`${t.aiIntent}\``,
    t.aiLanguage && `lang \`${t.aiLanguage}\``,
    t.aiSentiment && `sentiment \`${t.aiSentiment}\``,
  ].filter(Boolean);
  if (triage.length) ai.push(triage.join(" · "));
  if (t.tags.length) ai.push(t.tags.map((x) => `\`${x}\``).join(" "));
  if (ai.length) fields.push({ name: "AI", value: truncate(ai.join("\n"), 1000) });
  if (c.draft && !done) {
    fields.push({
      name: `✏️ Suggested reply — confidence ${Math.round(c.draft.confidence * 100)}%`,
      value: quote(c.draft.body, 950),
    });
    if (c.draft.sources.length) {
      fields.push({ name: "Sources", value: truncate(c.draft.sources.map((s) => s.title).join(" · "), 500) });
    }
  }

  const buttons: Record<string, unknown>[] = [];
  if (c.draft && !done) {
    buttons.push({ type: BUTTON, style: STYLE.primary, label: "Send AI draft", custom_id: customId("sd", t.id) });
  }
  buttons.push({ type: BUTTON, style: STYLE.secondary, label: "Reply…", custom_id: customId("rp", t.id) });
  if (!done) {
    buttons.push({ type: BUTTON, style: STYLE.secondary, label: "Assign to me", custom_id: customId("am", t.id) });
    buttons.push({ type: BUTTON, style: STYLE.success, label: "Resolve", custom_id: customId("rs", t.id) });
  } else {
    buttons.push({ type: BUTTON, style: STYLE.secondary, label: "Reopen", custom_id: customId("ro", t.id) });
  }
  // Discord only accepts http(s) link buttons.
  if (/^https?:\/\//.test(c.url)) buttons.push({ type: BUTTON, style: STYLE.link, label: "Open in trace", url: c.url });

  return {
    embeds: [
      {
        title: truncate(`${c.ref} · ${t.subject}`, 250),
        url: /^https?:\/\//.test(c.url) ? c.url : undefined,
        description: truncate(description, 3800),
        color: done ? DONE_COLOR : PRIORITY_COLOR[t.priority],
        fields,
        footer: { text: `via ${t.channel} · trace` },
        timestamp: t.createdAt.toISOString(),
      },
    ],
    components: [{ type: ROW, components: buttons.slice(0, 5) }],
    allowed_mentions: NO_PINGS,
  };
}

/** A ticket message mirrored into the card's thread. */
export function threadMessage(m: Message): string {
  const name = m.authorName ?? (m.authorType === "ai" ? "trace" : m.authorType === "customer" ? "Customer" : "Agent");
  const head =
    m.kind === "note"
      ? `🔒 **${name}** · internal note`
      : m.authorType === "customer"
        ? `💬 **${name}** · customer`
        : m.authorType === "ai"
          ? `✨ **${name}** · AI reply to the customer`
          : `↩️ **${name}** · reply to the customer`;
  return `${head}\n${truncate(m.body.trim(), 1800)}`;
}

/** The "Reply…" modal, prefilled with the pending AI draft. */
export function replyModal(ticketId: string, ref: string, draft?: string) {
  return {
    custom_id: customId("rm", ticketId),
    title: truncate(`Reply · ${ref}`, 45),
    components: [
      {
        type: ROW,
        components: [
          {
            type: TEXT_INPUT,
            custom_id: "body",
            style: 2,
            label: "Message to the customer",
            placeholder: "Write your reply…",
            value: draft ? truncate(draft, 4000) : undefined,
            required: true,
            max_length: 4000,
          },
        ],
      },
    ],
  };
}

/** Thread names are capped at 100 characters. */
export const threadName = (ref: string, subject: string) => truncate(`${ref} · ${subject}`, 95);
