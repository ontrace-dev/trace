export type FieldType = "text" | "number" | "select" | "multiselect" | "checkbox" | "date" | "url";
export interface FieldOption {
  value: string;
  /** Semantic tone: danger, info, warn, ok, neutral. */
  color?: string;
}

/** A field definition with this ticket's value. */
export interface ResolvedField {
  key: string;
  label: string;
  type: FieldType;
  options: FieldOption[];
  shown: "header" | "panel" | "hidden";
  source: "ai" | "customer" | "manual";
  requiredToResolve: boolean;
  system: boolean;
  value: string | number | boolean | string[] | null;
  setBy: "ai" | "human" | "customer" | null;
  corrected: boolean;
}

export interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  options: FieldOption[];
  source: "ai" | "customer" | "manual";
  customerAttribute: string | null;
  aiInstruction: string;
  shown: "header" | "panel" | "hidden";
  requiredToResolve: boolean;
  position: number;
  system: boolean;
}

export type IssueStatusCategory = "todo" | "started" | "done" | "canceled";

export interface IssueLink {
  id: string;
  provider: "linear" | "jira";
  key: string;
  url: string;
  title: string;
  status: string;
  statusCategory: IssueStatusCategory;
  createdByTrace: boolean;
  tickets: number;
}

export interface Tracker {
  id: string;
  provider: "linear" | "jira";
  name: string;
  status: "connected" | "error";
  statusMessage: string | null;
  config: {
    defaultTeamId?: string;
    defaultProjectKey?: string;
    typeLabels?: Record<string, string>;
    typeIssueTypes?: Record<string, string>;
    site?: string;
    email?: string;
    workspace?: string;
  };
  containers: { id: string; key: string; name: string }[];
}

export interface SimilarIssue {
  key: string;
  url: string;
  title: string;
  status: string;
  statusCategory: IssueStatusCategory;
  tickets: number;
}

export const issueKeys = {
  trackers: (wid: string) => ["issues", wid, "trackers"] as const,
  fields: (wid: string) => ["fields", wid] as const,
};

/** Text tone for a semantic option color. */
export const toneText: Record<string, string> = {
  danger: "text-danger",
  info: "text-info",
  warn: "text-warn",
  ok: "text-ok",
  neutral: "text-fg-2",
};
export const toneDot: Record<string, string> = {
  danger: "bg-danger",
  info: "bg-info",
  warn: "bg-warn",
  ok: "bg-ok",
  neutral: "bg-white/40",
};
export const statusDot: Record<IssueStatusCategory, string> = {
  todo: "bg-white/40",
  started: "bg-info",
  done: "bg-ok",
  canceled: "bg-white/20",
};

export const PROVIDER = { linear: "Linear", jira: "Jira" } as const;

export function showValue(v: ResolvedField["value"]) {
  if (v == null || v === "") return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}
