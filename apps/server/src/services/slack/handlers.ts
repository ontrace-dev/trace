import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { messages, tickets } from "../../db/schema.ts";
import { truncate } from "../../lib/text.ts";
import { askWorkspace } from "../ai/copilot.ts";
import { listTickets, pendingDraftFor, sidebarCounts } from "../queries.ts";
import {
  addMessage,
  createTicket,
  getTicket,
  sendDraft,
  type Ticket,
  updateTicket,
  upsertCustomer,
} from "../tickets.ts";
import { setAvailability } from "../routing/availability.ts";
import { Trace } from "../tracer.ts";
import { ACTIONS, esc, REPLY_MODAL, replyModal } from "./blocks.ts";
import { postEphemeral, postMessage, type SlackIntegration, slackError, slackOf, updateMessage } from "./client.ts";
import { workspaceRef } from "./notify.ts";
import { memberForSlackUser, slackProfile } from "./users.ts";

/* ------------------------------------------------------------------ helpers */

const seen = new Map<string, number>();
/** Slack may deliver an event more than once (retries, both transports); process each once. */
export function firstTime(key: string) {
  const now = Date.now();
  if (seen.has(key)) return false;
  seen.set(key, now);
  if (seen.size > 5000) {
    for (const [k, t] of seen) if (now - t > 10 * 60_000) seen.delete(k);
  }
  return true;
}

/** Convert Slack mrkdwn (mentions, links, entities) into readable plain text. */
export async function plainText(i: SlackIntegration, text: string) {
  let out = text ?? "";
  const ids = [...new Set([...out.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)].map((m) => m[1]!))];
  for (const uid of ids) {
    const p = await slackProfile(i, uid);
    out = out.replace(new RegExp(`<@${uid}(?:\\|[^>]+)?>`, "g"), `@${p.name}`);
  }
  return out
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/** Markdown from the AI (**bold**, [x](y)) → Slack mrkdwn. */
export function toMrkdwn(md: string) {
  return md
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "<$2|$1>")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
}

async function ticketByThread(orgId: string, channel: string, threadTs: string, integrationId: string) {
  const [notif] = await db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.orgId, orgId),
        sql`${tickets.slack}->'notifications'->${integrationId}::text->>'ts' = ${threadTs}`,
        sql`${tickets.slack}->'notifications'->${integrationId}::text->>'channel' = ${channel}`,
      ),
    )
    .limit(1);
  if (notif) return { ticket: notif, kind: "notification" as const };
  const [intake] = await db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.orgId, orgId),
        sql`${tickets.slack}->'intake'->>'ts' = ${threadTs}`,
        sql`${tickets.slack}->'intake'->>'channel' = ${channel}`,
      ),
    )
    .limit(1);
  if (intake) return { ticket: intake, kind: "intake" as const };
  return undefined;
}

async function alreadyStored(orgId: string, externalId: string) {
  const [m] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.externalId, externalId)))
    .limit(1);
  return !!m;
}

async function respond(responseUrl: string | undefined, body: Record<string, unknown>) {
  if (!responseUrl) return;
  await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => console.warn("[slack] response_url failed", err));
}

/* ------------------------------------------------------------------ Events API */

interface SlackMessageEvent {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  channel: string;
  files?: { name?: string }[];
}

export async function handleEvent(i: SlackIntegration, event: SlackMessageEvent, opts: { primary: boolean }) {
  if (event.type === "message") return handleMessageEvent(i, event);
  if (event.type === "app_mention" && opts.primary) return handleMention(i, event);
}

