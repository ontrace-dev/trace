import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../env.ts";

export const BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:join",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "commands",
  "groups:history",
  "groups:read",
  "im:history",
  "reactions:write",
  "users:read",
  "users:read.email",
];

export const BOT_EVENTS = ["app_mention", "message.channels", "message.groups"];

/** Slack app manifest. Socket Mode needs no public URL; HTTP mode points request URLs at PUBLIC_URL. */
export function slackManifest(opts: { mode: "socket" | "http"; name?: string }) {
  const base = `${env.PUBLIC_URL}/api/integrations/slack`;
  const http = opts.mode === "http";
  const name = (opts.name || "trace").slice(0, 35);
  return {
    display_information: {
      name,
      description: "AI-native helpdesk: ticket notifications, thread sync and /trace.",
      background_color: "#080808",
    },
    features: {
      bot_user: { display_name: name.toLowerCase().replace(/[^a-z0-9._-]/g, "-"), always_online: true },
      slash_commands: [
        {
          command: "/trace",
          description: "Ask the AI, search or open tickets",
          usage_hint: "ask <question> | search <query> | new <subject> | stats",
          should_escape: false,
          ...(http ? { url: `${base}/commands` } : {}),
        },
      ],
    },
    oauth_config: {
      ...(http ? { redirect_urls: [`${base}/callback`] } : {}),
      scopes: { bot: BOT_SCOPES },
    },
    settings: {
      event_subscriptions: { ...(http ? { request_url: `${base}/events` } : {}), bot_events: BOT_EVENTS },
      interactivity: { is_enabled: true, ...(http ? { request_url: `${base}/interactions` } : {}) },
      org_deploy_enabled: false,
      socket_mode_enabled: !http,
      token_rotation_enabled: false,
    },
  };
}

/** Verify X-Slack-Signature (v0) against any of the candidate signing secrets. */
export function verifySlackSignature(
  secrets: (string | undefined | null)[],
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  now = Date.now(),
) {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 60 * 5) return false;
  const sig = Buffer.from(signature);
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = Buffer.from(
      `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`,
    );
    if (expected.length === sig.length && timingSafeEqual(expected, sig)) return true;
  }
  return false;
}

/** OAuth state: base64url(json).hmac — ties the Slack install to the trace workspace + user. */
export function signState(data: { orgId: string; userId: string }) {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + 15 * 60_000 })).toString("base64url");
  const mac = createHmac("sha256", env.BETTER_AUTH_SECRET).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function readState(state: string | undefined) {
  if (!state) return null;
  const [payload, mac] = state.split(".");
  if (!payload || !mac) return null;
  const expected = createHmac("sha256", env.BETTER_AUTH_SECRET).update(payload).digest("base64url");
  if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
    orgId: string;
    userId: string;
    exp: number;
  };
  return data.exp > Date.now() ? data : null;
}
