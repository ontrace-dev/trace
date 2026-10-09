const num = (v: string | undefined, d: number) => (v ? Number(v) : d);
// On Railway and Render the generated domain is injected automatically, so URLs need no configuration.
/**
 * Hosts like Coolify hand over a bare domain (or a comma-separated list) — use the first, with https://.
 * Trailing slashes are dropped so `${APP_URL}/path` stays clean.
 */
const withScheme = (v: string | undefined) => {
  const first = v?.split(",")[0]?.trim().replace(/\/+$/, "");
  if (!first) return undefined;
  return /^https?:\/\//i.test(first) ? first : `https://${first}`;
};
const platformUrl =
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined) ||
  withScheme(process.env.RENDER_EXTERNAL_URL);

export const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: num(process.env.PORT, 3000),
  /** Public URL of the web app (where users sign in). In dev this is the Vite server. */
  APP_URL: withScheme(process.env.APP_URL) || platformUrl || "http://localhost:5173",
  /** Public URL of this API server (used for widget script, webhooks, Slack request URLs). */
  PUBLIC_URL:
    withScheme(process.env.PUBLIC_URL) ||
    // In production the API and the web app share one origin.
    (process.env.NODE_ENV === "production" ? withScheme(process.env.APP_URL) : undefined) ||
    platformUrl ||
    `http://localhost:${num(process.env.PORT, 3000)}`,
  DATABASE_URL: process.env.DATABASE_URL || "postgres://trace:trace@localhost:5432/trace",
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || "dev-secret-change-me-dev-secret-change-me",

  /** Outbound mail. Defaults to the Mailpit container from docker-compose. */
  SMTP_URL: process.env.SMTP_URL || "smtp://localhost:1025",
  MAIL_FROM: process.env.MAIL_FROM || "trace <no-reply@trace.local>",
  /** Built-in inbound SMTP server (receives support@… mail). Set to 0 to disable. */
  INBOUND_SMTP_PORT: num(process.env.INBOUND_SMTP_PORT, 2525),
  /** Domain used for generated forwarding addresses: <token>@INBOUND_DOMAIN */
  INBOUND_DOMAIN: process.env.INBOUND_DOMAIN || "inbound.trace.local",

  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  /** Local multilingual embedding model (transformers.js). Set EMBEDDINGS=off to use keyword search only. */
  EMBEDDINGS: process.env.EMBEDDINGS || "on",
  EMBEDDINGS_MODEL: process.env.EMBEDDINGS_MODEL || "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  AI_MODEL: process.env.AI_MODEL || "claude-opus-5-5",

  /** Allow MCP servers that run as local commands (stdio). They execute on this host — off in production unless enabled. */
  MCP_ALLOW_STDIO:
    (process.env.MCP_ALLOW_STDIO || (process.env.NODE_ENV === "production" ? "false" : "true")) === "true",

  SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET,
  SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,

  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  /** "Sign in with Microsoft" (Entra ID). Optional tenant id restricts sign-in to one tenant. */
  MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
  MICROSOFT_TENANT_ID: process.env.MICROSOFT_TENANT_ID || "common",
  /** "Sign in with GitLab"; GITLAB_ISSUER for self-hosted GitLab (https://gitlab.example.com). */
  GITLAB_CLIENT_ID: process.env.GITLAB_CLIENT_ID,
  GITLAB_CLIENT_SECRET: process.env.GITLAB_CLIENT_SECRET,
  GITLAB_ISSUER: process.env.GITLAB_ISSUER,

  /** Origins of internal identity providers (comma-separated) that workspace SSO may reach on a private network. */
  SSO_TRUSTED_ORIGINS: (process.env.SSO_TRUSTED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean),
  /** Read the client IP from X-Forwarded-For (true behind a reverse proxy; default on in production). */
  TRUST_PROXY: (process.env.TRUST_PROXY || (process.env.NODE_ENV === "production" ? "true" : "false")) === "true",
  /** Shared public demo: seed "northwind" on boot, protect the demo accounts, reset every DEMO_RESET_HOURS. */
  DEMO_MODE: process.env.DEMO_MODE === "true",
  DEMO_RESET_HOURS: Number(process.env.DEMO_RESET_HOURS || 24),

  DATA_DIR: process.env.DATA_DIR || new URL("../../../.data", import.meta.url).pathname,
};

export const isProd = env.NODE_ENV === "production";
