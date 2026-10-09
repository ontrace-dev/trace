import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema.ts";
import type {
  ActionParameter,
  AiSettings,
  ChannelConfig,
  KnowledgeSourceConfig,
  Source,
  TestResult,
  FieldOption,
  FieldSource,
  FieldType,
  IntegrationConfig,
  RoutingConditions,
  RoutingSettings,
  SlaSettings,
  TicketFieldValue,
  TicketRouting,
  TicketEmailMeta,
  TicketDiscordMeta,
  TicketSlackMeta,
  ViewFilters,
  WidgetSettings,
} from "../lib/types.ts";

export * from "./auth-schema.ts";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const orgId = () =>
  text("org_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });

/** Per-workspace configuration (a workspace is a better-auth organization). */
export const workspaceSettings = pgTable("workspace_settings", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  ticketSeq: integer("ticket_seq").notNull().default(0),
  ticketPrefix: text("ticket_prefix").notNull().default("TR"),
  accentColor: text("accent_color").notNull().default("#b9a3ff"),
  timezone: text("timezone").notNull().default("UTC"),
  widgetKey: text("widget_key").notNull().unique(),
  ai: jsonb("ai").$type<AiSettings>().notNull(),
  widget: jsonb("widget").$type<WidgetSettings>().notNull(),
  sla: jsonb("sla").$type<SlaSettings>().notNull(),
  /** Workspace SSO: role for people who join through the IdP, and domains where SSO is required. */
  sso: jsonb("sso").$type<{ defaultRole: "member" | "admin"; enforcedDomains: string[] }>(),
  /** Auto-assignment settings; null until configured (defaults apply). */
  routing: jsonb("routing").$type<RoutingSettings>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const customers = pgTable(
  "customers",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    email: text("email"),
    name: text("name"),
    company: text("company"),
    avatarUrl: text("avatar_url"),
    externalId: text("external_id"),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    slackUserId: text("slack_user_id"),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("customers_org_email_idx").on(t.orgId, t.email),
    index("customers_org_ext_idx").on(t.orgId, t.externalId),
  ],
);

export const channels = pgTable(
  "channels",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    type: text("type").$type<"email" | "widget" | "api" | "slack" | "discord">().notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** For email channels: the public support address, e.g. support@acme.com */
    address: text("address"),
    /** Secret token used in inbound webhook URLs and forwarding addresses. */
    inboundToken: text("inbound_token").notNull().unique(),
    config: jsonb("config").$type<ChannelConfig>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("channels_org_idx").on(t.orgId), index("channels_address_idx").on(t.address)],
);

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

export const tickets = pgTable(
  "tickets",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    number: integer("number").notNull(),
    subject: text("subject").notNull(),
    status: text("status").$type<TicketStatus>().notNull().default("open"),
    priority: text("priority").$type<TicketPriority>().notNull().default("normal"),
    channel: text("channel").$type<TicketChannel>().notNull(),
    channelId: text("channel_id").references(() => channels.id, { onDelete: "set null" }),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    assigneeId: text("assignee_id").references(() => user.id, { onDelete: "set null" }),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    aiState: text("ai_state").$type<AiState>().notNull().default("none"),
    aiSummary: text("ai_summary"),
    aiIntent: text("ai_intent"),
    aiLanguage: text("ai_language"),
    aiSentiment: text("ai_sentiment"),
    aiConfidence: real("ai_confidence"),
    firstResponseDueAt: timestamp("first_response_due_at", { withTimezone: true }),
    firstRespondedAt: timestamp("first_responded_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    lastCustomerMessageAt: timestamp("last_customer_message_at", { withTimezone: true }),
    email: jsonb("email").$type<TicketEmailMeta>(),
    slack: jsonb("slack").$type<TicketSlackMeta>(),
    discord: jsonb("discord").$type<TicketDiscordMeta>(),
    widgetVisitorId: text("widget_visitor_id"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    /** Set when trace routed the ticket: which rule, group and why this person. */
    routing: jsonb("routing").$type<TicketRouting>(),
    /** Custom field values by field key (classification lives under "type"). */
    fields: jsonb("fields").$type<Record<string, TicketFieldValue>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tickets_org_number_idx").on(t.orgId, t.number),
    index("tickets_org_status_idx").on(t.orgId, t.status, t.lastMessageAt),
    index("tickets_customer_idx").on(t.customerId),
  ],
);

export type MessageKind = "message" | "note" | "event";
export type AuthorType = "customer" | "agent" | "ai" | "system";

export interface Attachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
}

