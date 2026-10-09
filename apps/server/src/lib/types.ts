export type Effort = "low" | "medium" | "high";

export interface AiSettings {
  /** Master switch for the AI agent in this workspace. */
  enabled: boolean;
  /** Display name of the agent persona. */
  agentName: string;
  /**
   * draft: triage + draft replies for humans to approve
   * auto:  send replies automatically when confidence >= threshold and policy allows
   */
  mode: "draft" | "auto";
  autoSendThreshold: number;
  tone: "friendly" | "formal" | "concise";
  /** Free-form instructions, like a system prompt addendum written by the team. */
  guidance: string;
  /** Topics that must never be auto-sent (e.g. "refund", "legal", "security"). */
  neverAutoSend: string[];
  /** Answer widget visitors instantly. */
  widgetInstantAnswers: boolean;
  autoTriage: boolean;
  model: string;
  effort: Effort;
  /** Bring-your-own Anthropic key (falls back to ANTHROPIC_API_KEY). */
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
  identitySecret: string;
  customCss: string;
}

export interface SlaSettings {
  /** First-response target in minutes, per priority. */
  firstResponse: Record<"low" | "normal" | "high" | "urgent", number>;
}

/** Auto-assignment: who gets a ticket once it needs a human. */
export interface RoutingSettings {
  enabled: boolean;
  triggers: {
    /** trace escalated the ticket. */
    handoff: boolean;
    /** An action waits for human approval. */
    approval: boolean;
    /** trace's draft is below `confidenceBelow`. */
    lowConfidence: boolean;
    confidenceBelow: number;
    /** The first reply is due within `slaMinutes` (even if trace is still working). */
    slaSoon: boolean;
    slaMinutes: number;
    /** Classic mode: assign every new ticket right away. */
    everyTicket: boolean;
  };
  method: "least_open" | "round_robin";
  /** Skip people at or above this many open tickets. 0 = no cap. */
  maxOpenPerAgent: number;
  /** Prefer the customer's last assignee within this many hours. 0 = off. */
  stickyHours: number;
  skipAway: boolean;
  reassign: { enabled: boolean; minutesBeforeDue: number; maxTimes: number };
  /** Used when no rule matches, or nobody in the matched group is available. */
  fallbackGroupId: string | null;
}

export interface RoutingConditions {
  intents?: string[];
  tags?: string[];
  languages?: string[];
  channels?: string[];
  priorities?: string[];
  /** customer.attributes.plan */
  plans?: string[];
  /** customer.attributes.mrr, parsed as a number */
  minMrr?: number;
}

export type RoutingTrigger = "handoff" | "approval" | "low_confidence" | "ai_error" | "sla" | "new" | "reassign";

/** Why a ticket was assigned to who it was — shown on the ticket and in the routing log. */
export interface TicketRouting {
  auto: boolean;
  trigger: RoutingTrigger;
  groupId: string | null;
  groupName: string | null;
  ruleId: string | null;
  /** "01 · intent billing issue" or "fallback". */
  ruleLabel: string;
  /** "fewest open (3 vs 5)", "same customer 2d ago", … */
  pick: string;
  /** "trace's draft 48% < 70%", "trace handed off", … */
  because: string;
  at: string;
  reassignments: number;
}

export interface ViewFilters {
  status?: ("open" | "pending" | "resolved" | "closed")[];
  priority?: ("low" | "normal" | "high" | "urgent")[];
  channel?: string[];
  tags?: string[];
  assignee?: "me" | "none" | string;
  aiState?: string[];
  q?: string;
}

export interface EmailChannelConfig {
  fromName?: string;
  signature?: string;
  /** Optional per-channel SMTP override, e.g. smtp://user:pass@smtp.postmarkapp.com:587 */
  smtpUrl?: string;
  autoAcknowledge?: boolean;
}

export type ChannelConfig = EmailChannelConfig & Record<string, unknown>;

export interface SlackChannelRef {
  id: string;
  name: string;
}

