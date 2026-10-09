import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { integrations } from "../../db/schema.ts";
import { bus, type BusEvent } from "../../lib/bus.ts";
import { decrypt } from "../../lib/crypto.ts";
import type { ChatWebhookConfig } from "../../lib/types.ts";
import { renderCard as renderDiscordCard } from "../discord/notify.ts";
import { renderCard as renderSlackCard } from "../slack/notify.ts";
import { getTicket, type Ticket } from "../tickets.ts";
import { Trace } from "../tracer.ts";
import { whenAiSettled } from "./ai-settled.ts";

/**
 * "Just notify me": new tickets (and escalations) posted into a Slack or Discord channel through an
 * incoming webhook — no bot, no tokens. Messages reuse the bot cards (summary, triage, suggested reply,
 * account context) minus the interactive buttons, which webhooks can't receive.
 */

type Hook = typeof integrations.$inferSelect & { config: ChatWebhookConfig };

async function hooksFor(orgId: string) {
  const rows = await db
    .select()
    .from(integrations)
    .where(
      and(eq(integrations.orgId, orgId), eq(integrations.provider, "chat_webhook"), eq(integrations.enabled, true)),
    );
  return rows as Hook[];
}

/** Build the platform payload for a ticket. */
export async function chatPayload(platform: ChatWebhookConfig["platform"], ticket: Ticket, banner?: string) {
  if (platform === "slack") {
    const card = await renderSlackCard(ticket);
    // Keep only link buttons ("Open in trace"); action buttons need a Slack app to receive clicks.
    const blocks = card.blocks
      .map((b) => {
        const block = b as { type: string; elements?: { url?: string }[] };
        if (block.type !== "actions") return b;
        const links = (block.elements ?? []).filter((el) => el.url);
        return links.length ? { type: "actions", elements: links } : null;
      })
      .filter(Boolean);
    if (banner) blocks.unshift({ type: "section", text: { type: "mrkdwn", text: banner } });
    return { text: banner ? `${banner} — ${card.text}` : card.text, blocks, unfurl_links: false };
  }
  const { card } = await renderDiscordCard(ticket);
  // Webhook messages can't carry buttons; the embed title links to the ticket instead.
  return {
    content: banner ?? undefined,
    embeds: card.embeds,
    allowed_mentions: { parse: [] },
  };
}

async function send(url: string, payload: unknown) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "trace-notify/1" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429 && attempt === 0) {
      const retry = Number(res.headers.get("retry-after") ?? "1");
      await new Promise((r) => setTimeout(r, Math.min(10, Math.max(1, retry)) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim());
    return;
  }
}

export async function postToHook(hook: Hook, ticket: Ticket, banner?: string) {
  const trace = new Trace(ticket.orgId, ticket.id);
  const where = hook.config.platform === "slack" ? "Slack" : "Discord";
  try {
    await send(decrypt(hook.config.url), await chatPayload(hook.config.platform, ticket, banner));
    await trace.event("notify.chat_webhook", "integration", `posted to ${where} · ${hook.name}`, {
      integrationId: hook.id,
    });
    await db.update(integrations).set({ status: "connected", statusMessage: null }).where(eq(integrations.id, hook.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await trace.event("notify.chat_webhook", "integration", `${where} webhook failed: ${message}`, {
      integrationId: hook.id,
      error: true,
    });
    await db.update(integrations).set({ status: "error", statusMessage: message }).where(eq(integrations.id, hook.id));
  }
}

// Per (hook, ticket): the new-ticket message is pending until the AI settles; an escalation in that window
// is already shown on the card, so it doesn't get a second message.
const pending = new Set<string>();
const posted = new Set<string>();

async function handle(e: BusEvent) {
  if (e.type !== "ticket.created" && e.type !== "ticket.escalated") return;
  const hooks = (await hooksFor(e.orgId)).filter((h) => h.config.events.includes(e.type as "ticket.created"));
  if (!hooks.length) return;
  const { orgId, ticketId } = e;

  for (const hook of hooks) {
    const key = `${hook.id}:${ticketId}`;
    if (e.type === "ticket.created") {
      if (posted.has(key) || pending.has(key)) continue;
      const fire = async () => {
        pending.delete(key);
        if (posted.has(key)) return;
        posted.add(key);
        const ticket = await getTicket(orgId, ticketId);
        if (ticket) await postToHook(hook, ticket);
      };
      if (!hook.config.waitForAi) await fire();
      else {
        pending.add(key);
        void whenAiSettled(orgId, ticketId, () => void fire().catch((err) => console.error("[chat-webhook]", err)));
      }
    } else {
      if (pending.has(key)) continue; // the pending new-ticket card will show the escalation
      const ticket = await getTicket(orgId, ticketId);
      if (!ticket) continue;
      const reason = e.reason ? ` — ${e.reason}` : "";
      const banner =
        hook.config.platform === "slack"
          ? `:rotating_light: *Needs a human*${reason}`
          : `🚨 **Needs a human**${reason}`;
      await postToHook(hook, ticket, banner);
    }
  }
  // Keep the dedupe sets bounded.
  if (posted.size > 5000) posted.clear();
}

export function startChatWebhooks() {
  bus.on("event", (e: BusEvent) => {
    handle(e).catch((err) => console.error("[chat-webhook]", err));
  });
}