export interface MessageMeta {
  sources?: Source[];
  /** Set on notes that record an action run (requested, approved, executed, rejected). */
  action?: { runId: string; name: string; status: ActionRunStatus };
  event?: { type: string; from?: unknown; to?: unknown };
  slack?: { channel: string; ts: string; user?: string };
  delivery?: { status: "sent" | "failed"; error?: string };
  draftId?: string;
  via?: "slack" | "discord" | "email" | "widget" | "api" | "web" | "ai";
  /** Set on messages that came from (or were mirrored to) Discord — used to avoid echo loops. */
  discord?: { channelId: string; messageId: string; user?: string };
}

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    kind: text("kind").$type<MessageKind>().notNull().default("message"),
    authorType: text("author_type").$type<AuthorType>().notNull(),
    authorId: text("author_id"),
    authorName: text("author_name"),
    body: text("body").notNull().default(""),
    html: text("html"),
    attachments: jsonb("attachments").$type<Attachment[]>().notNull().default([]),
    /** Email Message-ID, Slack ts, etc. */
    externalId: text("external_id"),
    meta: jsonb("meta").$type<MessageMeta>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_ticket_idx").on(t.ticketId, t.createdAt),
    index("messages_external_idx").on(t.orgId, t.externalId),
  ],
);

export const drafts = pgTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    confidence: real("confidence").notNull().default(0),
    sources: jsonb("sources").$type<NonNullable<MessageMeta["sources"]>>().notNull().default([]),
    reasoning: text("reasoning"),
    traceId: text("trace_id"),
    status: text("status").$type<"pending" | "sent" | "discarded" | "superseded">().notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [index("drafts_ticket_idx").on(t.ticketId, t.createdAt)],
);

/** Every AI / integration step is recorded as a span so any decision can be audited. */
export const spans = pgTable(
  "spans",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    ticketId: text("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    traceId: text("trace_id").notNull(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    kind: text("kind").$type<"ai" | "tool" | "integration" | "system">().notNull().default("system"),
    status: text("status").$type<"ok" | "error">().notNull().default("ok"),
    summary: text("summary"),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
  },
  (t) => [index("spans_trace_idx").on(t.traceId, t.startedAt), index("spans_ticket_idx").on(t.ticketId)],
);

export const articles = pgTable(
  "articles",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    status: text("status").$type<"draft" | "published">().notNull().default("draft"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    source: text("source").$type<"manual" | "ai">().notNull().default("manual"),
    sourceTicketId: text("source_ticket_id"),
    authorId: text("author_id"),
    views: integer("views").notNull().default(0),
    citations: integer("citations").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("articles_org_idx").on(t.orgId),
    index("articles_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${t.title}, '') || ' ' || coalesce(${t.body}, ''))`,
    ),
  ],
);

export const views = pgTable(
  "views",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    name: text("name").notNull(),
    icon: text("icon").notNull().default("layers"),
    filters: jsonb("filters").$type<ViewFilters>().notNull().default({}),
    position: integer("position").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("views_org_idx").on(t.orgId)],
);

