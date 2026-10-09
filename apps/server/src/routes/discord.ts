import { and, eq } from "drizzle-orm";
import { ChannelType, REST, Routes } from "discord.js";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.ts";
import { integrations, member, user } from "../db/schema.ts";
import { bus } from "../lib/bus.ts";
import { encrypt } from "../lib/crypto.ts";
import { forbidden, notFound } from "../lib/http.ts";
import { id } from "../lib/ids.ts";
import type { DiscordConfig } from "../lib/types.ts";
import {
  type DiscordIntegration,
  discordError,
  getDiscordIntegration,
  inviteUrl,
  listDiscordIntegrations,
  rest,
} from "../services/discord/client.ts";
import { postChunks } from "../services/discord/notify.ts";
import {
  botGuilds,
  clearFailure,
  gatewayState,
  stopIntegrationClient,
  syncClients,
} from "../services/discord/runtime.ts";
import { readLinkToken } from "../services/discord/users.ts";
import { getOrg } from "../services/workspace.ts";
import type { AppEnv } from "./middleware.ts";

const isAdminRole = (role: string) => role.split(",").some((r) => r === "owner" || r === "admin");
const requireAdmin = (role: string) => {
  if (!isAdminRole(role)) throw forbidden("Admins only");
};

function serialize(i: DiscordIntegration) {
  return {
    id: i.id,
    name: i.name,
    enabled: i.enabled,
    status: i.status,
    statusMessage: i.statusMessage,
    createdAt: i.createdAt,
    gateway: gatewayState(i.id),
    inviteUrl: inviteUrl(i.config.applicationId, i.config.guildId),
    config: { ...i.config, botToken: "••••" },
  };
}

async function ownIntegration(orgId: string, integrationId: string) {
  const i = await getDiscordIntegration(integrationId, orgId);
  if (!i) throw notFound("Discord connection not found");
  return i;
}

/** Workspace-scoped Discord settings. Mounted at /api/w/:wid/integrations/discord (user + workspace checked). */
export const discordAppRoutes = new Hono<AppEnv>();

discordAppRoutes.get("/", async (c) => {
  const rows = await listDiscordIntegrations(c.get("orgId"));
  return c.json({ integrations: rows.map(serialize) });
});

discordAppRoutes.post("/connect", async (c) => {
  requireAdmin(c.get("role"));
  const orgId = c.get("orgId");
  const b = z.object({ botToken: z.string().trim() }).parse(await c.req.json());
  if (b.botToken.length < 50) {
    return c.json({ error: "That doesn't look like a Discord bot token — copy it from Bot → Reset Token." }, 400);
  }
  const probe = new REST({ version: "10", timeout: 10_000 }).setToken(b.botToken);
  let me: { id: string; username: string; bot?: boolean };
  let app: { id: string; name: string };
  try {
    me = (await probe.get(Routes.user())) as typeof me;
    app = (await probe.get(Routes.currentApplication())) as typeof app;
  } catch (err) {
    return c.json({ error: `Bot token rejected by Discord: ${discordError(err)}` }, 400);
  }
  if (!me.bot) return c.json({ error: "That's a user token, not a bot token. Copy it from Bot → Reset Token." }, 400);

  const existing = (await listDiscordIntegrations(orgId)).find((x) => x.config.applicationId === app.id);
  const config: DiscordConfig = {
    intakeChannels: [],
    notifyOn: ["ticket.created", "ticket.escalated"],
    threadSync: true,
    userLinks: [],
    ...existing?.config,
    kind: "discord",
    botToken: encrypt(b.botToken),
    applicationId: app.id,
    botUserId: me.id,
    botName: me.username,
  };
  let row;
  if (existing) {
    [row] = await db
      .update(integrations)
      .set({
        config,
        externalId: app.id,
        status: "pending",
        statusMessage: "Connecting to the Discord gateway…",
        enabled: true,
      })
      .where(eq(integrations.id, existing.id))
      .returning();
  } else {
    [row] = await db
      .insert(integrations)
      .values({
        id: id("int"),
        orgId,
        provider: "discord",
        name: app.name || me.username,
        config,
        externalId: app.id,
        status: "pending",
        statusMessage: "Connecting to the Discord gateway…",
      })
      .returning();
  }
  clearFailure(row!.id);
  await syncClients(orgId);
  bus.publish({ type: "integration.updated", orgId, integrationId: row!.id });
  return c.json({ integration: serialize(row as DiscordIntegration) });
});

