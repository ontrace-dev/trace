import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/*
 * Ticket state in words, the same everywhere (inbox, Home, ticket header). Colors follow the helpdesk
 * convention people already know from Zendesk: New amber, Open red, Pending blue, Solved grey.
 */

interface StatusInput {
  status: string;
  firstRespondedAt?: string | null;
  assigneeId?: string | null;
}

export function statusLabel(t: StatusInput) {
  if (t.status === "resolved") return "Solved";
  if (t.status === "closed") return "Closed";
  if (t.status === "pending") return "Pending";
  // Nobody has touched it yet: no reply and no owner.
  if (!t.firstRespondedAt && !t.assigneeId) return "New";
  return "Open";
}

const STATUS_STYLE: Record<string, string> = {
  New: "bg-warn/15 text-warn",
  Open: "bg-danger/15 text-danger",
  Pending: "bg-info/15 text-info",
  Solved: "bg-white/[0.07] text-muted",
  Closed: "bg-white/[0.07] text-muted",
};

const STATUS_HINT: Record<string, string> = {
  New: "Nobody has replied or picked this up yet",
  Open: "The customer is waiting for a reply",
  Pending: "Waiting for the customer to reply",
  Solved: "Solved; a customer reply reopens it",
  Closed: "Closed",
};

const pill = "inline-flex h-5 shrink-0 items-center gap-1 px-1.5 text-[11.5px] font-medium whitespace-nowrap";

export function StatusPill({ t, className }: { t: StatusInput; className?: string }) {
  const label = statusLabel(t);
  return (
    <span title={STATUS_HINT[label]} className={cn(pill, STATUS_STYLE[label], className)}>
      {label}
    </span>
  );
}

const AI: Record<string, { label: string; style: string; hint: string }> = {
  processing: { label: "AI working", style: "bg-accent/15 text-accent-text", hint: "The AI is reading and replying" },
  draft_ready: {
    label: "AI drafted",
    style: "bg-accent/15 text-accent-text",
    hint: "The AI wrote a reply; review and send it",
  },
  auto_replied: {
    label: "AI replied",
    style: "border border-accent/30 text-accent-text",
    hint: "The AI answered the customer on its own",
  },
  escalated: { label: "AI handed off", style: "bg-warn/15 text-warn", hint: "The AI couldn't answer; a person must" },
  awaiting_approval: {
    label: "Needs approval",
    style: "bg-warn/15 text-warn",
    hint: "The AI wants to take an action and needs your OK",
  },
  error: { label: "AI failed", style: "bg-danger/15 text-danger", hint: "The AI hit an error; open to retry" },
};

export function AiPill({ state, className }: { state: string; className?: string }) {
  const a = AI[state];
  if (!a) return null;
  return (
    <span title={a.hint} className={cn(pill, a.style, className)}>
      <Sparkles className={cn("size-3", state === "processing" && "animate-pulse")} />
      {a.label}
    </span>
  );
}

/** Unread customer messages, Chatwoot-style: a filled count. */
export function UnreadBadge({ n, className }: { n: number; className?: string }) {
  if (!n) return null;
  return (
    <span
      title={`${n} unread message${n === 1 ? "" : "s"}`}
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center bg-accent px-1 text-[11.5px] font-semibold text-[#0b0b0e] tabular-nums",
        className,
      )}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

export const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  widget: "Chat",
  portal: "Portal",
  slack: "Slack",
  discord: "Discord",
  api: "API",
  web: "Created by team",
};
