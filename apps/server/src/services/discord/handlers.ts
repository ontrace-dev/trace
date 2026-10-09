import { and, eq, sql } from "drizzle-orm";
import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  ChannelType,
  type Interaction,
  type Message as DiscordMessage,
  MessageFlags,
  type ModalSubmitInteraction,
  Routes,
} from "discord.js";
import { db } from "../../db/index.ts";
import { messages, tickets } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { truncate } from "../../lib/text.ts";
import { askWorkspace } from "../ai/copilot.ts";
import { listTickets, pendingDraftFor, sidebarCounts } from "../queries.ts";
import { addMessage, createTicket, getTicket, sendDraft, updateTicket, upsertCustomer } from "../tickets.ts";
import { Trace } from "../tracer.ts";
import { getOrg } from "../workspace.ts";
import { NO_PINGS, parseCustomId, replyModal, threadName } from "./cards.ts";
import { type DiscordIntegration, discordError, rest } from "./client.ts";
import { postChunks, workspaceRef } from "./notify.ts";
import { createLinkToken, memberForDiscordUser } from "./users.ts";

/* ------------------------------------------------------------------ helpers */

const seen = new Map<string, number>();
/** Gateway resumes can replay events; process each once. */
export function firstTime(key: string) {
  const now = Date.now();
  if (seen.has(key)) return false;
  seen.set(key, now);
  if (seen.size > 5000) for (const [k, t] of seen) if (now - t > 10 * 60_000) seen.delete(k);
  return true;
}

async function alreadyStored(orgId: string, externalId: string) {
  const [m] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.externalId, externalId)))
    .limit(1);
  return !!m;
}

/** Find the ticket a Discord thread belongs to: a card thread (notes) or an intake thread (conversation). */
async function ticketByThread(i: DiscordIntegration, threadId: string) {
  const [notif] = await db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.orgId, i.orgId),
        sql`${tickets.discord}->'notifications'->${i.id}::text->>'threadId' = ${threadId}`,
      ),
    )
    .limit(1);
  if (notif) return { ticket: notif, kind: "notification" as const };
  const [intake] = await db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.orgId, i.orgId),
        sql`${tickets.discord}->'intake'->>'integrationId' = ${i.id}`,
        sql`${tickets.discord}->'intake'->>'threadId' = ${threadId}`,
      ),
    )
    .limit(1);
  if (intake) return { ticket: intake, kind: "intake" as const };
  return undefined;
}

const displayName = (m: DiscordMessage) => m.member?.displayName ?? m.author.globalName ?? m.author.username;

/** Message text with mentions resolved and attachments listed. */
export function plainText(m: Pick<DiscordMessage, "cleanContent" | "attachments">) {
  let body = (m.cleanContent ?? "").trim();
  const files = [...m.attachments.values()].map((a) => a.name).filter(Boolean);
  if (files.length) body = `${body}\n\n(attached in Discord: ${files.join(", ")})`.trim();
  return body;
}

/**
 * Classify an incoming message. Pure so it can be reasoned about (and tested) without a gateway:
 * - "intake-new": top-level message in an intake text channel, or the starter post of an intake forum thread
 * - "thread": message inside a thread (card thread or intake thread)
 * - "ignore": everything else
 */
export function classifyMessage(
  intakeChannelIds: string[],
  msg: { id: string; channelId: string; isThread: boolean; parentId: string | null },
): "intake-new" | "thread" | "ignore" {
  if (!msg.isThread) return intakeChannelIds.includes(msg.channelId) ? "intake-new" : "ignore";
  // A forum post's starter message has the same id as its thread.
  if (msg.parentId && intakeChannelIds.includes(msg.parentId) && msg.id === msg.channelId) return "intake-new";
  return "thread";
}

/* ------------------------------------------------------------------ messages */

export async function handleMessage(i: DiscordIntegration, m: DiscordMessage) {
  if (m.author.bot || m.webhookId || m.system) return;
  if (i.config.guildId && m.guildId !== i.config.guildId) return;
  const externalId = `discord:${m.channelId}:${m.id}`;
  if (!firstTime(`${i.id}:${externalId}`)) return;
  if (await alreadyStored(i.orgId, externalId)) return;

  const isThread = m.channel.isThread();
  const parentId = isThread ? m.channel.parentId : null;
  const kind = classifyMessage(
    (i.config.intakeChannels ?? []).map((c) => c.id),
    { id: m.id, channelId: m.channelId, isThread, parentId },
  );
  const botMentioned = !!i.config.botUserId && m.mentions.users.has(i.config.botUserId);

  if (kind === "intake-new") return openTicketFromMessage(i, m, externalId);
  if (kind === "thread") {
    const hit = await ticketByThread(i, m.channelId);
    if (hit) return threadReply(i, m, hit.ticket.id, hit.kind, externalId);
  }
  if (botMentioned) return answerMention(i, m);
}