export const integrations = pgTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    provider: text("provider").$type<"slack" | "discord" | "webhook" | "chat_webhook" | "linear" | "jira">().notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    config: jsonb("config").$type<IntegrationConfig>().notNull(),
    /** Slack team id for event routing. */
    externalId: text("external_id"),
    status: text("status").$type<"connected" | "error" | "pending">().notNull().default("pending"),
    statusMessage: text("status_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("integrations_org_idx").on(t.orgId), index("integrations_ext_idx").on(t.externalId)],
);

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  orgId: orgId(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  hash: text("hash").notNull().unique(),
  createdBy: text("created_by"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- knowledge: sources, documents, chunks

export type KnowledgeVisibility = "public" | "internal";

/** An external system trace syncs knowledge from (website, Confluence, Jira, Notion, Zendesk, files). */
export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    type: text("type").$type<KnowledgeSourceConfig["type"]>().notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** public: may be quoted and cited to customers. internal: context for the agent and your team only. */
    visibility: text("visibility").$type<KnowledgeVisibility>().notNull().default("public"),
    config: jsonb("config").$type<KnowledgeSourceConfig>().notNull(),
    /** Encrypted credential (API token), see lib/crypto.ts. */
    secret: text("secret"),
    status: text("status").$type<"idle" | "syncing" | "ready" | "error">().notNull().default("idle"),
    statusMessage: text("status_message"),
    documentCount: integer("document_count").notNull().default(0),
    syncIntervalMinutes: integer("sync_interval_minutes").notNull().default(360),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("knowledge_sources_org_idx").on(t.orgId)],
);

/** One retrievable document: a help article, a Confluence page, a Jira issue, a web page, a file … */
export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    sourceId: text("source_id").references(() => knowledgeSources.id, { onDelete: "cascade" }),
    articleId: text("article_id").references(() => articles.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    title: text("title").notNull(),
    url: text("url"),
    content: text("content").notNull(),
    visibility: text("visibility").$type<KnowledgeVisibility>().notNull().default("public"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    contentHash: text("content_hash").notNull(),
    externalUpdatedAt: timestamp("external_updated_at", { withTimezone: true }),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("knowledge_documents_org_idx").on(t.orgId),
    uniqueIndex("knowledge_documents_source_ext_idx").on(t.sourceId, t.externalId),
    uniqueIndex("knowledge_documents_article_idx").on(t.articleId),
  ],
);

export const EMBEDDING_DIMENSIONS = 384;

/** Retrieval unit: a ~800 character passage with a local multilingual embedding. */
export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    documentId: text("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: createdAt(),
  },
  (t) => [
    index("knowledge_chunks_org_idx").on(t.orgId),
    index("knowledge_chunks_doc_idx").on(t.documentId),
    index("knowledge_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("knowledge_chunks_fts_idx").using("gin", sql`to_tsvector('simple', ${t.content})`),
  ],
);

// ---------------------------------------------------------------- actions & procedures

/** An HTTP call the agent may make, e.g. "look up charges in Stripe" or "create a Jira issue". */
export const actions = pgTable(
  "actions",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    /** Tool name the model sees: lowercase snake_case, unique per workspace. */
    name: text("name").notNull(),
    title: text("title").notNull(),
    /** When and why to use it — written for the model. */
    description: text("description").notNull(),
    method: text("method").$type<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">().notNull().default("GET"),
    /** URL template: {{param}}, {{secrets.NAME}}, {{customer.email}}, {{ticket.number}} … */
    url: text("url").notNull(),
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    /** JSON body template (string values may be "{{param}}"). */
    body: text("body"),
    bodyFormat: text("body_format").$type<"json" | "form" | "none">().notNull().default("json"),
    parameters: jsonb("parameters").$type<ActionParameter[]>().notNull().default([]),
    /** Consequential actions wait for a human to approve each run. */
    requiresApproval: boolean("requires_approval").notNull().default(true),
    /** Read-only actions are executed during simulations and tests; others are only simulated. */
    readOnly: boolean("read_only").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    timeoutMs: integer("timeout_ms").notNull().default(10_000),
    preset: text("preset"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("actions_org_name_idx").on(t.orgId, t.name)],
);

/** Natural-language playbooks ("Duplicate charge: 1. look up charges … 2. refund if …"). */
export const procedures = pgTable(
  "procedures",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    name: text("name").notNull(),
    /** When the procedure applies, e.g. "Customer reports being charged twice". */
    trigger: text("trigger").notNull(),
    instructions: text("instructions").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("procedures_org_idx").on(t.orgId)],
);

