import { and, asc, eq, sql } from "drizzle-orm";
import { Routes } from "discord.js";
import { db } from "../../db/index.ts";
import { messages, tickets, user } from "../../db/schema.ts";
import { bus, type BusEvent } from "../../lib/bus.ts";
import { truncate } from "../../lib/text.ts";
import { pendingDraftFor } from "../queries.ts";
import { getCustomer, getTicket, type Message, registerDeliverer, type Ticket } from "../tickets.ts";
import { Trace } from "../tracer.ts";
import { loadAccountContext } from "../notifications/context.ts";
import { whenAiSettled } from "../notifications/ai-settled.ts";
import { workspaceRef } from "../slack/notify.ts";
import { NO_PINGS, threadMessage, threadName, ticketCard } from "./cards.ts";
import {
  type DiscordIntegration,
  discordError,
  getDiscordIntegration,
  listDiscordIntegrations,
  rest,
  splitMessage,
} from "./client.ts";

export { workspaceRef };

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
  return {
    ref,
    card: ticketCard({ ticket, ref, url, customer, opener: first, draft, assigneeName: assignee?.name, account }),
  };
}

type NotificationRef = { channelId: string; messageId: string; threadId?: string };

/** Atomically set tickets.discord.notifications[integrationId] without clobbering other keys. */
async function saveNotification(ticketId: string, integrationId: string, value: NotificationRef) {
  await db
    .update(tickets)
    .set({
      discord: sql`coalesce(${tickets.discord}, '{}'::jsonb) || jsonb_build_object('notifications', coalesce(${tickets.discord}->'notifications', '{}'::jsonb) || jsonb_build_object(${integrationId}::text, ${JSON.stringify(value)}::jsonb))`,
    })
    .where(eq(tickets.id, ticketId));
}

/** Post the ticket card to the notification channel (and open its thread) if it isn't there yet. */
async function ensureNotification(i: DiscordIntegration, ticket: Ticket) {
  const existing = ticket.discord?.notifications?.[i.id];
  if (existing) return existing;
  const channelId = i.config.notifyChannel?.id;
  if (!channelId) return null;
  const { ref, card } = await renderCard(ticket);
  const trace = new Trace(ticket.orgId, ticket.id);
  try {
    const msg = (await rest(i).post(Routes.channelMessages(channelId), { body: card })) as { id: string };
    const value: NotificationRef = { channelId, messageId: msg.id };
    if (i.config.threadSync) {
      const thread = (await rest(i)
        .post(Routes.threads(channelId, msg.id), {
          body: { name: threadName(ref, ticket.subject), auto_archive_duration: 10080 },
        })
        .catch((err) => {
          console.warn("[discord] couldn't open a thread on the card:", discordError(err));
          return null;
        })) as { id: string } | null;
      if (thread) value.threadId = thread.id;
    }
    await saveNotification(ticket.id, i.id, value);
    await trace.event("discord.notify", "integration", `posted to #${i.config.notifyChannel?.name ?? channelId}`, {
      integrationId: i.id,
    });
    return value;
  } catch (err) {
    await trace.event("discord.notify", "integration", discordError(err), { integrationId: i.id, error: true });
    console.warn("[discord] notify failed:", discordError(err));
    return null;
  }
}

async function updateCards(ticketId: string, orgId: string) {
  const ticket = await getTicket(orgId, ticketId);
  const notes = ticket?.discord?.notifications;
  if (!ticket || !notes) return;
  const { card } = await renderCard(ticket);
  for (const [integrationId, ref] of Object.entries(notes)) {
    const i = await getDiscordIntegration(integrationId, orgId);
    if (!i || !i.enabled) continue;
    await rest(i)
      .patch(Routes.channelMessage(ref.channelId, ref.messageId), { body: card })
      .catch((err) => console.warn("[discord] card update failed:", discordError(err)));
  }
}

const cardTimers = new Map<string, NodeJS.Timeout>();
function scheduleCardUpdate(ticketId: string, orgId: string) {
  const t = cardTimers.get(ticketId);
  if (t) clearTimeout(t);
  cardTimers.set(
    ticketId,
    setTimeout(() => {
      cardTimers.delete(ticketId);
      chain(ticketId, () => updateCards(ticketId, orgId));
    }, 700),
  );
}

