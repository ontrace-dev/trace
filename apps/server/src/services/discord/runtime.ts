import { Client, Events, GatewayIntentBits, Partials, Routes } from "discord.js";
import { bus } from "../../lib/bus.ts";
import {
  botToken,
  type DiscordIntegration,
  discordError,
  getDiscordIntegration,
  listDiscordIntegrations,
  restFor,
  setStatus,
} from "./client.ts";
import { handleInteraction, handleMessage, TRACE_COMMAND } from "./handlers.ts";

interface Running {
  client: Client;
  fingerprint: string;
  orgId: string;
}

const clients = new Map<string, Running>();
/** Fingerprints that failed to connect — not retried until the token/server changes or an admin reconnects. */
const failed = new Map<string, string>();

export function clearFailure(id: string) {
  failed.delete(id);
}

export function gatewayState(integrationId: string): "connected" | "connecting" | "off" {
  const r = clients.get(integrationId);
  if (!r) return "off";
  return r.client.isReady() ? "connected" : "connecting";
}

async function stopClient(id: string) {
  const r = clients.get(id);
  if (!r) return;
  clients.delete(id);
  r.client.removeAllListeners();
  await r.client.destroy().catch(() => {});
}

/** Map gateway/login failures to something an admin can act on. */
export function explainGatewayError(err: unknown): string {
  const code = (err as { code?: string | number })?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code === "DisallowedIntents" || code === 4014 || /disallowed intent/i.test(msg)) {
    return "Message Content intent not enabled — turn on “Message Content Intent” under Bot → Privileged Gateway Intents in the Discord Developer Portal.";
  }
  if (code === "TokenInvalid" || code === 4004 || /invalid token/i.test(msg)) {
    return "Discord rejected the bot token — reset it in the Developer Portal and reconnect.";
  }
  return discordError(err);
}

/** Register /trace in each guild the bot serves (guild commands appear instantly, unlike global ones). */
async function registerCommands(i: DiscordIntegration, guildIds: string[]) {
  const rest = restFor(botToken(i));
  for (const gid of guildIds) {
    await rest
      .put(Routes.applicationGuildCommands(i.config.applicationId, gid), { body: [TRACE_COMMAND] })
      .catch((err) => console.warn(`[discord] couldn't register /trace in ${gid}:`, discordError(err)));
  }
}

async function startClient(i: DiscordIntegration) {
  const fingerprint = `${i.config.botToken}|${i.config.guildId ?? ""}`;
  const current = clients.get(i.id);
  if (current?.fingerprint === fingerprint) return;
  if (failed.get(i.id) === fingerprint) return;
  await stopClient(i.id);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
  });
  clients.set(i.id, { client, fingerprint, orgId: i.orgId });

  const publish = () => bus.publish({ type: "integration.updated", orgId: i.orgId, integrationId: i.id });

  client.once(Events.ClientReady, async (c) => {
    console.log(`[discord] ${c.user.tag} connected for ${i.name}`);
    await setStatus(i.id, "connected", null);
    const guildIds = i.config.guildId ? [i.config.guildId] : [...c.guilds.cache.keys()];
    await registerCommands(i, guildIds);
    publish();
  });
  // Joining a new server: make /trace available there too (when no server is pinned yet).
  client.on(Events.GuildCreate, async (g) => {
    const fresh = await getDiscordIntegration(i.id);
    if (fresh && !fresh.config.guildId) await registerCommands(fresh, [g.id]);
  });
  client.on(Events.MessageCreate, async (m) => {
    const fresh = await getDiscordIntegration(i.id); // config (intake channels, links) can change without reconnecting
    if (fresh?.enabled)
      await handleMessage(fresh, m).catch((err) => console.error("[discord] message handler failed", err));
  });
  client.on(Events.InteractionCreate, async (it) => {
    const fresh = await getDiscordIntegration(i.id);
    if (fresh?.enabled) await handleInteraction(fresh, it);
  });
  client.on(Events.ShardDisconnect, async (ev) => {
    if (ev.code === 4014 || ev.code === 4004) {
      failed.set(i.id, fingerprint);
      await setStatus(i.id, "error", explainGatewayError({ code: ev.code }));
      await stopClient(i.id);
      publish();
    }
  });
  client.on(Events.Error, (err) => console.warn("[discord] client error:", discordError(err)));

  try {
    await client.login(botToken(i));
  } catch (err) {
    console.warn(`[discord] login failed for ${i.name}:`, explainGatewayError(err));
    failed.set(i.id, fingerprint);
    await stopClient(i.id);
    await setStatus(i.id, "error", explainGatewayError(err));
    publish();
  }
}

/** Start/stop gateway clients so they match the integrations table (all orgs, or one). */
export async function syncClients(orgId?: string) {
  const rows = await listDiscordIntegrations(orgId);
  const wanted = new Set<string>();
  for (const i of rows) {
    if (i.enabled) {
      wanted.add(i.id);
      startClient(i).catch((err) => console.error("[discord] start failed", err));
    }
  }
  for (const [id, r] of clients) {
    if (orgId && r.orgId !== orgId) continue;
    if (!wanted.has(id)) await stopClient(id);
  }
}

export async function stopIntegrationClient(id: string) {
  failed.delete(id);
  await stopClient(id);
}

/** Guilds the running client is in (falls back to REST when the gateway isn't up). */
export async function botGuilds(i: DiscordIntegration): Promise<{ id: string; name: string; icon: string | null }[]> {
  const r = clients.get(i.id);
  if (r?.client.isReady()) {
    return [...r.client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name, icon: g.iconURL() }));
  }
  const list = (await restFor(botToken(i)).get(Routes.userGuilds())) as {
    id: string;
    name: string;
    icon: string | null;
  }[];
  return list.map((g) => ({ id: g.id, name: g.name, icon: g.icon }));
}