export type ActionRunStatus = "pending_approval" | "running" | "succeeded" | "failed" | "rejected";

export const actionRuns = pgTable(
  "action_runs",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    ticketId: text("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    actionId: text("action_id").references(() => actions.id, { onDelete: "set null" }),
    actionName: text("action_name").notNull(),
    actionTitle: text("action_title").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    /** Why the agent wants to run it (shown to the approver). */
    reason: text("reason"),
    status: text("status").$type<ActionRunStatus>().notNull(),
    httpStatus: integer("http_status"),
    output: text("output"),
    error: text("error"),
    requestedBy: text("requested_by").$type<"ai" | "agent">().notNull().default("ai"),
    /** Set when the run is an MCP tool call rather than an HTTP action. */
    mcpToolId: text("mcp_tool_id").references(() => mcpTools.id, { onDelete: "set null" }),
    reviewedBy: text("reviewed_by"),
    reviewedByName: text("reviewed_by_name"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    traceId: text("trace_id"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("action_runs_ticket_idx").on(t.ticketId, t.createdAt),
    index("action_runs_org_idx").on(t.orgId, t.status),
  ],
);

/** Encrypted credentials referenced from action templates as {{secrets.NAME}}. */
export const workspaceSecrets = pgTable(
  "workspace_secrets",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    name: text("name").notNull(),
    value: text("value").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("workspace_secrets_org_name_idx").on(t.orgId, t.name)],
);

// ---------------------------------------------------------------- testing

/** A scripted customer message with an expectation, used to test the agent before going live. */
export const testCases = pgTable(
  "test_cases",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    name: text("name").notNull(),
    subject: text("subject").notNull().default(""),
    message: text("message").notNull(),
    channel: text("channel").$type<TicketChannel>().notNull().default("email"),
    customerEmail: text("customer_email"),
    /** What a good answer must do, in plain language — graded by an LLM judge. */
    expectation: text("expectation").notNull().default(""),
    expectedOutcome: text("expected_outcome").$type<"reply" | "escalate" | "any">().notNull().default("any"),
    sourceTicketId: text("source_ticket_id"),
    lastResult: jsonb("last_result").$type<TestResult>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("test_cases_org_idx").on(t.orgId)],
);

export const testRuns = pgTable(
  "test_runs",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    status: text("status").$type<"running" | "done" | "failed">().notNull().default("running"),
    total: integer("total").notNull().default(0),
    completed: integer("completed").notNull().default(0),
    passed: integer("passed").notNull().default(0),
    startedBy: text("started_by"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("test_runs_org_idx").on(t.orgId, t.createdAt)],
);

// ---------------------------------------------------------------- MCP servers (tools from the ecosystem)

/** A Model Context Protocol server whose tools the agent may use (Linear, Sentry, Stripe, internal tools, …). */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    name: text("name").notNull(),
    /** Short prefix for tool names the model sees, e.g. "linear" → linear__search_issues. */
    slug: text("slug").notNull(),
    transport: text("transport").$type<"http" | "sse" | "stdio">().notNull().default("http"),
    url: text("url"),
    command: text("command"),
    args: jsonb("args").$type<string[]>().notNull().default([]),
    authType: text("auth_type").$type<"none" | "headers" | "oauth">().notNull().default("none"),
    /** Encrypted JSON: { headers?: Record<string,string>, env?: Record<string,string> }. */
    secrets: text("secrets"),
    /** Encrypted JSON OAuth state (tokens, client registration, PKCE verifier, discovery). */
    oauth: text("oauth"),
    enabled: boolean("enabled").notNull().default(true),
    status: text("status").$type<"pending" | "connected" | "needs_auth" | "error">().notNull().default("pending"),
    statusMessage: text("status_message"),
    /** Usage instructions the server sends on initialize — given to the agent. */
    instructions: text("instructions"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("mcp_servers_org_idx").on(t.orgId), uniqueIndex("mcp_servers_org_slug_idx").on(t.orgId, t.slug)],
);