export interface SlackConfig {
  kind: "slack";
  botToken: string;
  /** App-level token (xapp-…) enables Socket Mode — no public URL required. */
  appToken?: string;
  signingSecret?: string;
  teamId?: string;
  teamName?: string;
  botUserId?: string;
  notifyChannel?: SlackChannelRef;
  intakeChannels: SlackChannelRef[];
  notifyOn: ("ticket.created" | "ticket.escalated" | "draft.ready" | "message.customer")[];
  threadSync: boolean;
  /** Post new-ticket cards once the AI has triaged + drafted (max 60s). Default true. */
  waitForAi?: boolean;
}

export interface WebhookConfig {
  kind: "webhook";
  url: string;
  secret: string;
  events: string[];
}

export interface DiscordChannelRef {
  id: string;
  name: string;
  /** "text" channels get a thread per ticket; "forum" channels turn each post into a ticket. */
  type?: "text" | "forum";
}

export interface DiscordConfig {
  kind: "discord";
  /** Bot token, encrypted with lib/crypto.ts. */
  botToken: string;
  applicationId: string;
  botUserId?: string;
  botName?: string;
  guildId?: string;
  guildName?: string;
  notifyChannel?: DiscordChannelRef;
  intakeChannels: DiscordChannelRef[];
  notifyOn: ("ticket.created" | "ticket.escalated" | "draft.ready" | "message.customer")[];
  threadSync: boolean;
  /** Post new-ticket cards once the AI has triaged + drafted (max 60s). Default true. */
  waitForAi?: boolean;
  /** Discord has no emails: teammates link their Discord account to their trace user here. */
  userLinks: { discordUserId: string; discordName: string; userId: string }[];
}

/** "Just notify me": post new tickets into a Slack or Discord channel via an incoming webhook — no bot. */
export interface ChatWebhookConfig {
  kind: "chat_webhook";
  platform: "slack" | "discord";
  /** Encrypted incoming-webhook URL (lib/crypto.ts). */
  url: string;
  events: ("ticket.created" | "ticket.escalated")[];
  /** Wait for the AI's summary + draft before posting (max 60s). */
  waitForAi: boolean;
}

/** Linear: personal API key (encrypted). Type → label ids applied when filing. */
export interface LinearConfig {
  kind: "linear";
  apiKey: string;
  workspace?: string;
  defaultTeamId?: string;
  /** classification value → Linear label id */
  typeLabels?: Record<string, string>;
}

/** Jira Cloud: site + email + API token (encrypted). Type → issue type name when filing. */
export interface JiraConfig {
  kind: "jira";
  site: string;
  email: string;
  apiToken: string;
  defaultProjectKey?: string;
  /** classification value → Jira issue type name (Bug, Story, Task) */
  typeIssueTypes?: Record<string, string>;
}

export type IntegrationConfig =
  | SlackConfig
  | DiscordConfig
  | WebhookConfig
  | ChatWebhookConfig
  | LinearConfig
  | JiraConfig;

// ---------------------------------------------------------------- ticket fields

export type FieldType = "text" | "number" | "select" | "multiselect" | "checkbox" | "date" | "url";
export interface FieldOption {
  value: string;
  color?: string;
}
/** Where a field's value comes from: trace fills it, it's read from the customer record, or people set it. */
export type FieldSource = "ai" | "customer" | "manual";

export interface TicketFieldValue {
  value: string | number | boolean | string[] | null;
  /** Who set it. "customer" values are resolved live and never stored. */
  source: "ai" | "human";
  at: string;
  by?: string | null;
  /** A person changed a value trace had set — used to learn and to measure accuracy. */
  corrected?: boolean;
  /** trace's original value, kept when a person corrects it. */
  aiValue?: TicketFieldValue["value"];
}

export interface TicketEmailMeta {
  channelAddress?: string;
  /** Message-IDs in this thread (for References header). */
  references: string[];
  lastMessageId?: string;
  cc?: string[];
}