async function handleMessageEvent(i: SlackIntegration, ev: SlackMessageEvent) {
  if (ev.subtype && ev.subtype !== "file_share" && ev.subtype !== "thread_broadcast") return;
  if (ev.bot_id || !ev.user || ev.user === i.config.botUserId) return;
  const externalId = `slack:${ev.channel}:${ev.ts}`;
  if (!firstTime(`${i.id}:${externalId}`)) return;
  if (await alreadyStored(i.orgId, externalId)) return;

  const files = (ev.files ?? []).map((f) => f.name).filter(Boolean);
  let body = await plainText(i, ev.text ?? "");
  if (files.length) body = `${body}\n\n(attached in Slack: ${files.join(", ")})`.trim();
  if (!body) return;
  const slackMeta = { channel: ev.channel, ts: ev.ts, user: ev.user };

  // Reply inside a thread we know about.
  if (ev.thread_ts && ev.thread_ts !== ev.ts) {
    const hit = await ticketByThread(i.orgId, ev.channel, ev.thread_ts, i.id);
    if (!hit) return;
    const { ticket, kind } = hit;
    const profile = await slackProfile(i, ev.user);
    const member = await memberForSlackUser(i, ev.user);
    const trace = new Trace(i.orgId, ticket.id);
    if (kind === "notification") {
      // Team chatter in the notification thread stays internal.
      await addMessage(i.orgId, ticket.id, {
        kind: "note",
        authorType: "agent",
        authorId: member?.id ?? null,
        authorName: member?.name ?? `${profile.name} (Slack)`,
        body,
        externalId,
        meta: { via: "slack", slack: slackMeta },
      });
      await trace.event("slack.inbound", "integration", `note from ${profile.name} via Slack thread`);
      return;
    }
    if (member) {
      // An agent answering in the customer's thread — it's already visible to them, so no re-delivery.
      await addMessage(i.orgId, ticket.id, {
        authorType: "agent",
        authorId: member.id,
        authorName: member.name,
        body,
        externalId,
        meta: { via: "slack", slack: slackMeta },
      });
    } else {
      const customer = await upsertCustomer(i.orgId, {
        email: profile.email,
        name: profile.name,
        slackUserId: ev.user,
        avatarUrl: profile.avatar,
      });
      await addMessage(i.orgId, ticket.id, {
        authorType: "customer",
        authorId: customer.id,
        authorName: customer.name,
        body,
        externalId,
        meta: { via: "slack", slack: slackMeta },
      });
    }
    await trace.event("slack.inbound", "integration", `${member ? "agent" : "customer"} reply in intake thread`);
    return;
  }

  // New top-level message in an intake channel → new ticket.
  const intake = (i.config.intakeChannels ?? []).some((c) => c.id === ev.channel);
  if (!intake) return;
  const profile = await slackProfile(i, ev.user);
  if (profile.isBot) return;
  const firstLine = body.split("\n").find((l) => l.trim()) ?? body;
  const { ticket } = await createTicket(i.orgId, {
    subject: truncate(firstLine.trim(), 90),
    body,
    channel: "slack",
    customer: { email: profile.email, name: profile.name, slackUserId: ev.user, avatarUrl: profile.avatar },
    externalId,
    slack: { intake: { integrationId: i.id, channel: ev.channel, ts: ev.ts, teamId: i.config.teamId } },
    meta: { via: "slack", slack: slackMeta },
  });
  await slackOf(i)
    .reactions.add({ channel: ev.channel, timestamp: ev.ts, name: "eyes" })
    .catch(() => {});
  await new Trace(i.orgId, ticket.id).event(
    "slack.intake",
    "integration",
    `ticket opened from Slack message by ${profile.name}`,
  );
}

