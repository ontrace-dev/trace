import { ago } from "./utils";

/**
 * Whose turn it is on a ticket and how long the customer has waited, so every list describes it the same way.
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