discordAppRoutes.get("/:id/guilds", async (c) => {
  const i = await ownIntegration(c.get("orgId"), c.req.param("id"));
  try {
    return c.json({ guilds: await botGuilds(i) });
  } catch (err) {
    return c.json({ error: discordError(err) }, 502);
  }
});

const channelRef = z.object({ id: z.string(), name: z.string(), type: z.enum(["text", "forum"]).optional() });
const userLink = z.object({
  discordUserId: z.string().regex(/^\d{5,25}$/, "Discord user ids are numbers"),
  discordName: z.string(),
  userId: z.string(),
});

discordAppRoutes.patch("/:id", async (c) => {
  requireAdmin(c.get("role"));
  const orgId = c.get("orgId");
  const cur = await ownIntegration(orgId, c.req.param("id"));
  const b = z
    .object({
      name: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
      guildId: z.string().nullable().optional(),
      guildName: z.string().nullable().optional(),
      notifyChannel: channelRef.nullable().optional(),
      intakeChannels: z.array(channelRef).optional(),
      notifyOn: z.array(z.enum(["ticket.created", "ticket.escalated", "draft.ready", "message.customer"])).optional(),
      threadSync: z.boolean().optional(),
      waitForAi: z.boolean().optional(),
      userLinks: z.array(userLink).optional(),
    })
    .parse(await c.req.json());
  const config: DiscordConfig = { ...cur.config };
  if (b.guildId !== undefined) {
    if (b.guildId !== cur.config.guildId) {
      // Channels belong to a server; switching servers clears them.
      config.notifyChannel = undefined;
      config.intakeChannels = [];
    }
    config.guildId = b.guildId ?? undefined;
    config.guildName = b.guildName ?? undefined;
  }
  if (b.notifyChannel !== undefined) config.notifyChannel = b.notifyChannel ?? undefined;
  if (b.intakeChannels) config.intakeChannels = b.intakeChannels;
  if (b.notifyOn) config.notifyOn = b.notifyOn;
  if (b.threadSync !== undefined) config.threadSync = b.threadSync;
  if (b.waitForAi !== undefined) config.waitForAi = b.waitForAi;
  if (b.userLinks) {
    // Only link to members of this workspace, one trace user per Discord account.
    const members = await db.select({ id: member.userId }).from(member).where(eq(member.organizationId, orgId));
    const ok = new Set(members.map((m) => m.id));
    const seen = new Set<string>();
    config.userLinks = b.userLinks.filter(
      (l) => ok.has(l.userId) && !seen.has(l.discordUserId) && seen.add(l.discordUserId),
    );
  }
  if (b.enabled === true) clearFailure(cur.id);
  const [row] = await db
    .update(integrations)
    .set({ name: b.name, enabled: b.enabled, config })
    .where(eq(integrations.id, cur.id))
    .returning();
  await syncClients(orgId);
  bus.publish({ type: "integration.updated", orgId, integrationId: cur.id });
  return c.json({ integration: serialize(row as DiscordIntegration) });
});