async function openTicketFromMessage(i: DiscordIntegration, m: DiscordMessage, externalId: string) {
  const body = plainText(m);
  if (!body) return;
  const name = displayName(m);
  // Forum post: the message lives in its own thread (channelId = thread, parent = forum). Text channel: top-level.
  const forumThread = m.channel.isThread() ? m.channel : null;
  const subject = forumThread?.name ?? body.split("\n").find((l) => l.trim()) ?? body;
  const { ticket } = await createTicket(i.orgId, {
    subject: truncate(subject.trim(), 90),
    body,
    channel: "discord",
    customer: { externalId: `discord:${m.author.id}`, name, avatarUrl: m.author.displayAvatarURL() },
    externalId,
    discord: {
      intake: {
        integrationId: i.id,
        channelId: forumThread?.parentId ?? m.channelId,
        messageId: m.id,
        threadId: forumThread ? m.channelId : undefined,
      },
    },
    meta: { via: "discord", discord: { channelId: m.channelId, messageId: m.id, user: m.author.id } },
  });
  const isForumPost = !!forumThread;
  // Text channels: open a thread on the customer's message so the conversation has a home.
  if (!isForumPost) {
    const { ref } = await workspaceRef(i.orgId, ticket.number);
    const thread = (await rest(i)
      .post(Routes.threads(m.channelId, m.id), {
        body: { name: threadName(ref, ticket.subject), auto_archive_duration: 10080 },
      })
      .catch((err) => {
        console.warn("[discord] couldn't open an intake thread:", discordError(err));
        return null;
      })) as { id: string } | null;
    if (thread) {
      await db
        .update(tickets)
        .set({ discord: sql`jsonb_set(${tickets.discord}, '{intake,threadId}', ${JSON.stringify(thread.id)}::jsonb)` })
        .where(eq(tickets.id, ticket.id));
    }
  }
  await rest(i)
    .put(Routes.channelMessageOwnReaction(m.channelId, m.id, encodeURIComponent("👀")))
    .catch(() => {});
  await new Trace(i.orgId, ticket.id).event(
    "discord.intake",
    "integration",
    `ticket opened from Discord message by ${name}`,
  );
}

async function threadReply(
  i: DiscordIntegration,
  m: DiscordMessage,
  ticketId: string,
  kind: "notification" | "intake",
  externalId: string,
) {
  const body = plainText(m);
  if (!body) return;
  const name = displayName(m);
  const member = await memberForDiscordUser(i, m.author.id);
  const discordMeta = { channelId: m.channelId, messageId: m.id, user: m.author.id };
  const trace = new Trace(i.orgId, ticketId);
  if (kind === "notification") {
    // Team chatter on the card's thread stays internal.
    await addMessage(i.orgId, ticketId, {
      kind: "note",
      authorType: "agent",
      authorId: member?.id ?? null,
      authorName: member?.name ?? `${name} (Discord)`,
      body,
      externalId,
      meta: { via: "discord", discord: discordMeta },
    });
    await trace.event("discord.inbound", "integration", `note from ${name} via Discord thread`);
    return;
  }
  if (member) {
    // A teammate answering in the customer's thread — the customer already sees it, so no re-delivery.
    await addMessage(i.orgId, ticketId, {
      authorType: "agent",
      authorId: member.id,
      authorName: member.name,
      body,
      externalId,
      meta: { via: "discord", discord: discordMeta },
    });
  } else {
    const customer = await upsertCustomer(i.orgId, {
      externalId: `discord:${m.author.id}`,
      name,
      avatarUrl: m.author.displayAvatarURL(),
    });
    await addMessage(i.orgId, ticketId, {
      authorType: "customer",
      authorId: customer.id,
      authorName: customer.name,
      body,
      externalId,
      meta: { via: "discord", discord: discordMeta },
    });
  }
  await trace.event("discord.inbound", "integration", `${member ? "agent" : "customer"} reply in intake thread`);
}