async function handleMention(i: SlackIntegration, ev: SlackMessageEvent) {
  if (!ev.user || ev.bot_id) return;
  if (!firstTime(`${i.id}:mention:${ev.channel}:${ev.ts}`)) return;
  // In intake channels a top-level mention is a customer request, handled as a ticket instead.
  const isIntake = (i.config.intakeChannels ?? []).some((c) => c.id === ev.channel);
  if (isIntake && (!ev.thread_ts || ev.thread_ts === ev.ts)) return;
  const question = (await plainText(i, (ev.text ?? "").replace(/<@[A-Z0-9]+>/g, ""))).trim();
  const threadTs = ev.thread_ts ?? ev.ts;
  if (!question) {
    await postMessage(i, {
      channel: ev.channel,
      thread_ts: threadTs,
      text: "Ask me anything about your queue, customers or knowledge base.",
    });
    return;
  }
  // Inside a ticket thread, give the model the ticket reference.
  const hit = ev.thread_ts ? await ticketByThread(i.orgId, ev.channel, ev.thread_ts, i.id) : undefined;
  let prompt = question;
  if (hit) {
    const { ref } = await workspaceRef(i.orgId, hit.ticket.number);
    prompt = `(Asked in the Slack thread for ticket ${ref}, number ${hit.ticket.number}.) ${question}`;
  }
  try {
    const res = await askWorkspace(i.orgId, prompt);
    await postMessage(i, { channel: ev.channel, thread_ts: threadTs, text: toMrkdwn(res.answer), unfurl_links: false });
  } catch (err) {
    await postMessage(i, { channel: ev.channel, thread_ts: threadTs, text: `:warning: ${slackError(err)}` }).catch(
      () => {},
    );
  }
}

/* ------------------------------------------------------------------ Interactivity */

interface InteractionPayload {
  type: string;
  user: { id: string; name?: string };
  trigger_id?: string;
  response_url?: string;
  channel?: { id: string };
  container?: { channel_id?: string; message_ts?: string };
  actions?: { action_id: string; value?: string }[];
  view?: {
    callback_id: string;
    private_metadata: string;
    state: { values: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>> };
  };
}

export interface InteractionResult {
  /** Immediate response to Slack (the ack body). */
  response?: Record<string, unknown>;
  /** Work to run after acknowledging. */
  after?: () => Promise<void>;
}

const NOT_MEMBER =
  "Your Slack email doesn't match a member of this trace workspace. Ask an admin to invite you with the same email.";

