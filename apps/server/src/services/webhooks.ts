import { and, eq } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { db } from "../db/index.ts";
import { integrations, messages } from "../db/schema.ts";
import { bus, type BusEvent } from "../lib/bus.ts";
import type { WebhookConfig } from "../lib/types.ts";
import { getCustomer, getTicket } from "./tickets.ts";
import { Trace } from "./tracer.ts";

export const WEBHOOK_EVENTS = [
  "ticket.created",
  "ticket.updated",
  "ticket.escalated",
  "message.created",
  "draft.ready",
] as const;

export function sign(secret: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function deliver(event: BusEvent) {
  if (!(WEBHOOK_EVENTS as readonly string[]).includes(event.type)) return;
  const hooks = await db
    .select()
    .from(integrations)
    .where(
      and(eq(integrations.orgId, event.orgId), eq(integrations.provider, "webhook"), eq(integrations.enabled, true)),
    );
  if (!hooks.length) return;
  const ticketId = "ticketId" in event ? event.ticketId : undefined;
  const ticket = ticketId ? await getTicket(event.orgId, ticketId) : undefined;
  const customer = ticket ? await getCustomer(ticket.customerId) : undefined;
  let message: typeof messages.$inferSelect | undefined;
  if (event.type === "message.created") {
    [message] = await db.select().from(messages).where(eq(messages.id, event.messageId));
    if (message?.kind === "event") return;
  }
  const payload = JSON.stringify({
    event: event.type,
    workspaceId: event.orgId,
    occurredAt: new Date().toISOString(),
    data: { ticket, customer, message, ...("changes" in event ? { changes: event.changes } : {}) },
  });
  for (const hook of hooks) {
    const cfg = hook.config as WebhookConfig;
    if (cfg.events.length && !cfg.events.includes(event.type)) continue;
    const trace = new Trace(event.orgId, ticketId ?? null);
    await trace
      .span(
        "webhook.deliver",
        "integration",
        async () => {
          const res = await fetch(cfg.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "user-agent": "trace-webhooks/1",
              "x-trace-event": event.type,
              "x-trace-signature": sign(cfg.secret, payload),
            },
            body: payload,
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`${cfg.url} responded ${res.status}`);
          return res.status;
        },
        (status) => ({ summary: `${event.type} → ${new URL(cfg.url).host} (${status})` }),
      )
      .then(() =>
        db.update(integrations).set({ status: "connected", statusMessage: null }).where(eq(integrations.id, hook.id)),
      )
      .catch((err) =>
        db
          .update(integrations)
          .set({ status: "error", statusMessage: String(err instanceof Error ? err.message : err) })
          .where(eq(integrations.id, hook.id)),
      );
  }
}

export function startWebhooks() {
  bus.on("event", (e: BusEvent) => {
    deliver(e).catch((err) => console.error("[webhooks]", err));
  });
}
