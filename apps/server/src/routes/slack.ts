import { WebClient } from "@slack/web-api";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { auth } from "../auth.ts";
import { db } from "../db/index.ts";
import { integrations } from "../db/schema.ts";
import { env } from "../env.ts";
import { bus } from "../lib/bus.ts";
import { forbidden, notFound } from "../lib/http.ts";
import { id } from "../lib/ids.ts";
import type { SlackChannelRef, SlackConfig } from "../lib/types.ts";
import {
  getSlackIntegration,
  integrationsForTeam,
  listSlackIntegrations,
  postMessage,
  type SlackIntegration,
  slackError,
  slackOf,
} from "../services/slack/client.ts";
import { BOT_SCOPES, readState, signState, slackManifest, verifySlackSignature } from "../services/slack/manifest.ts";
import {
  dispatchCommand,
  dispatchEventCallback,
  dispatchInteraction,
  socketState,
  stopIntegrationSocket,
  syncSockets,
} from "../services/slack/runtime.ts";
import { getMembership, getOrg, getSettings } from "../services/workspace.ts";
import type { AppEnv } from "./middleware.ts";
import { mask } from "./serializers.ts";

const isAdminRole = (role: string) => role.split(",").some((r) => r === "owner" || r === "admin");

/* =================================================================== public endpoints */

/** Public Slack endpoints (Events API, interactivity, slash commands, OAuth). Mounted at /api/integrations/slack */
export const slackPublicRoutes = new Hono();

async function verifiedIntegrations(
  c: { req: { header: (n: string) => string | undefined } },
  raw: string,
  teamId?: string,
) {
  const candidates = teamId ? await integrationsForTeam(teamId) : await listSlackIntegrations();
  const ok = verifySlackSignature(
    [env.SLACK_SIGNING_SECRET, ...candidates.map((i) => i.config.signingSecret)],
    c.req.header("x-slack-request-timestamp"),
    c.req.header("x-slack-signature"),
    raw,
  );
  return ok ? candidates : null;
}

slackPublicRoutes.post("/events", async (c) => {
  const raw = await c.req.text();
  const body = JSON.parse(raw || "{}") as {
    type?: string;
    challenge?: string;
    team_id?: string;
    event?: unknown;
    event_id?: string;
  };
  const matched = await verifiedIntegrations(c, raw, body.type === "url_verification" ? undefined : body.team_id);
  if (!matched) return c.json({ error: "invalid signature" }, 401);
  if (body.type === "url_verification") return c.json({ challenge: body.challenge });
  // Slack retries if we're slow; we already took the first delivery.
  if (c.req.header("x-slack-retry-num")) return c.body(null, 200);
  if (body.type === "event_callback") {
    // Ack within 3s, process afterwards. Socket Mode integrations get events over their socket instead.
    const httpTargets = matched.filter((i) => !i.config.appToken);
    setImmediate(async () => {
      for (const [n, i] of httpTargets.entries()) await dispatchEventCallback(i.id, body, n === 0);
    });
  }
  return c.body(null, 200);
});

slackPublicRoutes.post("/interactions", async (c) => {
  const raw = await c.req.text();
  const form = new URLSearchParams(raw);
  const payload = JSON.parse(form.get("payload") ?? "{}") as { team?: { id: string } };
  const matched = await verifiedIntegrations(c, raw, payload.team?.id);
  if (!matched?.length) return c.json({ error: "invalid signature" }, 401);
  const res = await dispatchInteraction(matched[0]!.id, payload);
  if (res.after) setImmediate(() => res.after!().catch((err) => console.error("[slack]", err)));
  return res.response ? c.json(res.response) : c.body(null, 200);
});

slackPublicRoutes.post("/commands", async (c) => {
  const raw = await c.req.text();
  const form = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
  const matched = await verifiedIntegrations(c, raw, form.team_id);
  if (!matched?.length) return c.json({ error: "invalid signature" }, 401);
  const res = await dispatchCommand(matched[0]!.id, form);
  if (res.after) setImmediate(() => res.after!().catch((err) => console.error("[slack]", err)));
  return res.response ? c.json(res.response) : c.body(null, 200);
});

