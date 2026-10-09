import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { messages, tickets, user } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { bus, type BusEvent } from "../../lib/bus.ts";
import { truncate } from "../../lib/text.ts";
import { pendingDraftFor } from "../queries.ts";
import { getCustomer, getTicket, type Message, registerDeliverer, type Ticket } from "../tickets.ts";
import { Trace } from "../tracer.ts";
import { loadAccountContext } from "../notifications/context.ts";
import { whenAiSettled } from "../notifications/ai-settled.ts";
import { getOrg, getSettings } from "../workspace.ts";
import { ticketCard, threadMessage } from "./blocks.ts";
import {
  getSlackIntegration,
  listSlackIntegrations,
  postMessage,
  type SlackIntegration,
  slackError,
  updateMessage,
} from "./client.ts";

export async function workspaceRef(orgId: string, number: number) {
  const [settings, org] = await Promise.all([getSettings(orgId), getOrg(orgId)]);
  return {
    ref: `${settings.ticketPrefix}-${number}`,
    url: `${env.APP_URL}/w/${org?.slug ?? ""}/inbox/inbox/${number}`,
    slug: org?.slug ?? "",
    prefix: settings.ticketPrefix,
  };
}

async function opener(ticketId: string) {
  const [m] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.ticketId, ticketId), eq(messages.kind, "message")))
    .orderBy(asc(messages.createdAt))
    .limit(1);
  return m;
}

export async function renderCard(ticket: Ticket) {
  const [{ ref, url }, customer, first, draft, assignee] = await Promise.all([
    workspaceRef(ticket.orgId, ticket.number),
    getCustomer(ticket.customerId),
    opener(ticket.id),
    pendingDraftFor(ticket.id),
    ticket.assigneeId
      ? db
          .select({ name: user.name })
          .from(user)
          .where(eq(user.id, ticket.assigneeId))
          .then((r) => r[0])
      : Promise.resolve(undefined),
  ]);
  const account = await loadAccountContext(ticket, customer);
  return ticketCard({ ticket, ref, url, customer, opener: first, draft, assigneeName: assignee?.name, account });
}

/** Atomically set tickets.slack.notifications[integrationId] without clobbering other keys. */
async function saveNotification(ticketId: string, integrationId: string, value: { channel: string; ts: string }) {
  await db
    .update(tickets)
    .set({
      slack: sql`coalesce(${tickets.slack}, '{}'::jsonb) || jsonb_build_object('notifications', coalesce(${tickets.slack}->'notifications', '{}'::jsonb) || jsonb_build_object(${integrationId}::text, ${JSON.stringify(value)}::jsonb))`,
    })
    .where(eq(tickets.id, ticketId));
}

