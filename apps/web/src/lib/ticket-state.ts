import { ago } from "./utils";

/**
 * One plain answer to "what's going on with this ticket?", shared by Home, the inbox list and the thread:
 * whose turn it is, how long the customer has waited, and what the AI is doing — in that order of importance.
 */

export type Tone = "warn" | "danger" | "accent" | "ok" | "muted" | "plain";

export interface TicketLike {
  status: string;
  aiState: string;
  lastCustomerMessageAt?: string | null;
  firstRespondedAt?: string | null;
  firstResponseDueAt?: string | null;
  createdAt: string;
  lastAuthorType?: string | null;
}

export interface Turn {
  /** us: the customer is waiting for a reply · customer: we're waiting for them · done: resolved or closed */
  who: "us" | "customer" | "done";
  label: string;
  tone: Tone;
  /** First reply is overdue. */
  late: boolean;
}

export function turnOf(t: TicketLike): Turn {
  if (t.status === "resolved" || t.status === "closed")
    return { who: "done", label: "Resolved", tone: "ok", late: false };
  if (t.status === "pending") return { who: "customer", label: "Waiting on customer", tone: "muted", late: false };
  const since = t.lastCustomerMessageAt ?? t.createdAt;
  const late = !t.firstRespondedAt && !!t.firstResponseDueAt && new Date(t.firstResponseDueAt).getTime() < Date.now();
  const waited = ago(since);
  return {
    who: "us",
    label: waited === "now" ? "Just arrived" : `Waiting ${waited}`,
    tone: late ? "warn" : "plain",
    late,
  };
}

/** The AI's part, only when it changes what a person should do. */
export function aiTagOf(aiState: string, agentName: string): { label: string; tone: Tone; pulse?: boolean } | null {
  switch (aiState) {
    case "draft_ready":
      return { label: "Draft ready", tone: "accent" };
    case "processing":
      return { label: `${agentName} is working`, tone: "accent", pulse: true };
    case "awaiting_approval":
      return { label: "Needs approval", tone: "warn" };
    case "escalated":
      return { label: "Handed off", tone: "warn" };
    case "error":
      return { label: "AI failed", tone: "danger" };
    case "auto_replied":
      return { label: `${agentName} replied`, tone: "ok" };
    default:
      return null;
  }
}

export const toneText: Record<Tone, string> = {
  warn: "text-warn",
  danger: "text-danger",
  accent: "text-accent-text",
  ok: "text-ok",
  muted: "text-muted",
  plain: "text-fg-3",
};

export const toneDot: Record<Tone, string> = {
  warn: "bg-warn",
  danger: "bg-danger",
  accent: "bg-accent",
  ok: "bg-ok",
  muted: "bg-white/25",
  plain: "bg-white/50",
};