/** "Add to Slack": /api/integrations/slack/install?workspaceId=<org id> */
slackPublicRoutes.get("/install", async (c) => {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET)
    return c.text("Slack OAuth is not configured (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET).", 400);
  const orgId = c.req.query("workspaceId") ?? "";
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.redirect(`${env.APP_URL}/login`);
  const m = await getMembership(orgId, session.user.id);
  if (!m || !isAdminRole(m.role)) throw forbidden("Only workspace admins can connect Slack");
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", env.SLACK_CLIENT_ID);
  url.searchParams.set("scope", BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", `${env.PUBLIC_URL}/api/integrations/slack/callback`);
  url.searchParams.set("state", signState({ orgId, userId: session.user.id }));
  return c.redirect(url.toString());
});

slackPublicRoutes.get("/callback", async (c) => {
  const state = readState(c.req.query("state"));
  const fallback = `${env.APP_URL}/`;
  if (!state) return c.redirect(`${fallback}?slack_error=invalid_state`);
  const org = await getOrg(state.orgId);
  const back = `${env.APP_URL}/w/${org?.slug ?? ""}/settings/slack`;
  if (c.req.query("error")) return c.redirect(`${back}?slack_error=${encodeURIComponent(c.req.query("error")!)}`);
  try {
    const res = await new WebClient().oauth.v2.access({
      client_id: env.SLACK_CLIENT_ID!,
      client_secret: env.SLACK_CLIENT_SECRET!,
      code: c.req.query("code") ?? "",
      redirect_uri: `${env.PUBLIC_URL}/api/integrations/slack/callback`,
    });
    if (!res.access_token || !res.team?.id) throw new Error("Slack did not return a bot token");
    await upsertIntegration(state.orgId, {
      name: res.team.name ?? "Slack",
      botToken: res.access_token,
      teamId: res.team.id,
      teamName: res.team.name ?? undefined,
      botUserId: res.bot_user_id ?? undefined,
    });
    return c.redirect(`${back}?slack=connected`);
  } catch (err) {
    return c.redirect(`${back}?slack_error=${encodeURIComponent(slackError(err))}`);
  }
});

/* =================================================================== workspace-scoped endpoints */

async function upsertIntegration(
  orgId: string,
  v: {
    name: string;
    botToken: string;
    appToken?: string;
    signingSecret?: string;
    teamId: string;
    teamName?: string;
    botUserId?: string;
  },
) {
  const existing = (await listSlackIntegrations(orgId)).find((i) => i.externalId === v.teamId);
  const config: SlackConfig = {
    kind: "slack",
    intakeChannels: [],
    notifyOn: ["ticket.created", "ticket.escalated"],
    threadSync: true,
    ...existing?.config,
    botToken: v.botToken,
    appToken: v.appToken ?? existing?.config.appToken,
    signingSecret: v.signingSecret ?? existing?.config.signingSecret,
    teamId: v.teamId,
    teamName: v.teamName,
    botUserId: v.botUserId,
  };
  const status = config.appToken ? "pending" : "connected";
  const statusMessage = config.appToken
    ? "Connecting over Socket Mode…"
    : config.signingSecret || env.SLACK_SIGNING_SECRET
      ? null
      : "No app-level token: add one for Socket Mode, or set request URLs and a signing secret for HTTP events.";
  let row;
  if (existing) {
    [row] = await db
      .update(integrations)
      .set({ config, externalId: v.teamId, status, statusMessage, enabled: true })
      .where(eq(integrations.id, existing.id))
      .returning();
  } else {
    [row] = await db
      .insert(integrations)
      .values({
        id: id("int"),
        orgId,
        provider: "slack",
        name: v.name,
        config,
        externalId: v.teamId,
        status,
        statusMessage,
      })
      .returning();
  }
  await syncSockets(orgId);
  bus.publish({ type: "integration.updated", orgId, integrationId: row!.id });
  return row! as SlackIntegration;
}

