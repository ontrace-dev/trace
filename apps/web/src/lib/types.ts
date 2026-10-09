export type TicketStatus = "open" | "pending" | "resolved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketChannel = "email" | "widget" | "api" | "slack" | "discord" | "web";
export type AiState =
  | "none"
  | "processing"
  | "draft_ready"
  | "auto_replied"
  | "escalated"
  | "awaiting_approval"
  | "error";

export interface Source {
  type: "article" | "ticket" | "document";
  id: string;
  title: string;
  url?: string | null;
  /** Connector a document came from: website, confluence, jira, notion, zendesk, files. */
  origin?: string;
  visibility?: "public" | "internal";
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
}

export interface TicketListItem {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  channel: TicketChannel;
  tags: string[];
  aiState: AiState;
  aiConfidence: number | null;
  aiSummary: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  lastMessageAt: string;
  lastCustomerMessageAt: string | null;
  firstResponseDueAt: string | null;
  firstRespondedAt: string | null;
  createdAt: string;
  customer: { id: string; name: string | null; email: string | null; avatarUrl: string | null } | null;
  preview: string | null;
}

export interface Ticket {
  id: string;
  orgId: string;
  number: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  channel: TicketChannel;
  channelId: string | null;
  customerId: string | null;
  assigneeId: string | null;
  tags: string[];
  aiState: AiState;
  aiSummary: string | null;
  aiIntent: string | null;
  aiLanguage: string | null;
  aiSentiment: string | null;
  aiConfidence: number | null;
  firstResponseDueAt: string | null;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  lastMessageAt: string;
  createdAt: string;
  assignedAt: string | null;
  /** Set when trace auto-assigned the ticket. */
  routing: import("@/features/routing/types").TicketRouting | null;
  slack: {
    notifications?: Record<string, { channel: string; ts: string }>;
    intake?: { channel: string; ts: string };
  } | null;
}

export interface Message {
  id: string;
  ticketId: string;
  kind: "message" | "note" | "event";
  authorType: "customer" | "agent" | "ai" | "system";
  authorId: string | null;
  authorName: string | null;
  body: string;
  html: string | null;
  attachments: Attachment[];
  meta: {
    sources?: Source[];
    via?: string;
    delivery?: { status: "sent" | "failed"; error?: string };
    slack?: { channel: string; ts: string; user?: string };
    discord?: { channelId: string; messageId: string; user?: string };
    action?: { runId: string; name: string; status: ActionRunStatus };
  };
  createdAt: string;
}

export interface Customer {
  id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  avatarUrl: string | null;
  attributes: Record<string, unknown>;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface Draft {
  id: string;
  body: string;
  confidence: number;
  sources: Source[];
  reasoning: string | null;
  createdAt: string;
}

export interface Span {
  id: string;
  traceId: string;
  name: string;
  kind: "ai" | "tool" | "integration" | "system";
  status: "ok" | "error";
  summary: string | null;
  attributes: Record<string, unknown>;
  startedAt: string;
  durationMs: number;
}

export type ActionRunStatus = "pending_approval" | "running" | "succeeded" | "failed" | "rejected";

export interface ActionRun {
  id: string;
  ticketId: string | null;
  actionId: string | null;
  actionName: string;
  actionTitle: string;
  input: Record<string, unknown>;
  reason: string | null;
  status: ActionRunStatus;
  httpStatus: number | null;
  output: string | null;
  error: string | null;
  requestedBy: "ai" | "agent";
  /** Set when the run is a call to a connected MCP server's tool. */
  mcpToolId: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface TicketDetail {
  ticket: Ticket;
  messages: Message[];
  customer: Customer | null;
  customerStats: { total: number; open: number } | null;
  recent: { id: string; number: number; subject: string; status: TicketStatus; createdAt: string }[];
  draft: Draft | null;
  assignee: { id: string; name: string; email: string; image: string | null } | null;
  traces: { traceId: string; spans: Span[] }[];
  runs: ActionRun[];
  fields: import("@/features/issues/types").ResolvedField[];
  links: import("@/features/issues/types").IssueLink[];
}

export interface Member {
  id: string;
  memberId: string;
  name: string;
  email: string;
  image: string | null;
  role: string;
}

export interface ViewFilters {
  status?: TicketStatus[];
  priority?: TicketPriority[];
  channel?: string[];
  tags?: string[];
  assignee?: string;
  aiState?: string[];
  q?: string;
}

export interface View {
  id: string;
  name: string;
  icon: string;
  filters: ViewFilters;
  position: number;
}

export interface AiSettings {
  enabled: boolean;
  agentName: string;
  mode: "draft" | "auto";
  autoSendThreshold: number;
  tone: "friendly" | "formal" | "concise";
  guidance: string;
  neverAutoSend: string[];
  widgetInstantAnswers: boolean;
  autoTriage: boolean;
  model: string;
  effort: "low" | "medium" | "high";
  hasApiKey?: boolean;
  apiKey?: string;
}

export interface WidgetSettings {
  title: string;
  subtitle: string;
  greeting: string;
  agentName: string;
  avatarUrl: string;
  accentColor: string;
  accentForeground: string;
  theme: "light" | "dark" | "auto";
  position: "right" | "left";
  offsetX: number;
  offsetY: number;
  radius: number;
  fontFamily: string;
  launcherIcon: "chat" | "help" | "sparkle" | "wave";
  launcherText: string;
  suggestions: string[];
  requireEmail: boolean;
  showPoweredBy: boolean;
  aiInstantAnswers: boolean;
  allowedOrigins: string[];
  identitySecret?: string;
  customCss: string;
}

export interface WorkspaceSettings {
  orgId: string;
  ticketPrefix: string;
  accentColor: string;
  timezone: string;
  widgetKey: string;
  ai: AiSettings;
  widget: WidgetSettings;
  sla: { firstResponse: Record<TicketPriority, number> };
}

export interface Bootstrap {
  org: { id: string; name: string; slug: string; logo: string | null };
  role: string;
  settings: WorkspaceSettings;
  members: Member[];
  views: View[];
  channels: { id: string; type: string; name: string }[];
  ai: { online: boolean; model: string };
  env: { publicUrl: string; inboundDomain: string; smtpPort: number };
}

export interface Article {
  id: string;
  title: string;
  body: string;
  status: "draft" | "published";
  tags: string[];
  source: "manual" | "ai";
  views: number;
  citations: number;
  updatedAt: string;
  excerpt?: string;
  sourceTicketId?: string | null;
}

export interface Integration {
  id: string;
  provider: "slack" | "discord" | "webhook" | "chat_webhook";
  name: string;
  enabled: boolean;
  status: "connected" | "error" | "pending";
  statusMessage: string | null;
  externalId: string | null;
  config: Record<string, unknown>;
  createdAt: string;
}
