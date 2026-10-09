import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../../db/index.ts";
import { channels, messages, tickets } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { id } from "../../lib/ids.ts";
import { getTransport } from "../../lib/mailer.ts";
import { markdownToEmailHtml } from "../../lib/text.ts";
import { getCustomer, registerDeliverer } from "../tickets.ts";
import { getOrg, getSettings } from "../workspace.ts";

/** Sends public replies on email tickets, threaded with In-Reply-To/References. */
export function registerEmailDelivery() {
  registerDeliverer("email", async (ticket, message) => {
    const customer = await getCustomer(ticket.customerId);
    if (!customer?.email) throw new Error("customer has no email address");
    const [channel] = ticket.channelId ? await db.select().from(channels).where(eq(channels.id, ticket.channelId)) : [];
    const settings = await getSettings(ticket.orgId);
    const org = await getOrg(ticket.orgId);
    const fromAddress = channel?.address || env.MAIL_FROM.match(/<(.+)>/)?.[1] || "support@trace.local";
    const fromName = channel?.config.fromName || org?.name || "Support";
    const ref = `${settings.ticketPrefix}-${ticket.number}`;
    const domain = fromAddress.split("@")[1] ?? env.INBOUND_DOMAIN;
    const messageId = `${id("out")}@${domain}`;
    const refs = ticket.email?.references ?? [];

    const signature = channel?.config.signature ? `\n\n${channel.config.signature}` : "";
    const text = `${message.body}${signature}`;
    const attachments = await Promise.all(
      message.attachments.map(async (a) => ({
        filename: a.name,
        contentType: a.contentType,
        content: await readFile(join(env.DATA_DIR, "uploads", ticket.orgId, a.id)).catch(() => Buffer.alloc(0)),
      })),
    );

    await getTransport(channel?.config.smtpUrl || env.SMTP_URL).sendMail({
      from: { name: fromName, address: fromAddress },
      to: customer.name ? { name: customer.name, address: customer.email } : customer.email,
      cc: ticket.email?.cc?.filter((c) => c.toLowerCase() !== fromAddress.toLowerCase()),
      replyTo: fromAddress,
      subject: `Re: ${ticket.subject} [${ref}]`,
      text,
      html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#111">${markdownToEmailHtml(text)}<p style="color:#888;font-size:12px;margin-top:24px">${ref} · reply to this email to continue the conversation</p></div>`,
      messageId: `<${messageId}>`,
      inReplyTo: ticket.email?.lastMessageId ? `<${ticket.email.lastMessageId}>` : undefined,
      references: refs.length ? refs.map((r) => `<${r}>`).join(" ") : undefined,
      attachments,
    });

    await db
      .update(tickets)
      .set({
        email: {
          ...(ticket.email ?? { references: [] }),
          references: [...refs, messageId].slice(-20),
          lastMessageId: messageId,
        },
      })
      .where(eq(tickets.id, ticket.id));
    await db.update(messages).set({ externalId: messageId }).where(eq(messages.id, message.id));
    return { via: message.meta.via };
  });
}