function serialize(i: SlackIntegration) {
  return {
    id: i.id,
    name: i.name,
    enabled: i.enabled,
    status: i.status,
    statusMessage: i.statusMessage,
    createdAt: i.createdAt,
    mode: i.config.appToken ? "socket" : "http",
    socket: socketState(i.id),
    config: {
      ...i.config,
      botToken: mask(i.config.botToken),
      appToken: i.config.appToken ? mask(i.config.appToken) : undefined,
      signingSecret: i.config.signingSecret ? mask(i.config.signingSecret) : undefined,
    },
  };
}

/** Workspace-scoped Slack settings endpoints. Mounted at /api/w/:wid/integrations/slack (auth + workspace checked). */
export const slackAppRoutes = new Hono<AppEnv>();

const requireAdmin = (role: string) => {
  if (!isAdminRole(role)) throw forbidden("Admins only");
};

async function ownIntegration(orgId: string, integrationId: string) {
  const i = await getSlackIntegration(integrationId, orgId);
  if (!i) throw notFound("Slack connection not found");
  return i;
}

slackAppRoutes.get("/", async (c) => {
  const rows = await listSlackIntegrations(c.get("orgId"));
  return c.json({
    integrations: rows.map(serialize),
    oauthAvailable: !!(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET),
    httpSigningConfigured: !!env.SLACK_SIGNING_SECRET,
    requestUrls: {
      events: `${env.PUBLIC_URL}/api/integrations/slack/events`,
      interactions: `${env.PUBLIC_URL}/api/integrations/slack/interactions`,
      commands: `${env.PUBLIC_URL}/api/integrations/slack/commands`,
      oauthCallback: `${env.PUBLIC_URL}/api/integrations/slack/callback`,
    },
  });
});

slackAppRoutes.get("/manifest", async (c) => {
  const mode = c.req.query("mode") === "http" ? "http" : "socket";
  const settings = await getSettings(c.get("orgId"));
  return c.json(slackManifest({ mode, name: settings.ai.agentName || "trace" }));
});

slackAppRoutes.post("/connect", async (c) => {
  requireAdmin(c.get("role"));
  const b = z
    .object({
      name: z.string().optional(),
      botToken: z.string().trim().startsWith("xoxb-", "Bot token must start with xoxb-"),
      appToken: z
        .string()
        .trim()
        .startsWith("xapp-", "App-level token must start with xapp-")
        .optional()
        .or(z.literal("")),
      signingSecret: z.string().trim().optional(),
    })
    .parse(await c.req.json());
  let teamId: string;
  let teamName: string | undefined;
  let botUserId: string | undefined;
  try {
    const t = await new WebClient(b.botToken).auth.test();
    teamId = t.team_id!;
    teamName = t.team ?? undefined;
    botUserId = t.user_id ?? undefined;
  } catch (err) {
    return c.json({ error: `Bot token rejected by Slack: ${slackError(err)}` }, 400);
  }
  if (b.appToken) {
    try {
      await new WebClient(b.appToken).apps.connections.open();
    } catch (err) {
      return c.json(
        { error: `App-level token rejected by Slack: ${slackError(err)} — it needs the connections:write scope.` },
        400,
      );
    }
  }
  const row = await upsertIntegration(c.get("orgId"), {
    name: b.name || teamName || "Slack",
    botToken: b.botToken,
    appToken: b.appToken || undefined,
    signingSecret: b.signingSecret || undefined,
    teamId,
    teamName,
    botUserId,
  });
  return c.json({ integration: serialize(row) });
});

const channelRef = z.object({ id: z.string(), name: z.string() });

