import type { drafts } from "../../db/schema.ts";
import { accountLine, type AccountContext, age } from "../notifications/context.ts";
import { truncate } from "../../lib/text.ts";
import type { Customer, Message, Ticket } from "../tickets.ts";
import type { Block } from "./client.ts";

export const ACTIONS = {
  sendDraft: "trace_send_draft",
  reply: "trace_reply",
  assignMe: "trace_assign_me",
  resolve: "trace_resolve",
  reopen: "trace_reopen",
  open: "trace_open",
} as const;

export const REPLY_MODAL = "trace_reply_modal";

const PRIORITY_EMOJI: Record<Ticket["priority"], string> = {
  urgent: ":red_circle:",
  high: ":large_orange_circle:",
  normal: ":white_circle:",
  low: ":black_circle:",
};

const STATUS_LABEL: Record<Ticket["status"], string> = {
  open: ":inbox_tray: open",
  pending: ":hourglass_flowing_sand: pending",
  resolved: ":white_check_mark: resolved",
  closed: ":lock: closed",
};

const AI_LABEL: Partial<Record<Ticket["aiState"], string>> = {
  processing: ":sparkles: AI is working on it…",
  draft_ready: ":sparkles: AI draft ready for review",
  auto_replied: ":robot_face: AI replied automatically",
  escalated: ":raising_hand: AI escalated to a human",
  awaiting_approval: ":hourglass_flowing_sand: AI is waiting for a human to approve an action — open in trace",
  error: ":warning: AI run failed",
};

/** Escape user text for Slack mrkdwn. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Slack mrkdwn quote of a multi-line body. */
export const quote = (s: string, max = 600) =>
  truncate(s.trim(), max)
    .split("\n")
    .map((l) => `>${esc(l)}`)
    .join("\n");

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

