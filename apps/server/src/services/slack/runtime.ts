import { LogLevel, SocketModeClient } from "@slack/socket-mode";
import { bus } from "../../lib/bus.ts";
import { getSlackIntegration, listSlackIntegrations, type SlackIntegration, setStatus, slackError } from "./client.ts";
import { firstTime, handleCommand, handleEvent, handleInteraction } from "./handlers.ts";

/**
 * Shared dispatch for both transports (Socket Mode and HTTP Events API). Handlers always re-load the
 * integration so config changes (intake channels, notify channel) apply without reconnecting.
 */
export async function dispatchEventCallback(
  integrationId: string,
  body: { event?: unknown; event_id?: string },
  primary = true,
) {
  const i = await getSlackIntegration(integrationId);
  if (!i || !i.enabled || !body.event) return;
  if (body.event_id && !firstTime(`${i.id}:evt:${body.event_id}`)) return;
  await handleEvent(i, body.event as never, { primary }).catch((err) =>
    console.error("[slack] event handler failed", err),
  );
}

export async function dispatchInteraction(integrationId: string, payload: unknown) {
  const i = await getSlackIntegration(integrationId);
  if (!i || !i.enabled) return {};
  return handleInteraction(i, payload as never);
}

export async function dispatchCommand(integrationId: string, body: unknown) {
  const i = await getSlackIntegration(integrationId);
  if (!i || !i.enabled)
    return { response: { response_type: "ephemeral", text: "This Slack connection is disabled in trace." } };
  return handleCommand(i, body as never);
}

const runAfter = (after?: () => Promise<void>) => {
  if (after) after().catch((err) => console.error("[slack] deferred handler failed", err));
};

/* ------------------------------------------------------------------ Socket Mode */

interface Running {
  client: SocketModeClient;
  fingerprint: string;
  orgId: string;
  connected: boolean;
}

const sockets = new Map<string, Running>();

export function socketState(integrationId: string) {
  const s = sockets.get(integrationId);
  return s ? (s.connected ? "connected" : "connecting") : "off";
}

async function stopSocket(id: string) {
  const s = sockets.get(id);
  if (!s) return;
  sockets.delete(id);
  s.client.removeAllListeners();
  await s.client.disconnect().catch(() => {});
}

async function startSocket(i: SlackIntegration) {
  const fingerprint = `${i.config.appToken}|${i.config.botToken}`;
  const current = sockets.get(i.id);
  if (current?.fingerprint === fingerprint) return;
  await stopSocket(i.id);

  const client = new SocketModeClient({
    appToken: i.config.appToken!,
    logLevel: LogLevel.ERROR,
    autoReconnectEnabled: true,
  });
  const running: Running = { client, fingerprint, orgId: i.orgId, connected: false };
  sockets.set(i.id, running);

  client.on("connected", async () => {
    running.connected = true;
    await setStatus(i.id, "connected", null);
    bus.publish({ type: "integration.updated", orgId: i.orgId, integrationId: i.id });
  });
  client.on("disconnected", () => {
    running.connected = false;
  });
  client.on(
    "slack_event",
    async ({
      ack,
      type,
      body,
      retry_num,
    }: {
      ack: (r?: unknown) => Promise<void>;
      type: string;
      body: Record<string, unknown>;
      retry_num?: number;
    }) => {
      try {
        if (type === "events_api") {
          await ack();
          if (retry_num) return;
          if (body.type === "event_callback") await dispatchEventCallback(i.id, body);
        } else if (type === "interactive") {
          const res = await dispatchInteraction(i.id, body);
          await ack(res.response);
          runAfter(res.after);
        } else if (type === "slash_commands") {
          const res = await dispatchCommand(i.id, body);
          await ack(res.response);
          runAfter(res.after);
        }
      } catch (err) {
        console.error("[slack] socket event failed", err);
        await ack().catch(() => {});
      }
    },
  );

  try {
    await client.start();
  } catch (err) {
    console.warn(`[slack] socket mode failed for ${i.name}:`, slackError(err));
    await stopSocket(i.id);
    await setStatus(i.id, "error", `Socket Mode: ${slackError(err)}`);
    bus.publish({ type: "integration.updated", orgId: i.orgId, integrationId: i.id });
  }
}

/** Start/stop Socket Mode clients so they match the integrations table (all orgs, or one). */
export async function syncSockets(orgId?: string) {
  const rows = await listSlackIntegrations(orgId);
  const wanted = new Set<string>();
  for (const i of rows) {
    if (i.enabled && i.config.appToken) {
      wanted.add(i.id);
      startSocket(i).catch((err) => console.error("[slack] start failed", err));
    }
  }
  for (const [id, s] of sockets) {
    if (orgId && s.orgId !== orgId) continue;
    if (!wanted.has(id)) await stopSocket(id);
  }
}

export async function stopIntegrationSocket(id: string) {
  await stopSocket(id);
}