slackAppRoutes.patch("/:id", async (c) => {
  requireAdmin(c.get("role"));
  const orgId = c.get("orgId");
  const cur = await ownIntegration(orgId, c.req.param("id"));
  const b = z
    .object({
      name: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
      notifyChannel: channelRef.nullable().optional(),
      intakeChannels: z.array(channelRef).optional(),
      notifyOn: z.array(z.enum(["ticket.created", "ticket.escalated", "draft.ready", "message.customer"])).optional(),
      threadSync: z.boolean().optional(),
      waitForAi: z.boolean().optional(),
      appToken: z.string().optional(),
      signingSecret: z.string().optional(),
    })
    .parse(await c.req.json());
  const config: SlackConfig = { ...cur.config };
  if (b.notifyChannel !== undefined) config.notifyChannel = b.notifyChannel ?? undefined;
  if (b.intakeChannels) config.intakeChannels = b.intakeChannels;
  if (b.notifyOn) config.notifyOn = b.notifyOn;
  if (b.threadSync !== undefined) config.threadSync = b.threadSync;
  if (b.waitForAi !== undefined) config.waitForAi = b.waitForAi;
  if (b.appToken !== undefined && !b.appToken.includes("••••")) config.appToken = b.appToken.trim() || undefined;
  if (b.signingSecret !== undefined && !b.signingSecret.includes("••••"))
    config.signingSecret = b.signingSecret.trim() || undefined;

  // The bot must be in an intake channel to receive its messages; join public ones automatically.
  const warnings: string[] = [];
  if (b.intakeChannels) {
    const before = new Set(cur.config.intakeChannels.map((x) => x.id));
    for (const ch of b.intakeChannels.filter((x) => !before.has(x.id))) {
      await slackOf(cur)
        .conversations.join({ channel: ch.id })
        .catch((err) => warnings.push(`Couldn't join #${ch.name} (${slackError(err)}) — invite the bot with /invite.`));
    }
  }
  const [row] = await db
    .update(integrations)
    .set({ name: b.name, enabled: b.enabled, config })
    .where(eq(integrations.id, cur.id))
    .returning();
  await syncSockets(orgId);
  bus.publish({ type: "integration.updated", orgId, integrationId: cur.id });
  return c.json({ integration: serialize(row as SlackIntegration), warnings });
});

slackAppRoutes.get("/:id/channels", async (c) => {
  const i = await ownIntegration(c.get("orgId"), c.req.param("id"));
  const out: (SlackChannelRef & { isPrivate: boolean; isMember: boolean })[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 10; page++) {
      const res = await slackOf(i).conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 1000,
        cursor,
      });
      for (const ch of res.channels ?? []) {
        if (ch.id && ch.name)
          out.push({ id: ch.id, name: ch.name, isPrivate: !!ch.is_private, isMember: !!ch.is_member });
      }
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  } catch (err) {
    return c.json({ error: slackError(err) }, 502);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return c.json({ channels: out });
});

slackAppRoutes.post("/:id/test", async (c) => {
  requireAdmin(c.get("role"));
  const orgId = c.get("orgId");
  const i = await ownIntegration(orgId, c.req.param("id"));
  const channel = i.config.notifyChannel;
  if (!channel) return c.json({ error: "Pick a notification channel first" }, 400);
  const org = await getOrg(orgId);
  try {
    await postMessage(i, {
      channel: channel.id,
      text: `:white_check_mark: *trace is connected* — new tickets for *${org?.name ?? "this workspace"}* will show up here. Reply in a ticket's thread to leave an internal note.`,
    });
    await db.update(integrations).set({ status: "connected", statusMessage: null }).where(eq(integrations.id, i.id));
    bus.publish({ type: "integration.updated", orgId, integrationId: i.id });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: slackError(err) }, 502);
  }
});

slackAppRoutes.delete("/:id", async (c) => {
  requireAdmin(c.get("role"));
  const orgId = c.get("orgId");
  const i = await ownIntegration(orgId, c.req.param("id"));
  await stopIntegrationSocket(i.id);
  await db.delete(integrations).where(and(eq(integrations.id, i.id), eq(integrations.orgId, orgId)));
  bus.publish({ type: "integration.updated", orgId, integrationId: i.id });
  return c.json({ ok: true });
});
