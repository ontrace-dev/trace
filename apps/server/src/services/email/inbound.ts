import { and, eq, ilike, inArray, or } from "drizzle-orm";
import { simpleParser, type ParsedMail } from "mailparser";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../../db/index.ts";
import { type Attachment, channels, messages, tickets, workspaceSettings } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { id } from "../../lib/ids.ts";
import { htmlToText, stripQuotedReply } from "../../lib/text.ts";
import { addMessage, createTicket, upsertCustomer } from "../tickets.ts";

export interface InboundEmail {
  from: { address: string; name?: string };
  to: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: { filename: string; contentType: string; content: Buffer }[];
}

export type Channel = typeof channels.$inferSelect;

const normalizeId = (v?: string) => v?.trim().replace(/^<|>$/g, "");

/**
 * Find the email channel a message was sent to. A channel matches either its public support
 * address (support@acme.com — when MX/forwarding points at trace) or its generated forwarding
 * address (<token>@INBOUND_DOMAIN), including plus-addressing (anything+<token>@…).
 */
export async function resolveChannel(recipients: string[]): Promise<Channel | undefined> {
  const addrs = recipients.map((r) => r.trim().toLowerCase()).filter(Boolean);
  if (!addrs.length) return undefined;
  const tokens = addrs.flatMap((a) => {
    const [local = "", domain = ""] = a.split("@");
    const out: string[] = [];
    if (domain === env.INBOUND_DOMAIN.toLowerCase()) out.push(local);
    if (local.includes("+")) out.push(local.split("+").at(-1)!);
    return out;
  });
  const rows = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.type, "email"),
        eq(channels.enabled, true),
        or(
          inArray(channels.address, addrs),
          ...addrs.map((a) => ilike(channels.address, a)),
          tokens.length ? inArray(channels.inboundToken, tokens) : undefined,
        ),
      ),
    )
    .limit(1);
  return rows[0];
}

async function saveAttachments(orgId: string, files: InboundEmail["attachments"] = []): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const f of files.slice(0, 10)) {
    if (f.content.length > 15 * 1024 * 1024) continue;
    const attId = id("att");
    const dir = join(env.DATA_DIR, "uploads", orgId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, attId), f.content);
    out.push({ id: attId, name: f.filename || "attachment", size: f.content.length, contentType: f.contentType });
  }
  return out;
}

/** Ticket-reference token we put into outbound subjects, e.g. "[TR-4821]". */
const REF_RE = /\[([A-Z]{1,6})-(\d+)\]/;

async function findThreadTicket(orgId: string, email: InboundEmail) {
  const ids = [normalizeId(email.inReplyTo), ...(email.references ?? []).map(normalizeId)].filter(
    (x): x is string => !!x,
  );
  if (ids.length) {
    const [m] = await db
      .select({ ticketId: messages.ticketId })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), inArray(messages.externalId, ids)))
      .limit(1);
    if (m) return m.ticketId;
  }
  const ref = email.subject.match(REF_RE);
  if (ref) {
    const [ws] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.orgId, orgId));
    if (ws && ws.ticketPrefix === ref[1]) {
      const [t] = await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.orgId, orgId), eq(tickets.number, Number(ref[2]))));
      if (t) return t.id;
    }
  }
  return undefined;
}

export async function handleInboundEmail(email: InboundEmail, channel?: Channel) {
  channel ??= await resolveChannel([...email.to, ...(email.cc ?? [])]);
  if (!channel) return { ok: false as const, reason: "no matching email channel" };
  const orgId = channel.orgId;
  const fromAddr = email.from.address.toLowerCase();
  if (channel.address && fromAddr === channel.address.toLowerCase()) {
    return { ok: false as const, reason: "ignored mail from our own address (loop protection)" };
  }

  const messageId = normalizeId(email.messageId) ?? `${id("eml")}@${env.INBOUND_DOMAIN}`;
  // Idempotency: providers retry webhooks.
  const [dupe] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.externalId, messageId)))
    .limit(1);
  if (dupe) return { ok: true as const, duplicate: true };

  const rawText = email.text?.trim() || (email.html ? htmlToText(email.html) : "");
  const body = stripQuotedReply(rawText);
  const attachments = await saveAttachments(orgId, email.attachments);
  const threadTicketId = await findThreadTicket(orgId, email);

  if (threadTicketId) {
    const customer = await upsertCustomer(orgId, { email: fromAddr, name: email.from.name });
    const [t] = await db.select().from(tickets).where(eq(tickets.id, threadTicketId));
    const refs = [...new Set([...(t?.email?.references ?? []), messageId])].slice(-20);
    await db
      .update(tickets)
      .set({ email: { ...(t?.email ?? { references: [] }), references: refs, lastMessageId: messageId } })
      .where(eq(tickets.id, threadTicketId));
    const msg = await addMessage(orgId, threadTicketId, {
      authorType: "customer",
      authorId: customer.id,
      authorName: customer.name,
      body,
      html: email.html ?? null,
      attachments,
      externalId: messageId,
      meta: { via: "email" },
    });
    return { ok: true as const, ticketId: threadTicketId, messageId: msg.id, threaded: true };
  }

  const { ticket, message } = await createTicket(orgId, {
    subject: email.subject.replace(/^(re|fwd?|aw|wg):\s*/i, "") || "(no subject)",
    body,
    html: email.html ?? null,
    channel: "email",
    channelId: channel.id,
    customer: { email: fromAddr, name: email.from.name || null },
    attachments,
    externalId: messageId,
    email: {
      channelAddress: channel.address ?? undefined,
      references: [messageId],
      lastMessageId: messageId,
      cc: email.cc,
    },
  });
  return { ok: true as const, ticketId: ticket.id, messageId: message?.id, threaded: false };
}

export function fromParsed(mail: ParsedMail, envelopeTo: string[] = []): InboundEmail {
  const addrList = (v: ParsedMail["to"]) =>
    (Array.isArray(v) ? v : v ? [v] : []).flatMap((a) => a.value.map((x) => x.address ?? "")).filter(Boolean);
  const from = mail.from?.value[0];
  const refs = Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [];
  return {
    from: { address: from?.address ?? "unknown@unknown", name: from?.name || undefined },
    to: [...new Set([...envelopeTo, ...addrList(mail.to)])],
    cc: addrList(mail.cc),
    subject: mail.subject ?? "",
    text: mail.text ?? undefined,
    html: typeof mail.html === "string" ? mail.html : undefined,
    messageId: mail.messageId ?? undefined,
    inReplyTo: mail.inReplyTo ?? undefined,
    references: refs,
    attachments: mail.attachments.map((a) => ({
      filename: a.filename ?? "attachment",
      contentType: a.contentType,
      content: a.content,
    })),
  };
}

export async function parseRaw(raw: Buffer | string, envelopeTo: string[] = []) {
  return fromParsed(await simpleParser(raw), envelopeTo);
}
