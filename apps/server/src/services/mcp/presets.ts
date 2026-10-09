/** Hosted MCP servers that are useful for support triage. Any other server works via "Custom". */
export interface McpPreset {
  id: string;
  name: string;
  description: string;
  url: string;
  transport: "http" | "sse";
  authType: "none" | "headers" | "oauth";
  /** For token auth: the header the token goes into, and its prefix. */
  tokenHeader?: { name: string; prefix: string; hint: string };
}

export const mcpPresets: McpPreset[] = [
  {
    id: "linear",
    name: "Linear",
    description: "Find known bugs and their status, link tickets to issues, file new issues.",
    url: "https://mcp.linear.app/mcp",
    transport: "http",
    authType: "oauth",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Look up errors and stack traces a customer is hitting, and whether a fix shipped.",
    url: "https://mcp.sentry.dev/mcp",
    transport: "http",
    authType: "oauth",
  },
  {
    id: "atlassian",
    name: "Jira & Confluence",
    description: "Search Jira issues and Confluence pages live, comment on and create issues.",
    url: "https://mcp.atlassian.com/v1/mcp",
    transport: "http",
    authType: "oauth",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search internal docs, runbooks and databases.",
    url: "https://mcp.notion.com/mcp",
    transport: "http",
    authType: "oauth",
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Check customers, subscriptions, invoices and payments.",
    url: "https://mcp.stripe.com",
    transport: "http",
    authType: "headers",
    tokenHeader: {
      name: "Authorization",
      prefix: "Bearer ",
      hint: "Restricted API key (rk_live_…), read-only is enough to start",
    },
  },
  {
    id: "github",
    name: "GitHub",
    description: "Search issues, pull requests and code; see what changed in the last release.",
    url: "https://api.githubcopilot.com/mcp/",
    transport: "http",
    authType: "headers",
    tokenHeader: {
      name: "Authorization",
      prefix: "Bearer ",
      hint: "Fine-grained personal access token (github_pat_…)",
    },
  },
  {
    id: "posthog",
    name: "PostHog",
    description: "Check feature flags, recent events and errors for a user.",
    url: "https://mcp.posthog.com/mcp",
    transport: "http",
    authType: "headers",
    tokenHeader: { name: "Authorization", prefix: "Bearer ", hint: "Personal API key (phx_…)" },
  },
];
