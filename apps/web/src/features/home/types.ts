import type { ViewFilters } from "@/lib/types";

export interface QueueStats {
  total: number;
  waiting: number;
  unassigned: number;
  urgent: number;
  slaBreached: number;
  slaSoon: number;
  drafts: number;
  approvals: number;
  escalated: number;
  oldestWaitingAt: string | null;
  /** New tickets per day for the last 7 days, oldest first. */
  trend: number[];
}

export interface QueueRow {
  id: string;
  name: string;
  icon: string;
  system: boolean;
  filters: ViewFilters;
  stats: QueueStats;
}

export type NeedKind =
  | "approval"
  | "sla_breached"
  | "escalated"
  | "ai_error"
  | "sla_soon"
  | "mine_waiting"
  | "urgent_unassigned"
  | "draft_ready";

export interface NeedItem {
  ticketId: string;
  number: number;
  subject: string;
  priority: string;
  channel: string;
  status: string;
  aiSummary: string | null;
  aiConfidence: number | null;
  aiIntent: string | null;
  aiSentiment: string | null;
  aiAt: string | null;
  draft: { confidence: number; sources: number } | null;
  assigneeName: string | null;
  customerName: string | null;
  customerEmail: string | null;
  firstResponseDueAt: string | null;
  waitingSince: string;
  kinds: NeedKind[];
  approval: { runId: string; title: string; reason: string | null; requestedAt: string } | null;
  score: number;
}

export interface HotTopic {
  kind: "intent" | "tag";
  key: string;
  recent: number;
  baseline: number;
  lift: number;
  daily: number[];
  open: number;
  samples: { number: number; subject: string }[];
}

export interface HomeData {
  needs: { items: NeedItem[]; total: number; counts: Record<NeedKind, number> };
  hot: HotTopic[];
  pulse: {
    tickets: {
      active: number;
      waiting: number;
      pending: number;
      new24h: number;
      newPrev24h: number;
      resolved24h: number;
      resolvedByAi24h: number;
      slaBreached: number;
      escalated: number;
    };
    ai: {
      worked: number;
      drafted: number;
      sent: number;
      avgConfidence: number | null;
      autoReplies: number;
      approvals: number;
      escalated: number;
    };
    medianFirstResponseSeconds: number | null;
  };
  queues: QueueRow[];
}

export const homeKeys = {
  home: (wid: string) => ["home", wid] as const,
  views: (wid: string) => ["views-overview", wid] as const,
};