export const mcpTools = pgTable(
  "mcp_tools",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    /** Name on the MCP server. */
    name: text("name").notNull(),
    /** Name exposed to the model: <server slug>__<name>. */
    toolName: text("tool_name").notNull(),
    title: text("title"),
    description: text("description").notNull().default(""),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull().default({}),
    annotations: jsonb("annotations").$type<Record<string, unknown>>().notNull().default({}),
    /** Off until an admin opts the tool in — servers can expose dozens of tools. */
    enabled: boolean("enabled").notNull().default(false),
    readOnly: boolean("read_only").notNull().default(false),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("mcp_tools_server_name_idx").on(t.serverId, t.name),
    uniqueIndex("mcp_tools_org_tool_name_idx").on(t.orgId, t.toolName),
  ],
);

// ---------------------------------------------------------------- routing (auto-assignment)

export const routingGroups = pgTable(
  "routing_groups",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("routing_groups_org_idx").on(t.orgId)],
);

export const routingGroupMembers = pgTable(
  "routing_group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => routingGroups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    orgId: orgId(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index("routing_group_members_org_idx").on(t.orgId)],
);

export const routingRules = pgTable(
  "routing_rules",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    position: integer("position").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    /** any = one matching condition is enough; all = every set condition must match. */
    match: text("match").$type<"any" | "all">().notNull().default("any"),
    conditions: jsonb("conditions").$type<RoutingConditions>().notNull().default({}),
    groupId: text("group_id")
      .notNull()
      .references(() => routingGroups.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("routing_rules_org_idx").on(t.orgId, t.position)],
);

/** Per-person routing state: availability and when they were last given a ticket. */
export const agentStatus = pgTable(
  "agent_status",
  {
    orgId: orgId(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").$type<"available" | "away">().notNull().default("available"),
    lastAssignedAt: timestamp("last_assigned_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

// ---------------------------------------------------------------- ticket fields & linked issues

export const ticketFields = pgTable(
  "ticket_fields",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    /** Stable key used in tickets.fields, the API, views and issue templates (snake_case). */
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: text("type").$type<FieldType>().notNull(),
    options: jsonb("options").$type<FieldOption[]>().notNull().default([]),
    source: text("source").$type<FieldSource>().notNull().default("manual"),
    /** For source=customer: the customer attribute to read (e.g. org_id). */
    customerAttribute: text("customer_attribute"),
    /** For source=ai (or as fallback for customer fields): how trace should find the value. */
    aiInstruction: text("ai_instruction").notNull().default(""),
    shown: text("shown").$type<"header" | "panel" | "hidden">().notNull().default("panel"),
    requiredToResolve: boolean("required_to_resolve").notNull().default(false),
    position: integer("position").notNull().default(0),
    /** Built-in fields (the "type" classification) can be edited but not deleted. */
    system: boolean("system").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("ticket_fields_org_key_idx").on(t.orgId, t.key)],
);

export type IssueStatusCategory = "todo" | "started" | "done" | "canceled";

/** A Linear or Jira issue linked to a ticket (filed from trace or linked by key). */
export const ticketLinks = pgTable(
  "ticket_links",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"linear" | "jira">().notNull(),
    integrationId: text("integration_id").references(() => integrations.id, { onDelete: "set null" }),
    externalId: text("external_id").notNull(),
    /** ENG-482 / SUP-219 */
    key: text("key").notNull(),
    url: text("url").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default(""),
    statusCategory: text("status_category").$type<IssueStatusCategory>().notNull().default("todo"),
    createdByTrace: boolean("created_by_trace").notNull().default(false),
    createdBy: text("created_by"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("ticket_links_ticket_idx").on(t.ticketId),
    index("ticket_links_org_key_idx").on(t.orgId, t.provider, t.key),
    uniqueIndex("ticket_links_ticket_key_idx").on(t.ticketId, t.provider, t.key),
  ],
);
