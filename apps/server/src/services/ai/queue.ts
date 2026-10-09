import { bus, type BusEvent } from "../../lib/bus.ts";
import { runTicketAgent } from "./agent.ts";

/**
 * Debounced in-process queue: a burst of customer messages on the same ticket triggers one agent
 * run. Concurrency is capped so a flood of inbound mail doesn't fan out unbounded model calls.
 */
const DEBOUNCE_MS = 1200;
const MAX_CONCURRENT = 4;

const timers = new Map<string, NodeJS.Timeout>();
const waiting: { orgId: string; ticketId: string; force?: boolean }[] = [];
let active = 0;

function pump() {
  while (active < MAX_CONCURRENT && waiting.length) {
    const job = waiting.shift()!;
    active++;
    runTicketAgent(job.orgId, job.ticketId, { force: job.force })
      .catch((err) => console.error("[ai-queue]", err))
      .finally(() => {
        active--;
        pump();
      });
  }
}

export function enqueueAgent(orgId: string, ticketId: string, opts: { force?: boolean; immediate?: boolean } = {}) {
  const existing = timers.get(ticketId);
  if (existing) clearTimeout(existing);
  const push = () => {
    timers.delete(ticketId);
    waiting.push({ orgId, ticketId, force: opts.force });
    pump();
  };
  if (opts.immediate) push();
  else timers.set(ticketId, setTimeout(push, DEBOUNCE_MS));
}

export function startAiQueue() {
  bus.on("event", (e: BusEvent) => {
    if (e.type === "message.created" && e.authorType === "customer" && e.kind === "message" && !e.skipAi) {
      enqueueAgent(e.orgId, e.ticketId);
    }
  });
}
