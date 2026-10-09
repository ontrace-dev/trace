export interface RoutingSettings {
  enabled: boolean;
  triggers: {
    handoff: boolean;
    approval: boolean;
    lowConfidence: boolean;
    confidenceBelow: number;
    slaSoon: boolean;
    slaMinutes: number;
    everyTicket: boolean;
  };
  method: "least_open" | "round_robin";
  maxOpenPerAgent: number;
  stickyHours: number;
  skipAway: boolean;
  reassign: { enabled: boolean; minutesBeforeDue: number; maxTimes: number };
  fallbackGroupId: string | null;
}

export interface RoutingConditions {
  intents?: string[];
  tags?: string[];
  languages?: string[];
  channels?: string[];
  priorities?: string[];
  plans?: string[];
  minMrr?: number | null;
}

export interface RoutingGroup {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
  available: number;
  open: number;
}

export interface RoutingRule {
  id: string;
  position: number;
  enabled: boolean;
  match: "any" | "all";
  conditions: RoutingConditions;
  groupId: string;
  label: string;
}

export interface RoutingData {
  settings: RoutingSettings;
  groups: RoutingGroup[];
  rules: RoutingRule[];
  statuses: Record<string, "available" | "away">;
}

export interface RoutingLogEntry {
  id: string;
  name: string;
  summary: string | null;
  at: string;
  number: number;
  subject: string;
}

export interface TicketRouting {
  auto: boolean;
  trigger: string;
  groupId: string | null;
  groupName: string | null;
  ruleId: string | null;
  ruleLabel: string;
  pick: string;
  because: string;
  at: string;
  reassignments: number;
}

export const routingKeys = {
  all: (wid: string) => ["routing", wid] as const,
  log: (wid: string) => ["routing", wid, "log"] as const,
  me: (wid: string) => ["routing", wid, "me"] as const,
};

/** Condition parts for display: [["intent", "billing issue, refund"], ["tag", "#billing"]]. */
export function conditionParts(c: RoutingConditions): [string, string][] {
  const h = (xs: string[]) => xs.map((x) => x.replace(/_/g, " ")).join(", ");
  const parts: [string, string][] = [];
  if (c.intents?.length) parts.push(["intent", h(c.intents)]);
  if (c.tags?.length) parts.push(["tag", c.tags.map((t) => `#${t}`).join(" ")]);
  if (c.languages?.length) parts.push(["language", c.languages.join(", ")]);
  if (c.channels?.length) parts.push(["channel", c.channels.join(", ")]);
  if (c.priorities?.length) parts.push(["priority", c.priorities.join(", ")]);
  if (c.plans?.length) parts.push(["plan", c.plans.join(", ")]);
  if (c.minMrr != null) parts.push(["MRR ≥", c.minMrr.toLocaleString()]);
  return parts;
}