async function answerMention(i: DiscordIntegration, m: DiscordMessage) {
  const question = plainText(m)
    .replace(new RegExp(`@${m.client.user?.username ?? "trace"}`, "gi"), "")
    .trim();
  if (!question) {
    await m.reply({
      content: "Ask me anything about your queue, customers or knowledge base.",
      allowedMentions: { parse: [] },
    });
    return;
  }
  try {
    if ("sendTyping" in m.channel) await m.channel.sendTyping().catch(() => {});
    const res = await askWorkspace(i.orgId, question);
    const parts = truncate(res.answer, 1900);
    await m.reply({ content: parts, allowedMentions: { parse: [] } });
  } catch (err) {
    await m.reply({ content: `⚠️ ${discordError(err)}`, allowedMentions: { parse: [] } }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ interactions */

const NOT_LINKED =
  "Your Discord account isn't linked to a trace user yet. Run `/trace link` and open the link while signed in to trace.";

export async function handleInteraction(i: DiscordIntegration, it: Interaction) {
  try {
    if (it.isButton()) return await onButton(i, it);
    if (it.isModalSubmit()) return await onModal(i, it);
    if (it.isChatInputCommand() && it.commandName === "trace") return await onCommand(i, it);
  } catch (err) {
    console.error("[discord] interaction failed", err);
    if (it.isRepliable()) {
      const content = `⚠️ ${discordError(err)}`;
      await (
        it.deferred || it.replied ? it.editReply({ content }) : it.reply({ content, flags: MessageFlags.Ephemeral })
      ).catch(() => {});
    }
  }
}

async function onButton(i: DiscordIntegration, it: ButtonInteraction) {
  const parsed = parseCustomId(it.customId);
  if (!parsed) return;
  const ticket = await getTicket(i.orgId, parsed.ticketId);
  if (!ticket) return it.reply({ content: "That ticket no longer exists.", flags: MessageFlags.Ephemeral });

  // Opening a modal must be the first response — do it before anything slow.
  if (parsed.action === "rp") {
    const [draft, { ref }] = await Promise.all([pendingDraftFor(ticket.id), workspaceRef(i.orgId, ticket.number)]);
    return it.showModal(replyModal(ticket.id, ref, draft?.body) as never);
  }

  const member = await memberForDiscordUser(i, it.user.id);
  if (!member) return it.reply({ content: NOT_LINKED, flags: MessageFlags.Ephemeral });
  await it.deferReply({ flags: MessageFlags.Ephemeral });
  const actor = { type: "agent" as const, id: member.id, name: member.name };
  const trace = new Trace(i.orgId, ticket.id);
  switch (parsed.action) {
    case "sd":
      await sendDraft(i.orgId, ticket.id, { id: member.id, name: member.name });
      await trace.event("discord.action", "integration", `${member.name} sent the AI draft from Discord`);
      return it.editReply("✅ Draft sent to the customer.");
    case "am":
      await updateTicket(i.orgId, ticket.id, { assigneeId: member.id }, actor);
      await trace.event("discord.action", "integration", `${member.name} took the ticket from Discord`);
      return it.editReply("✅ Assigned to you.");
    case "rs":
      await updateTicket(i.orgId, ticket.id, { status: "resolved" }, actor);
      await trace.event("discord.action", "integration", `${member.name} resolved from Discord`);
      return it.editReply("✅ Resolved.");
    case "ro":
      await updateTicket(i.orgId, ticket.id, { status: "open" }, actor);
      return it.editReply("✅ Reopened.");
  }
}

async function onModal(i: DiscordIntegration, it: ModalSubmitInteraction) {
  const parsed = parseCustomId(it.customId);
  if (!parsed || parsed.action !== "rm") return;
  const body = it.fields.getTextInputValue("body").trim();
  const member = await memberForDiscordUser(i, it.user.id);
  if (!member) return it.reply({ content: NOT_LINKED, flags: MessageFlags.Ephemeral });
  if (!body) return it.reply({ content: "Write a message first.", flags: MessageFlags.Ephemeral });
  await it.deferReply({ flags: MessageFlags.Ephemeral });
  const ticket = await getTicket(i.orgId, parsed.ticketId);
  if (!ticket) return it.editReply("That ticket no longer exists.");
  await addMessage(i.orgId, ticket.id, {
    authorType: "agent",
    authorId: member.id,
    authorName: member.name,
    body,
    meta: { via: "web" }, // delivered over the ticket's own channel (email, widget, Discord intake…)
  });
  if (!ticket.assigneeId) {
    await updateTicket(
      i.orgId,
      ticket.id,
      { assigneeId: member.id },
      { type: "agent", id: member.id, name: member.name },
    );
  }
  await new Trace(i.orgId, ticket.id).event("discord.action", "integration", `${member.name} replied from Discord`);
  return it.editReply("✅ Reply sent to the customer.");
}

/* ------------------------------------------------------------------ /trace */

/** Slash command definition, registered per guild on connect. */
export const TRACE_COMMAND = {
  name: "trace",
  description: "Your helpdesk, from Discord",
  options: [
    {
      type: 1,
      name: "ask",
      description: "Ask the AI about your queue, customers or knowledge base",
      options: [{ type: 3, name: "question", description: "Your question", required: true }],
    },
    {
      type: 1,
      name: "search",
      description: "Find tickets",
      options: [{ type: 3, name: "query", description: "Search text", required: true }],
    },
    { type: 1, name: "stats", description: "The queue at a glance" },
    {
      type: 1,
      name: "new",
      description: "Open a ticket",
      options: [
        { type: 3, name: "subject", description: "Short subject", required: true },
        { type: 3, name: "details", description: "What's going on", required: false },
      ],
    },
    { type: 1, name: "link", description: "Link your Discord account to your trace user" },
  ],
};

async function onCommand(i: DiscordIntegration, it: ChatInputCommandInteraction) {
  const sub = it.options.getSubcommand();
  await it.deferReply({ flags: MessageFlags.Ephemeral });
  switch (sub) {
    case "ask": {
      const q = it.options.getString("question", true);
      const res = await askWorkspace(i.orgId, q);
      return it.editReply({ content: truncate(res.answer, 1900), allowedMentions: { parse: [] } });
    }
    case "search": {
      const q = it.options.getString("query", true);
      const rows = await listTickets(i.orgId, { q }, "", { limit: 10 });
      if (!rows.length) return it.editReply(`No tickets match “${truncate(q, 80)}”.`);
      const lines = await Promise.all(
        rows.map(async (r) => {
          const { ref, url } = await workspaceRef(i.orgId, r.number);
          return `• [${ref}](${url}) ${truncate(r.subject, 80)} — *${r.status}*${r.customer?.name ? ` · ${r.customer.name}` : ""}`;
        }),
      );
      return it.editReply({
        content: truncate(`**Tickets matching “${q}”**\n${lines.join("\n")}`, 1900),
        allowedMentions: { parse: [] },
      });
    }
    case "stats": {
      const member = await memberForDiscordUser(i, it.user.id);
      const c = await sidebarCounts(i.orgId, member?.id ?? "");
      return it.editReply(
        [
          "**Queue**",
          `• Open & pending: **${c.inbox ?? 0}**`,
          `• Unassigned: **${c.unassigned ?? 0}**`,
          `• Waiting on AI review: **${c.ai ?? 0}**`,
          member ? `• Assigned to you: **${c.mine ?? 0}**` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    case "new": {
      const subject = it.options.getString("subject", true).trim();
      const details = it.options.getString("details")?.trim() || subject;
      const name =
        it.member && "displayName" in it.member ? it.member.displayName : (it.user.globalName ?? it.user.username);
      let intake: { integrationId: string; channelId: string; messageId: string; threadId?: string } | undefined;
      // Post a root message in this channel and give the ticket a thread there.
      if (it.channel && it.channel.type === ChannelType.GuildText) {
        try {
          const root = (await rest(i).post(Routes.channelMessages(it.channelId), {
            body: {
              content: `🎫 <@${it.user.id}> opened a ticket: **${truncate(subject, 150)}**`,
              allowed_mentions: NO_PINGS,
            },
          })) as { id: string };
          const thread = (await rest(i).post(Routes.threads(it.channelId, root.id), {
            body: { name: truncate(subject, 95), auto_archive_duration: 10080 },
          })) as { id: string };
          intake = { integrationId: i.id, channelId: it.channelId, messageId: root.id, threadId: thread.id };
        } catch {
          /* no permission here — the ticket still gets created */
        }
      }
      const { ticket } = await createTicket(i.orgId, {
        subject: truncate(subject, 120),
        body: details,
        channel: "discord",
        customer: { externalId: `discord:${it.user.id}`, name, avatarUrl: it.user.displayAvatarURL() },
        discord: intake ? { intake } : undefined,
        meta: { via: "discord" },
      });
      const { ref, url } = await workspaceRef(i.orgId, ticket.number);
      if (intake?.threadId)
        await postChunks(i, intake.threadId, `Opened [${ref}](${url}) — reply in this thread to add details.`).catch(
          () => {},
        );
      await new Trace(i.orgId, ticket.id).event(
        "discord.intake",
        "integration",
        `ticket opened with /trace new by ${name}`,
      );
      return it.editReply(`Created [${ref}](${url}) — ${truncate(ticket.subject, 120)}`);
    }
    case "link": {
      const org = await getOrg(i.orgId);
      const name =
        it.member && "displayName" in it.member ? it.member.displayName : (it.user.globalName ?? it.user.username);
      const token = createLinkToken(i.id, it.user.id, name);
      const url = `${env.APP_URL}/w/${org?.slug ?? ""}/settings/discord?link=${encodeURIComponent(token)}`;
      return it.editReply(
        `Open this link while signed in to trace to link **${name}** to your trace user (valid for 30 minutes):\n${url}`,
      );
    }
  }
}