export async function handleInteraction(i: SlackIntegration, p: InteractionPayload): Promise<InteractionResult> {
  if (p.type === "block_actions") {
    const action = p.actions?.[0];
    if (!action || action.action_id === ACTIONS.open) return {};
    const channel = p.channel?.id ?? p.container?.channel_id;
    const ephemeral = (text: string) =>
      channel
        ? postEphemeral(i, { channel, user: p.user.id, text }).catch(() =>
            respond(p.response_url, { response_type: "ephemeral", replace_original: false, text }),
          )
        : respond(p.response_url, { response_type: "ephemeral", replace_original: false, text });

    // Opening a modal must happen within 3s of the click — do it before anything slow.
    if (action.action_id === ACTIONS.reply && action.value && p.trigger_id) {
      const ticket = await getTicket(i.orgId, action.value);
      if (!ticket) return {};
      const [draft, { ref }] = await Promise.all([pendingDraftFor(ticket.id), workspaceRef(i.orgId, ticket.number)]);
      try {
        await slackOf(i).views.open({
          trigger_id: p.trigger_id,
          view: replyModal({
            ticketId: ticket.id,
            integrationId: i.id,
            ref,
            subject: ticket.subject,
            draft: draft?.body,
          }) as never,
        });
      } catch (err) {
        await ephemeral(`:warning: Could not open the reply dialog: ${slackError(err)}`);
      }
      return {};
    }

    return {
      after: async () => {
        const ticket = action.value ? await getTicket(i.orgId, action.value) : undefined;
        if (!ticket) return ephemeral("That ticket no longer exists.").then(() => {});
        const member = await memberForSlackUser(i, p.user.id);
        if (!member) return ephemeral(NOT_MEMBER).then(() => {});
        const actor = { type: "agent" as const, id: member.id, name: member.name };
        const trace = new Trace(i.orgId, ticket.id);
        try {
          switch (action.action_id) {
            case ACTIONS.sendDraft:
              await sendDraft(i.orgId, ticket.id, { id: member.id, name: member.name });
              await trace.event("slack.action", "integration", `${member.name} sent the AI draft from Slack`);
              break;
            case ACTIONS.assignMe:
              await updateTicket(i.orgId, ticket.id, { assigneeId: member.id }, actor);
              await trace.event("slack.action", "integration", `${member.name} took the ticket from Slack`);
              break;
            case ACTIONS.resolve:
              await updateTicket(i.orgId, ticket.id, { status: "resolved" }, actor);
              await trace.event("slack.action", "integration", `${member.name} resolved from Slack`);
              break;
            case ACTIONS.reopen:
              await updateTicket(i.orgId, ticket.id, { status: "open" }, actor);
              break;
          }
        } catch (err) {
          await ephemeral(`:warning: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    };
  }

  if (p.type === "view_submission" && p.view?.callback_id === REPLY_MODAL) {
    const meta = JSON.parse(p.view.private_metadata || "{}") as { ticketId?: string };
    const body = p.view.state.values.reply?.body?.value?.trim() ?? "";
    const status = p.view.state.values.status?.value?.selected_option?.value as Ticket["status"] | undefined;
    if (!body) return { response: { response_action: "errors", errors: { reply: "Write a message first." } } };
    const member = await memberForSlackUser(i, p.user.id);
    if (!member) return { response: { response_action: "errors", errors: { reply: NOT_MEMBER } } };
    return {
      after: async () => {
        if (!meta.ticketId) return;
        const ticket = await getTicket(i.orgId, meta.ticketId);
        if (!ticket) return;
        await addMessage(i.orgId, ticket.id, {
          authorType: "agent",
          authorId: member.id,
          authorName: member.name,
          body,
          meta: { via: "web" },
          status: status && status !== "pending" ? status : undefined,
        });
        if (!ticket.assigneeId) {
          await updateTicket(
            i.orgId,
            ticket.id,
            { assigneeId: member.id },
            { type: "agent", id: member.id, name: member.name },
          );
        }
        await new Trace(i.orgId, ticket.id).event("slack.action", "integration", `${member.name} replied from Slack`);
      },
    };
  }
  return {};
}

/* ------------------------------------------------------------------ Slash command */

interface CommandBody {
  command?: string;
  text?: string;
  user_id: string;
  channel_id: string;
  response_url?: string;
}

const HELP = [
  "*/trace* — your helpdesk, from Slack",
  "• `/trace ask <question>` — ask the AI about your queue, customers or knowledge base",
  "• `/trace search <query>` — find tickets",
  "• `/trace new <subject> | <details>` — open a ticket (replies in its thread go to the ticket)",
  "• `/trace stats` — queue at a glance",
  "• `/trace away` / `/trace back` — pause or resume getting tickets from auto-assignment",
].join("\n");

export function handleCommand(i: SlackIntegration, b: CommandBody): InteractionResult {
  const text = (b.text ?? "").trim();
  const [sub = "", ...restParts] = text.split(/\s+/);
  const rest = text.slice(sub.length).trim();
  void restParts;
  const reply = (payload: Record<string, unknown>) =>
    respond(b.response_url, { response_type: "ephemeral", ...payload });

  switch (sub.toLowerCase()) {
    case "away":
    case "back":
    case "available": {
      const away = sub.toLowerCase() === "away";
      return {
        response: { response_type: "ephemeral", text: away ? ":zzz: Setting you away…" : ":wave: Welcome back…" },
        after: async () => {
          const member = await memberForSlackUser(i, b.user_id);
          if (!member) return reply({ text: NOT_MEMBER });
          await setAvailability(i.orgId, member.id, away ? "away" : "available");
          await reply({
            text: away
              ? ":zzz: You're away — auto-assignment skips you until `/trace back`."
              : ":white_check_mark: You're available — auto-assignment can route tickets to you again.",
          });
        },
      };
    }
    case "ask": {
      if (!rest) return { response: { response_type: "ephemeral", text: "Usage: `/trace ask <question>`" } };
      return {
        response: { response_type: "ephemeral", text: `:sparkles: Looking into _${esc(truncate(rest, 200))}_…` },
        after: async () => {
          try {
            const res = await askWorkspace(i.orgId, rest);
            await reply({ text: toMrkdwn(res.answer) });
          } catch (err) {
            await reply({ text: `:warning: ${slackError(err)}` });
          }
        },
      };
    }
    case "search": {
      if (!rest) return { response: { response_type: "ephemeral", text: "Usage: `/trace search <query>`" } };
      return {
        response: { response_type: "ephemeral", text: ":mag: Searching…" },
        after: async () => {
          const rows = await listTickets(i.orgId, { q: rest }, "", { limit: 10 });
          if (!rows.length) return reply({ text: `No tickets match _${esc(rest)}_.` });
          const lines = await Promise.all(
            rows.map(async (r) => {
              const { ref, url } = await workspaceRef(i.orgId, r.number);
              return `• <${url}|${ref}> ${esc(r.subject)} — _${r.status}_${r.customer?.name ? ` · ${esc(r.customer.name)}` : ""}`;
            }),
          );
          await reply({ text: `*Tickets matching “${esc(rest)}”*\n${lines.join("\n")}` });
        },
      };
    }
    case "new": {
      if (!rest) return { response: { response_type: "ephemeral", text: "Usage: `/trace new <subject> | <details>`" } };
      return {
        response: { response_type: "ephemeral", text: ":ticket: Opening a ticket…" },
        after: async () => {
          const [subject, ...details] = rest.split("|");
          const profile = await slackProfile(i, b.user_id);
          const body = details.join("|").trim() || subject!.trim();
          // Post the thread root first so the ticket can live in that thread.
          let intake: { integrationId: string; channel: string; ts: string; teamId?: string } | undefined;
          try {
            const root = await postMessage(i, {
              channel: b.channel_id,
              text: `:ticket: <@${b.user_id}> opened a ticket: *${esc(subject!.trim())}*`,
            });
            intake = {
              integrationId: i.id,
              channel: root.channel ?? b.channel_id,
              ts: root.ts!,
              teamId: i.config.teamId,
            };
          } catch {
            /* bot can't post here (private channel / DM) — the ticket still gets created */
          }
          const { ticket } = await createTicket(i.orgId, {
            subject: truncate(subject!.trim(), 120),
            body,
            channel: "slack",
            customer: { email: profile.email, name: profile.name, slackUserId: b.user_id, avatarUrl: profile.avatar },
            slack: intake ? { intake } : undefined,
            meta: { via: "slack" },
          });
          const { ref, url } = await workspaceRef(i.orgId, ticket.number);
          if (intake) {
            await updateMessage(i, {
              channel: intake.channel,
              ts: intake.ts,
              text: `:ticket: <@${b.user_id}> opened <${url}|${ref}>: *${esc(ticket.subject)}* — reply in this thread to add details.`,
            }).catch(() => {});
          }
          await new Trace(i.orgId, ticket.id).event(
            "slack.intake",
            "integration",
            `ticket opened with /trace new by ${profile.name}`,
          );
          await reply({ text: `Created <${url}|${ref}> — ${esc(ticket.subject)}` });
        },
      };
    }
    case "stats": {
      return {
        response: { response_type: "ephemeral", text: ":bar_chart: Counting…" },
        after: async () => {
          const member = await memberForSlackUser(i, b.user_id);
          const c = await sidebarCounts(i.orgId, member?.id ?? "");
          const { url } = await workspaceRef(i.orgId, 0);
          await reply({
            text: [
              `*Queue* · <${url.replace(/\/0$/, "")}|open in trace>`,
              `• Open & pending: *${c.inbox ?? 0}*`,
              `• Unassigned: *${c.unassigned ?? 0}*`,
              `• Waiting on AI review: *${c.ai ?? 0}*`,
              member ? `• Assigned to you: *${c.mine ?? 0}*` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          });
        },
      };
    }
    default:
      return { response: { response_type: "ephemeral", text: HELP } };
  }
}