export interface TicketDiscordMeta {
  /** Notification card (and its thread, if created) per Discord integration. */
  notifications?: Record<string, { channelId: string; messageId: string; threadId?: string }>;
  /** Set when the ticket originated in a Discord intake channel; replies go to threadId. */
  intake?: { integrationId: string; channelId: string; messageId: string; threadId?: string };
}

export interface TicketSlackMeta {
  /** Notification thread per Slack integration. */
  notifications?: Record<string, { channel: string; ts: string }>;
  /** Set when the ticket originated in a Slack intake channel. */
  intake?: { integrationId: string; channel: string; ts: string; teamId?: string };
}

/** Something the agent relied on: a help article, a past ticket, or a synced knowledge document. */
export interface Source {
  type: "article" | "ticket" | "document";
  id: string;
  title: string;
  url?: string | null;
  /** For documents: which connector it came from (confluence, jira, website, …). */
  origin?: string;
  visibility?: "public" | "internal";
}

// ---------------------------------------------------------------- knowledge sources

export interface WebsiteSourceConfig {
  type: "website";
  /** Start URL; pages under the same origin and path prefix are crawled. */
  url: string;
  maxPages: number;
  /** Optional path prefixes to include (defaults to the start URL's path). */
  include?: string[];
  exclude?: string[];
}
export interface ConfluenceSourceConfig {
  type: "confluence";
  /** e.g. https://acme.atlassian.net/wiki */
  baseUrl: string;
  email: string;
  spaceKeys: string[];
  /** Optional extra CQL filter, e.g. label = "public" */
  cql?: string;
}
export interface JiraSourceConfig {
  type: "jira";
  /** e.g. https://acme.atlassian.net */
  baseUrl: string;
  email: string;
  jql: string;
  maxIssues: number;
  includeComments: boolean;
}
export interface NotionSourceConfig {
  type: "notion";
  /** Optional: only pages whose title contains this text; the integration only sees pages shared with it. */
  query?: string;
  maxPages: number;
}
export interface ZendeskSourceConfig {
  type: "zendesk";
  /** Help Center subdomain, e.g. "acme" for acme.zendesk.com */
  subdomain: string;
  locale?: string;
  /** Optional: an agent email for private articles (token in secret). */
  email?: string;
}
export interface FilesSourceConfig {
  type: "files";
}
export type KnowledgeSourceConfig =
  | WebsiteSourceConfig
  | ConfluenceSourceConfig
  | JiraSourceConfig
  | NotionSourceConfig
  | ZendeskSourceConfig
  | FilesSourceConfig;

// ---------------------------------------------------------------- actions

export interface ActionParameter {
  name: string;
  type: "string" | "number" | "integer" | "boolean";
  description: string;
  required: boolean;
  enum?: string[];
}

// ---------------------------------------------------------------- testing

export interface SimulatedActionCall {
  name: string;
  input: Record<string, unknown>;
  /** executed: read-only call really ran. simulated: write call was not executed. approval: would wait for a human. */
  mode: "executed" | "simulated" | "approval";
  output?: string;
}

export interface SimulationSpan {
  name: string;
  kind: "ai" | "tool" | "integration" | "system";
  status: "ok" | "error";
  summary: string | null;
  attributes: Record<string, unknown>;
  startedAt: string;
  durationMs: number;
}

export interface SimulationResult {
  outcome: "reply" | "escalate";
  body: string;
  confidence: number;
  sources: Source[];
  reason?: string;
  internalNote?: string;
  triage?: {
    priority?: string;
    tags?: string[];
    intent?: string;
    language?: string;
    sentiment?: string;
    summary?: string;
  };
  /** What the live policy would do with this outcome. */
  policy: { autoSend: boolean; why: string };
  actions: SimulatedActionCall[];
  spans: SimulationSpan[];
  provider: "claude" | "local";
  durationMs: number;
}

export interface TestResult {
  ranAt: string;
  passed: boolean;
  score: number;
  verdict: string;
  outcomeMatched: boolean;
  simulation: SimulationResult;
}