/** Discord work is serialized per ticket so the card and its thread exist before replies are mirrored. */
const chains = new Map<string, Promise<unknown>>();
export function chain(ticketId: string, fn: () => Promise<unknown>) {
  const prev = chains.get(ticketId) ?? Promise.resolve();
  const next = prev
    .then(fn)
    .catch((err) => console.error("[discord]", err))
    .finally(() => {
      if (chains.get(ticketId) === next) chains.delete(ticketId);
    });
  chains.set(ticketId, next);
}

/** Should message m be mirrored into thread `threadId`? Never echo a message back where it came from. */
export function shouldMirror(m: Pick<Message, "kind" | "meta">, threadId: string) {
  if (m.kind === "event") return false;
  return m.meta.discord?.channelId !== threadId;
}

export async function postChunks(i: DiscordIntegration, channelId: string, text: string) {
  let last: { id: string } | undefined;
  for (const part of splitMessage(text)) {
    last = (await rest(i).post(Routes.channelMessages(channelId), {
      body: { content: part, allowed_mentions: NO_PINGS },
    })) as { id: string };
  }
  return last;
}

async function handle(e: BusEvent) {
  if (!("ticketId" in e)) return;
  const all = (await listDiscordIntegrations(e.orgId)).filter((i) => i.enabled);
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
              getDiscordIntegration(integrationId, orgId),
            ]);
            if (fresh && current?.enabled) await ensureNotification(current, fresh);
          }),
        );
        break;
      }
      case "ticket.escalated": {
        const had = ticket.discord?.notifications?.[i.id];
        if (notifyOn.includes("ticket.escalated") || had) {
          const n = await ensureNotification(i, ticket);
          if (n?.threadId) {
            await postChunks(
              i,
              n.threadId,
              `🙋 **AI escalated this ticket**${e.reason ? ` — ${truncate(e.reason, 500)}` : ""}`,
            ).catch(() => {});
          }
        }
        scheduleCardUpdate(ticket.id, e.orgId);
        break;
      }
      case "draft.ready": {
        if (notifyOn.includes("draft.ready")) await ensureNotification(i, ticket);
        scheduleCardUpdate(ticket.id, e.orgId);
        break;
      }
      case "message.created": {
        if (e.kind === "event") break;
        const [m] = await db.select().from(messages).where(eq(messages.id, e.messageId));
        if (!m) break;
        let n = ticket.discord?.notifications?.[i.id];
        if (!n && m.authorType === "customer" && notifyOn.includes("message.customer")) {
          n = (await ensureNotification(i, ticket)) ?? undefined;
        }
        if (n?.threadId && i.config.threadSync) {
          // The opening message is already shown in the card.
          const first = await opener(ticket.id);
          if (first?.id !== m.id && shouldMirror(m, n.threadId)) {
            await postChunks(i, n.threadId, threadMessage(m)).catch((err) =>
              console.warn("[discord] thread sync failed:", discordError(err)),
            );
          }
        }
        if (n) scheduleCardUpdate(ticket.id, e.orgId);
        break;
      }
      case "ticket.updated":
      case "ai.state": {
        if (ticket.discord?.notifications?.[i.id]) scheduleCardUpdate(ticket.id, e.orgId);
        break;
      }
    }
    // Re-read so later integrations see refs written above.
    ticket = (await getTicket(e.orgId, e.ticketId)) ?? ticket;
  }
}

export function startNotifications() {
  bus.on("event", (e: BusEvent) => {
    if (!("ticketId" in e)) return;
    chain(e.ticketId, () => handle(e));
  });
}

/** Public replies on Discord-originated tickets are posted into the customer's intake thread. */
export function registerDiscordDelivery() {
  registerDeliverer("discord", async (ticket, message) => {
    const intake = ticket.discord?.intake;
    if (!intake) throw new Error("ticket has no Discord thread to reply in");
    const i = await getDiscordIntegration(intake.integrationId, ticket.orgId);
    if (!i || !i.enabled) throw new Error("the Discord integration for this ticket is disconnected");
    const name = message.authorName ?? (message.authorType === "ai" ? "AI assistant" : "Support");
    const target = intake.threadId ?? intake.channelId;
    const sent = await postChunks(i, target, `**${name}:** ${message.body}`);
    await new Trace(ticket.orgId, ticket.id).event("discord.reply", "integration", "replied in Discord thread", {
      channelId: target,
    });
    return { discord: { channelId: target, messageId: sent?.id ?? "" } };
  });
}
