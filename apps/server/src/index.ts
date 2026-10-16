import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ZodError } from "zod";
import { auth, socialProviderIds } from "./auth.ts";
import { env, isProd } from "./env.ts";
import { appRoutes } from "./routes/app.ts";
import { inboundRoutes } from "./routes/inbound.ts";
import { publicApi } from "./routes/public-api.ts";
import { slackAppRoutes, slackPublicRoutes } from "./routes/slack.ts";
import { discordAppRoutes } from "./routes/discord.ts";
import { widgetRoutes } from "./routes/widget.ts";
import { portalPageRoutes, portalRoutes } from "./routes/portal.ts";
import { registerPortalDelivery } from "./services/portal.ts";
import { knowledgeRoutes } from "./routes/knowledge.ts";
import { mcpPublicRoutes, mcpRoutes } from "./routes/mcp.ts";
import { routingRoutes } from "./routes/routing.ts";
import { fieldsRoutes } from "./routes/fields.ts";
import { issuesRoutes } from "./routes/issues.ts";
import { startIssueSync } from "./services/issues/index.ts";
import { startRouting } from "./services/routing/worker.ts";
import { actionsRoutes } from "./routes/actions.ts";
import { testingRoutes } from "./routes/testing.ts";
import { demoBillingRoutes } from "./routes/demo-billing.ts";
import { requireUser, requireWorkspace } from "./routes/middleware.ts";
import { startAiQueue } from "./services/ai/queue.ts";
import { registerEmailDelivery } from "./services/email/outbound.ts";
import { startInboundSmtp } from "./services/email/smtp.ts";
import { startSlack } from "./services/slack/index.ts";
import { startDiscord } from "./services/discord/index.ts";
import { startWebhooks } from "./services/webhooks.ts";
import { startChatWebhooks } from "./services/notifications/chat-webhooks.ts";
import { runMigrations } from "./db/migrate.ts";
import { warmEmbeddings } from "./services/knowledge/embeddings.ts";
import { backfillIndex, enqueueIndexing } from "./services/knowledge/indexer.ts";
import { demoAuthGuard, demoInfo, publicMailbox, startDemo } from "./services/demo.ts";
import { ssoLookup } from "./services/sso.ts";

const root = new URL("../../..", import.meta.url).pathname;
const webDist = join(root, "apps/web/dist");
const widgetDist = join(root, "packages/widget/dist");
const portalDist = join(root, "packages/portal/dist");

const app = new Hono();
if (!isProd) app.use("/api/*", logger());

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  if (err instanceof ZodError) return c.json({ error: "Invalid request", issues: err.issues }, 400);
  console.error(err);
  return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true }));
app.get("/api/config", async (c) =>
  c.json({
    demo: await demoInfo(),
    providers: socialProviderIds,
    // Sign-in methods the login page offers besides email + password.
    methods: { sso: true, passkey: true, magicLink: !publicMailbox() },
    publicUrl: env.PUBLIC_URL,
  }),
);

// Login page: which identity provider handles this email's domain (only verified domains).
app.get("/api/sso/lookup", async (c) => c.json({ sso: await ssoLookup(c.req.query("email") ?? "") }));

// Auth (better-auth handles sign-in/up, sessions, organizations = workspaces, invitations).
app.on(["GET", "POST"], "/api/auth/*", async (c) => (await demoAuthGuard(c.req.raw)) ?? auth.handler(c.req.raw));

// Public, cross-origin endpoints: the embeddable widget and portal, the REST API and inbound webhooks.
for (const path of ["/api/widget/*", "/api/portal/*"]) {
  app.use(path, cors({ origin: (o) => o ?? "*", credentials: false, allowHeaders: ["content-type", "authorization"] }));
}
app.use("/api/v1/*", cors({ origin: "*", allowHeaders: ["content-type", "authorization"] }));
app.route("/api/widget", widgetRoutes);
app.route("/api/portal", portalRoutes);
app.route("/api/v1", publicApi);
app.route("/api/inbound", inboundRoutes);
app.route("/api/integrations/slack", slackPublicRoutes);

app.route("/api/demo/billing", demoBillingRoutes);
app.route("/api/mcp", mcpPublicRoutes);

// Agent app API (cookie session). Feature routers get user + workspace checks via a scoped wrapper.
function scoped(router: Hono<never>) {
  const r = new Hono();
  r.use("*", requireUser, requireWorkspace);
  r.route("/", router as never);
  return r;
}
app.route("/api/w/:wid/integrations/slack", scoped(slackAppRoutes as never));
app.route("/api/w/:wid/integrations/discord", scoped(discordAppRoutes as never));
app.route("/api/w/:wid/knowledge", scoped(knowledgeRoutes as never));
app.route("/api/w/:wid/automation", scoped(actionsRoutes as never));
app.route("/api/w/:wid/testing", scoped(testingRoutes as never));
app.route("/api/w/:wid/mcp", scoped(mcpRoutes as never));
app.route("/api/w/:wid/routing", scoped(routingRoutes as never));
app.route("/api/w/:wid/fields", scoped(fieldsRoutes as never));
app.route("/api/w/:wid/issues", scoped(issuesRoutes as never));
app.route("/api", appRoutes);

// The embeddable bundles:
//   <script src="https://trace.example.com/widget.js" data-key="wk_…" async></script>
//   <trace-portal workspace="acme"></trace-portal><script src="https://trace.example.com/portal.js" async></script>
for (const [file, dist, pkg] of [
  ["widget.js", widgetDist, "widget"],
  ["portal.js", portalDist, "portal"],
] as const) {
  app.get(`/${file}`, async (c) => {
    const path = join(dist, file);
    if (!existsSync(path)) return c.text(`// ${pkg} not built — run \`vp run ${pkg}#build\``, 404);
    return c.body(await readFile(path), 200, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": isProd ? "public, max-age=300" : "no-cache",
      "access-control-allow-origin": "*",
    });
  });
}

// The hosted customer portal (before the SPA fallback, which would otherwise catch it).
app.route("/portal", portalPageRoutes);

// Production: serve the built SPA.
if (existsSync(webDist)) {
  const rel = relative(process.cwd(), webDist);
  app.use("/*", serveStatic({ root: rel }));
  app.get("*", serveStatic({ path: join(rel, "index.html") }));
}

registerEmailDelivery();
registerPortalDelivery();
await runMigrations();

// overrideGlobalObjects: false — Hono's faster global Response breaks libraries that fetch files themselves
// (transformers.js can't download the embedding model with it).
serve({ fetch: app.fetch, port: env.PORT, overrideGlobalObjects: false }, (info) => {
  console.log(`[trace] api listening on http://localhost:${info.port}`);
  console.log(`[trace] app url ${env.APP_URL}`);
});

startAiQueue();
warmEmbeddings();
void enqueueIndexing(backfillIndex);
startWebhooks();
startChatWebhooks();
startRouting();
startIssueSync();
// After the server listens, so health checks pass while the demo seeds (first run downloads a model).
startDemo();
void import("./services/knowledge/sync.ts").then((m) => m.startKnowledgeSync());
startInboundSmtp();
startSlack().catch((err) => console.error("[slack] failed to start", err));
startDiscord().catch((err) => console.error("[discord] failed to start", err));

export type App = typeof app;