export function ticketCard(c: TicketCardInput): { text: string; blocks: Block[] } {
  const t = c.ticket;
  const who = c.customer
    ? `${esc(c.customer.name ?? "Customer")}${c.customer.email ? ` <mailto:${c.customer.email}|${esc(c.customer.email)}>` : ""}`
    : "Anonymous visitor";
  const done = t.status === "resolved" || t.status === "closed";
  const blocks: Block[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${PRIORITY_EMOJI[t.priority]} *<${c.url}|${esc(c.ref)} · ${esc(t.subject)}>*\n${who}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: [
            STATUS_LABEL[t.status],
            `priority *${t.priority}*`,
            `via ${t.channel}`,
            c.assigneeName ? `:bust_in_silhouette: ${esc(c.assigneeName)}` : "unassigned",
            t.tags.length ? t.tags.map((x) => `\`${esc(x)}\``).join(" ") : null,
          ]
            .filter(Boolean)
            .join("  ·  "),
        },
      ],
    },
  ];
  if (c.opener?.body) blocks.push({ type: "section", text: { type: "mrkdwn", text: quote(c.opener.body) } });
  if (c.account) {
    const recent = c.account.recent
      .map(
        (r) => `${r.subject.length > 40 ? `${r.subject.slice(0, 39)}…` : r.subject} (${r.status}, ${age(r.createdAt)})`,
      )
      .map(esc);
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: [
            `:bust_in_silhouette: ${esc(accountLine(c.account))}`,
            recent.length ? `Recent: ${recent.join(" · ")}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });
  }

  const ai: string[] = [];
  if (AI_LABEL[t.aiState]) ai.push(AI_LABEL[t.aiState]!);
  if (t.aiSummary) ai.push(`*Summary:* ${esc(t.aiSummary)}`);
  const triage = [
    t.aiIntent && `intent \`${esc(t.aiIntent)}\``,
    t.aiLanguage && `lang \`${esc(t.aiLanguage)}\``,
    t.aiSentiment && `sentiment \`${esc(t.aiSentiment)}\``,
  ].filter(Boolean);
  if (triage.length) ai.push(triage.join("  "));
  if (ai.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: ai.join("\n") }] });

  if (c.draft && !done) {
    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:pencil2: *Suggested reply* — confidence ${Math.round(c.draft.confidence * 100)}%\n${quote(c.draft.body, 1200)}`,
        },
      },
    );
    if (c.draft.sources.length) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `Sources: ${c.draft.sources.map((s) => esc(s.title)).join(" · ")}` }],
      });
    }
  }

  const buttons: Block[] = [];
  if (c.draft && !done) {
    buttons.push({
      type: "button",
      action_id: ACTIONS.sendDraft,
      text: { type: "plain_text", text: "Send AI draft" },
      style: "primary",
      value: t.id,
    });
  }
  buttons.push({ type: "button", action_id: ACTIONS.reply, text: { type: "plain_text", text: "Reply…" }, value: t.id });
  if (!c.assigneeName)
    buttons.push({
      type: "button",
      action_id: ACTIONS.assignMe,
      text: { type: "plain_text", text: "Assign to me" },
      value: t.id,
    });
  buttons.push(
    done
      ? { type: "button", action_id: ACTIONS.reopen, text: { type: "plain_text", text: "Reopen" }, value: t.id }
      : { type: "button", action_id: ACTIONS.resolve, text: { type: "plain_text", text: "Resolve" }, value: t.id },
  );
  buttons.push({
    type: "button",
    action_id: ACTIONS.open,
    text: { type: "plain_text", text: "Open in trace" },
    url: c.url,
  });
  blocks.push({ type: "actions", block_id: `trace_actions_${t.id}`, elements: buttons });

  return { text: `${c.ref}: ${t.subject}`, blocks };
}

/** A ticket message mirrored into the notification thread. */
export function threadMessage(m: Message): { text: string; blocks: Block[] } {
  const name = esc(m.authorName ?? (m.authorType === "customer" ? "Customer" : m.authorType === "ai" ? "AI" : "Agent"));
  const icon =
    m.kind === "note"
      ? ":lock:"
      : m.authorType === "customer"
        ? ":speech_balloon:"
        : m.authorType === "ai"
          ? ":robot_face:"
          : ":outbox_tray:";
  const label =
    m.kind === "note"
      ? `${name} · internal note`
      : m.authorType === "customer"
        ? `${name} wrote`
        : `${name} replied to the customer`;
  const text = `${icon} *${label}*\n${esc(truncate(m.body, 2800))}`;
  const blocks: Block[] = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (m.attachments.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `:paperclip: ${m.attachments.map((a) => esc(a.name)).join(", ")}` }],
    });
  }
  return { text: `${label}: ${truncate(m.body, 200)}`, blocks };
}

export function replyModal(opts: {
  ticketId: string;
  integrationId: string;
  ref: string;
  subject: string;
  draft?: string;
}): Block {
  return {
    type: "modal",
    callback_id: REPLY_MODAL,
    private_metadata: JSON.stringify({ ticketId: opts.ticketId, integrationId: opts.integrationId }),
    title: { type: "plain_text", text: truncate(`Reply · ${opts.ref}`, 24) },
    submit: { type: "plain_text", text: "Send reply" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `*${esc(opts.subject)}* — sent to the customer over the ticket's channel.` },
        ],
      },
      {
        type: "input",
        block_id: "reply",
        label: { type: "plain_text", text: "Message" },
        element: {
          type: "plain_text_input",
          action_id: "body",
          multiline: true,
          ...(opts.draft ? { initial_value: truncate(opts.draft, 2900) } : {}),
        },
      },
      {
        type: "input",
        block_id: "status",
        optional: true,
        label: { type: "plain_text", text: "Then" },
        element: {
          type: "static_select",
          action_id: "value",
          initial_option: { text: { type: "plain_text", text: "Set to pending" }, value: "pending" },
          options: [
            { text: { type: "plain_text", text: "Set to pending" }, value: "pending" },
            { text: { type: "plain_text", text: "Resolve" }, value: "resolved" },
            { text: { type: "plain_text", text: "Keep open" }, value: "open" },
          ],
        },
      },
    ],
  };
}