/** Text and forum channels of the selected server. */
discordAppRoutes.get("/:id/channels", async (c) => {
  const i = await ownIntegration(c.get("orgId"), c.req.param("id"));
  if (!i.config.guildId) return c.json({ channels: [] });
  try {
    const list = (await rest(i).get(Routes.guildChannels(i.config.guildId))) as {
      id: string;
      name: string;
      type: number;
      parent_id?: string | null;
      position: number;
    }[];
    const categories = new Map(list.filter((x) => x.type === ChannelType.GuildCategory).map((x) => [x.id, x.name]));
    const channels = list
      .filter(
        (x) =>
          x.type === ChannelType.GuildText ||
          x.type === ChannelType.GuildForum ||
          x.type === ChannelType.GuildAnnouncement,
      )
      .sort((a, b) => a.position - b.position)
      .map((x) => ({
        id: x.id,
        name: x.name,
        type: x.type === ChannelType.GuildForum ? ("forum" as const) : ("text" as const),
        category: x.parent_id ? (categories.get(x.parent_id) ?? null) : null,
      }));
    return c.json({ channels });
  } catch (err) {
    return c.json({ error: discordError(err) }, 502);
  }
});

/** Search server members to link (needs the Server Members intent; otherwise paste a user id). */
discordAppRoutes.get("/:id/members", async (c) => {
  const i = await ownIntegration(c.get("orgId"), c.req.param("id"));
  const q = c.req.query("q")?.trim() ?? "";
  if (!i.config.guildId || !q) return c.json({ members: [] });
  try {
    const res = (await rest(i).get(Routes.guildMembersSearch(i.config.guildId), {
      query: new URLSearchParams({ query: q, limit: "10" }),
    })) as {
      user: { id: string; username: string; global_name?: string | null; bot?: boolean };
      nick?: string | null;
    }[];
    return c.json({
      members: res
        .filter((m) => !m.user.bot)
        .map((m) => ({
          id: m.user.id,
          name: m.nick ?? m.user.global_name ?? m.user.username,
          username: m.user.username,
        })),
    });
  } catch (err) {
    return c.json({
      members: [],
      error: `${discordError(err)} — enable “Server Members Intent” for search, or paste the Discord user id (Developer Mode → right-click → Copy User ID).`,
    });
  }
});

/** A teammate links their own Discord account using the token from `/trace link`. */
discordAppRoutes.post("/link", async (c) => {
  const orgId = c.get("orgId");
  const me = c.get("user");
  const { token } = z.object({ token: z.string() }).parse(await c.req.json());
  const p = readLinkToken(token);
  if (!p) return c.json({ error: "This link expired or is invalid — run /trace link again in Discord." }, 400);
  const i = await ownIntegration(orgId, p.i);
  const links = (i.config.userLinks ?? []).filter((l) => l.discordUserId !== p.d && l.userId !== me.id);
  links.push({ discordUserId: p.d, discordName: p.n, userId: me.id });
  await db
    .update(integrations)
    .set({ config: { ...i.config, userLinks: links } })
    .where(eq(integrations.id, i.id));
  bus.publish({ type: "integration.updated", orgId, integrationId: i.id });
  return c.json({ ok: true, discordName: p.n, integrationId: i.id });
});

/** Workspace members, for the admin's manual linking UI. */
discordAppRoutes.get("/:id/team", async (c) => {
  const orgId = c.get("orgId");
  await ownIntegration(orgId, c.req.param("id"));
  const rows = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, orgId));
  return c.json({ team: rows });
});

discordAppRoutes.post("/:id/test", async (c) => {
  requireAdmin(c.get("role"));
  const orgId = c.get("orgId");
  const i = await ownIntegration(orgId, c.req.param("id"));
  const channel = i.config.notifyChannel;
  if (!channel) return c.json({ error: "Pick a notification channel first" }, 400);
  const org = await getOrg(orgId);
  try {
    await postChunks(
      i,
      channel.id,
      `✅ **trace is connected** — new tickets for **${org?.name ?? "this workspace"}** will show up here. Replies in a ticket's thread become internal notes.`,
    );
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: discordError(err) }, 502);
  }
});

discordAppRoutes.delete("/:id", async (c) => {
  requireAdmin(c.get("role"));
  const orgId = c.get("orgId");
  const i = await ownIntegration(orgId, c.req.param("id"));
  await stopIntegrationClient(i.id);
  await db.delete(integrations).where(and(eq(integrations.id, i.id), eq(integrations.orgId, orgId)));
  bus.publish({ type: "integration.updated", orgId, integrationId: i.id });
  return c.json({ ok: true });
});
