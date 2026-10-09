import type { ActionRun } from "@/lib/types";

export interface ActionParameter {
  name: string;
  type: "string" | "number" | "integer" | "boolean";
  description: string;
  required: boolean;
  enum?: string[];
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Action {
  id: string;
  name: string;
  title: string;
  description: string;
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  bodyFormat: "json" | "form" | "none";
  parameters: ActionParameter[];
  requiresApproval: boolean;
  readOnly: boolean;
  enabled: boolean;
  timeoutMs: number;
  preset: string | null;
  updatedAt: string;
}

export interface ActionPreset extends Omit<Action, "id" | "enabled" | "timeoutMs" | "preset" | "updatedAt"> {
  id: string;
  group: string;
  secrets: string[];
  setup: string;
}

export interface Procedure {
  id: string;
  name: string;
  trigger: string;
  instructions: string;
  enabled: boolean;
  position: number;
}

export interface Secret {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActionResult {
  ok: boolean;
  status: number | null;
  output: string;
  error?: string;
  durationMs: number;
  request: { method: string; url: string };
}

export type InboxRun = ActionRun & {
  ticketNumber: number | null;
  ticketSubject: string | null;
  ticketRef: string | null;
};

export interface McpTool {
  id: string;
  serverId: string;
  name: string;
  toolName: string;
  title: string | null;
  description: string;
  inputSchema: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
  enabled: boolean;
  readOnly: boolean;
  requiresApproval: boolean;
}

export interface McpServer {
  id: string;
  name: string;
  slug: string;
  transport: "http" | "sse" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  authType: "none" | "headers" | "oauth";
  enabled: boolean;
  status: "pending" | "connected" | "needs_auth" | "error";
  statusMessage: string | null;
  instructions: string | null;
  lastSyncedAt: string | null;
  headerNames: string[];
  envNames: string[];
  signedIn: boolean;
  tools: McpTool[];
}

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  url: string;
  transport: "http" | "sse";
  authType: "none" | "headers" | "oauth";
  tokenHeader?: { name: string; prefix: string; hint: string };
}

export type McpSyncResult =
  | { ok: true; tools: number }
  | { ok: false; needsAuth: true; authorizeUrl?: string }
  | { ok: false; error: string };

export const automationKeys = {
  mcp: (wid: string) => ["automation", wid, "mcp"] as const,
  actions: (wid: string) => ["automation", wid, "actions"] as const,
  presets: (wid: string) => ["automation", wid, "presets"] as const,
  procedures: (wid: string) => ["automation", wid, "procedures"] as const,
  secrets: (wid: string) => ["automation", wid, "secrets"] as const,
  runs: (wid: string, status: string) => ["automation", wid, "runs", status] as const,
};

/** Pretty-print a JSON response body; leave anything else untouched. */
export function prettyJson(text: string | null | undefined) {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function hostOf(url: string) {
  const m = url.match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1]! : url;
}
