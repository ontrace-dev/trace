import { bus, type BusEvent } from "../../lib/bus.ts";
import { getSettings } from "../workspace.ts";

/** How long chat notifications wait for the AI's triage + draft before posting anyway. */
export const AI_SETTLE_TIMEOUT_MS = 60_000;

/**
 * Run `cb` once the AI has finished with a new ticket (draft ready, escalated, replied, failed, …)
 * so chat notifications arrive with summary, triage and suggested reply attached. Falls back after
 * a timeout, and runs immediately when the workspace's AI agent is off — tickets never get stuck.
 */
export async function whenAiSettled(
  orgId: string,
  ticketId: string,
  cb: (why: "settled" | "timeout" | "ai-off") => void,
) {
  const settings = await getSettings(orgId);
  if (!settings.ai.enabled) {
    cb("ai-off");
    return;
  }
  let done = false;
  const finish = (why: "settled" | "timeout") => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    bus.off(`org:${orgId}`, listener);
    cb(why);
  };
  const listener = (e: BusEvent) => {
    if (!("ticketId" in e) || e.ticketId !== ticketId) return;
    if (e.type === "draft.ready" || e.type === "ticket.escalated") finish("settled");
    if (e.type === "ai.state" && e.state !== "processing") finish("settled");
  };
  const timer = setTimeout(() => finish("timeout"), AI_SETTLE_TIMEOUT_MS);
  bus.on(`org:${orgId}`, listener);
}
