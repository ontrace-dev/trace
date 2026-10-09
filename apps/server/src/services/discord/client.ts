import { and, eq } from "drizzle-orm";
import { DiscordAPIError, PermissionFlagsBits, REST } from "discord.js";
import { db } from "../../db/index.ts";
import { integrations } from "../../db/schema.ts";
import { decrypt } from "../../lib/crypto.ts";
import type { DiscordConfig } from "../../lib/types.ts";

export type Integration = typeof integrations.$inferSelect;
export type DiscordIntegration = Integration & { config: DiscordConfig };

export function isDiscord(i: Integration): i is DiscordIntegration {
  return i.provider === "discord" && (i.config as DiscordConfig).kind === "discord";
}

export async function getDiscordIntegration(id: string, orgId?: string) {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, id), orgId ? eq(integrations.orgId, orgId) : undefined));
  return row && isDiscord(row) ? row : undefined;
}

export async function listDiscordIntegrations(orgId?: string) {
  const rows = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.provider, "discord"), orgId ? eq(integrations.orgId, orgId) : undefined));
  return rows.filter(isDiscord);
}

export async function setStatus(id: string, status: Integration["status"], message: string | null = null) {
  await db.update(integrations).set({ status, statusMessage: message }).where(eq(integrations.id, id));
}

export const botToken = (i: DiscordIntegration) => decrypt(i.config.botToken);

const rests = new Map<string, REST>();

/** REST client for a bot token. All sending goes through REST so it works while the gateway reconnects. */
export function restFor(token: string) {
  let r = rests.get(token);
  if (!r) {
    r = new REST({ version: "10", timeout: 15_000 }).setToken(token);
    rests.set(token, r);
  }
  return r;
}

export const rest = (i: DiscordIntegration) => restFor(botToken(i));

/** Permissions the bot needs: read/post, embeds, threads, reactions and slash commands. */
export const BOT_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.CreatePublicThreads |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.UseApplicationCommands;

export function inviteUrl(applicationId: string, guildId?: string) {
  const u = new URL("https://discord.com/oauth2/authorize");
  u.searchParams.set("client_id", applicationId);
  u.searchParams.set("scope", "bot applications.commands");
  u.searchParams.set("permissions", BOT_PERMISSIONS.toString());
  if (guildId) {
    u.searchParams.set("guild_id", guildId);
    u.searchParams.set("disable_guild_select", "true");
  }
  return u.toString();
}

export function discordError(err: unknown) {
  if (err instanceof DiscordAPIError) {
    if (err.status === 401) return "Discord rejected the bot token (401 Unauthorized).";
    if (err.code === 50001) return "Missing access — the bot can't see that channel. Check its channel permissions.";
    if (err.code === 50013) return "Missing permissions — give the bot Send Messages, Embed Links and Create Threads.";
    return `${err.message} (Discord ${err.code})`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Discord messages are capped at 2000 characters; split on paragraph/line boundaries. */
export function splitMessage(text: string, max = 1900): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.length ? out : [""];
}