/** Post the root notification for a ticket if it doesn't exist yet. Returns the thread and whether it was created. */
async function ensureNotification(i: SlackIntegration, ticket: Ticket) {
  const existing = ticket.slack?.notifications?.[i.id];
  if (existing) return { thread: existing, created: false };
  const channel = i.config.notifyChannel?.id;
  if (!channel) return null;
  const card = await renderCard(ticket);
  const trace = new Trace(ticket.orgId, ticket.id);
  try {
    const res = await postMessage(i, {
      channel,
      text: card.text,
      blocks: card.blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
    const thread = { channel: res.channel ?? channel, ts: res.ts! };
    await saveNotification(ticket.id, i.id, thread);
    await trace.event("slack.notify", "integration", `posted to #${i.config.notifyChannel?.name ?? channel}`, {
      integrationId: i.id,
    });
    return { thread, created: true };
  } catch (err) {
    await trace.event("slack.notify", "integration", slackError(err), { integrationId: i.id, error: true });
    console.warn("[slack] notify failed:", slackError(err));
    return null;
  }
}

async function updateRoots(ticketId: string, orgId: string) {
  const ticket = await getTicket(orgId, ticketId);
  const notes = ticket?.slack?.notifications;
  if (!ticket || !notes) return;
  const card = await renderCard(ticket);
  for (const [integrationId, thread] of Object.entries(notes)) {
    const i = await getSlackIntegration(integrationId, orgId);
    if (!i || !i.enabled) continue;
    await updateMessage(i, { channel: thread.channel, ts: thread.ts, text: card.text, blocks: card.blocks }).catch(
      (err) => console.warn("[slack] chat.update failed:", slackError(err)),
    );
  }
}

const rootTimers = new Map<string, NodeJS.Timeout>();
function scheduleRootUpdate(ticketId: string, orgId: string) {
  const t = rootTimers.get(ticketId);
  if (t) clearTimeout(t);
  rootTimers.set(
    ticketId,
    setTimeout(() => {
      rootTimers.delete(ticketId);
      chain(ticketId, () => updateRoots(ticketId, orgId));
    }, 700),
  );
}

/** Slack work is serialized per ticket so the root message always exists before thread replies. */
const chains = new Map<string, Promise<unknown>>();
function chain(ticketId: string, fn: () => Promise<unknown>) {
  const prev = chains.get(ticketId) ?? Promise.resolve();
  const next = prev
    .then(fn)
    .catch((err) => console.error("[slack]", err))
    .finally(() => {
      if (chains.get(ticketId) === next) chains.delete(ticketId);
    });
  chains.set(ticketId, next);
}

async function syncMessage(i: SlackIntegration, thread: { channel: string; ts: string }, m: Message) {
  // Never echo a message back into the thread it came from.
  if (m.meta.slack?.channel === thread.channel) return;
  const body = threadMessage(m);
  await postMessage(i, {
    channel: thread.channel,
    thread_ts: thread.ts,
    text: body.text,
    blocks: body.blocks,
    unfurl_links: false,
  }).catch((err) => console.warn("[slack] thread sync failed:", slackError(err)));
}

async function handle(e: BusEvent) {
  if (!("ticketId" in e)) return;
  const all = (await listSlackIntegrations(e.orgId)).filter((i) => i.enabled);
  if (!all.length) return;
  let ticket = await getTicket(e.orgId, e.ticketId);
  if (!ticket) return;

  for (const i of all) {
    const notifyOn = i.config.notifyOn ?? [];
    switch (e.type) {
      case "ticket.created": {
        if (!notifyOn.includes("ticket.created")) break;
        if (i.config.waitForAi === false) {
          await ensureNotification(i, ticket);
          break;
        }
        // Post once the AI has triaged and drafted (or after a timeout), so the card arrives with context.
        const { orgId } = e;
        const ticketId = ticket.id;
        const integrationId = i.id;
        void whenAiSettled(orgId, ticketId, () =>
          chain(ticketId, async () => {
            const [fresh, current] = await Promise.all([
              getTicket(orgId, ticketId),
              getSlackIntegration(integrationId, orgId),
            ]);
            if (fresh && current?.enabled) await ensureNotification(current, fresh);
          }),
        );
        break;
      }
      case "ticket.escalated": {
        const had = ticket.slack?.notifications?.[i.id];
        if (notifyOn.includes("ticket.escalated") || had) {
          const n = await ensureNotification(i, ticket);
          if (n && i.config.threadSync) {
            await postMessage(i, {
              channel: n.thread.channel,
              thread_ts: n.thread.ts,
              text: `:raising_hand: *AI escalated this ticket*${e.reason ? ` — ${truncate(e.reason, 500)}` : ""}`,
            }).catch(() => {});
          }
        }
        scheduleRootUpdate(ticket.id, e.orgId);
        break;
      }
      case "draft.ready": {
        if (notifyOn.includes("draft.ready")) await ensureNotification(i, ticket);
        scheduleRootUpdate(ticket.id, e.orgId);
        break;
      }
      case "message.created": {
        if (e.kind === "event") break;
        const [m] = await db.select().from(messages).where(eq(messages.id, e.messageId));
        if (!m) break;
        let thread = ticket.slack?.notifications?.[i.id];
        if (!thread && m.authorType === "customer" && notifyOn.includes("message.customer")) {
          thread = (await ensureNotification(i, ticket))?.thread;
        }
        if (thread && i.config.threadSync) {
          // The opening message is already shown in the root card.
          const first = await opener(ticket.id);
          if (first?.id !== m.id) await syncMessage(i, thread, m);
        }
        if (thread) scheduleRootUpdate(ticket.id, e.orgId);
        break;
      }
      case "ticket.updated":
      case "ai.state": {
        if (ticket.slack?.notifications?.[i.id]) scheduleRootUpdate(ticket.id, e.orgId);
        break;
      }
    }
    // Re-read so later integrations see notification refs written above.
    ticket = (await getTicket(e.orgId, e.ticketId)) ?? ticket;
  }
}

export function startNotifications() {
  bus.on("event", (e: BusEvent) => {
    if (!("ticketId" in e)) return;
    chain(e.ticketId, () => handle(e));
  });
}

/** Public replies on Slack-originated tickets are posted into the customer's intake thread. */
export function registerSlackDelivery() {
  registerDeliverer("slack", async (ticket, message) => {
    const intake = ticket.slack?.intake;
    if (!intake) throw new Error("ticket has no Slack thread to reply in");
    const i = await getSlackIntegration(intake.integrationId, ticket.orgId);
    if (!i || !i.enabled) throw new Error("the Slack integration for this ticket is disconnected");
    const name = message.authorName ?? (message.authorType === "ai" ? "AI assistant" : "Support");
    const res = await postMessage(i, {
      channel: intake.channel,
      thread_ts: intake.ts,
      text: `*${name}:* ${message.body}`,
      unfurl_links: false,
    });
    await new Trace(ticket.orgId, ticket.id).event("slack.reply", "integration", `replied in Slack thread`, {
      channel: intake.channel,
    });
    return { slack: { channel: res.channel ?? intake.channel, ts: res.ts! } };
  });
}
