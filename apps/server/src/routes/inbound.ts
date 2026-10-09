import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index.ts";
import { channels } from "../db/schema.ts";
import { notFound } from "../lib/http.ts";
import { handleInboundEmail, type InboundEmail, parseRaw } from "../services/email/inbound.ts";

/**
 * Inbound email webhooks. Point your provider's inbound-parse webhook at
 *   POST /api/inbound/email/:token
 * Supported payloads:
 *   - raw MIME (Content-Type: message/rfc822) — e.g. Cloudflare Email Workers, AWS SES→Lambda
 *   - Postmark inbound JSON
 *   - SendGrid Inbound Parse (multipart, with "email" raw field when "send raw" is on)
 *   - Mailgun routes (multipart, "body-mime" or parsed fields)
 *   - generic JSON { from, to, subject, text, html, messageId, inReplyTo, references }
 */
export const inboundRoutes = new Hono();

const parseAddress = (v: string) => {
  const m = v.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1]!.trim() || undefined, address: m[2]!.trim() } : { address: v.trim() };
};
const splitList = (v?: string | string[]) =>
  (Array.isArray(v) ? v : (v ?? "").split(",")).map((x) => parseAddress(String(x)).address).filter(Boolean);

inboundRoutes.post("/email/:token", async (c) => {
  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.inboundToken, c.req.param("token")));
  if (!channel || channel.type !== "email") throw notFound("Unknown inbound token");
  const ct = c.req.header("content-type") ?? "";
  let email: InboundEmail;

  if (ct.includes("message/rfc822") || ct.startsWith("text/plain")) {
    email = await parseRaw(Buffer.from(await c.req.arrayBuffer()), channel.address ? [channel.address] : []);
  } else if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
    const form = await c.req.parseBody({ all: false });
    const raw = (form.email ?? form["body-mime"]) as string | undefined;
    if (raw) {
      email = await parseRaw(raw, channel.address ? [channel.address] : []);
    } else {
      const files = Object.values(form).filter((v): v is File => typeof v !== "string");
      email = {
        from: parseAddress(String(form.from ?? form.sender ?? "")),
        to: splitList(String(form.to ?? form.recipient ?? channel.address ?? "")),
        subject: String(form.subject ?? ""),
        text: String(form.text ?? form["body-plain"] ?? form["stripped-text"] ?? ""),
        html: form.html || form["body-html"] ? String(form.html ?? form["body-html"]) : undefined,
        messageId: form["Message-Id"] ? String(form["Message-Id"]) : undefined,
        inReplyTo: form["In-Reply-To"] ? String(form["In-Reply-To"]) : undefined,
        attachments: await Promise.all(
          files.map(async (f) => ({
            filename: f.name,
            contentType: f.type,
            content: Buffer.from(await f.arrayBuffer()),
          })),
        ),
      };
    }
  } else {
    const j = (await c.req.json()) as Record<string, unknown>;
    if (typeof j.raw === "string") {
      email = await parseRaw(j.raw, channel.address ? [channel.address] : []);
    } else if ("FromFull" in j || "TextBody" in j) {
      // Postmark
      const headers = (j.Headers as { Name: string; Value: string }[] | undefined) ?? [];
      const h = (n: string) => headers.find((x) => x.Name.toLowerCase() === n)?.Value;
      const from = j.FromFull as { Email: string; Name?: string } | undefined;
      email = {
        from: { address: from?.Email ?? String(j.From ?? ""), name: from?.Name },
        to: ((j.ToFull as { Email: string }[]) ?? []).map((t) => t.Email),
        cc: ((j.CcFull as { Email: string }[]) ?? []).map((t) => t.Email),
        subject: String(j.Subject ?? ""),
        text: String(j.TextBody ?? ""),
        html: j.HtmlBody ? String(j.HtmlBody) : undefined,
        messageId: h("message-id") ?? String(j.MessageID ?? ""),
        inReplyTo: h("in-reply-to"),
        references: h("references")?.split(/\s+/),
        attachments: ((j.Attachments as { Name: string; ContentType: string; Content: string }[]) ?? []).map((a) => ({
          filename: a.Name,
          contentType: a.ContentType,
          content: Buffer.from(a.Content, "base64"),
        })),
      };
    } else {
      const from = j.from as string | { address: string; name?: string };
      email = {
        from: typeof from === "string" ? parseAddress(from) : from,
        to: splitList((j.to as string | string[]) ?? channel.address ?? ""),
        cc: splitList(j.cc as string | string[] | undefined),
        subject: String(j.subject ?? ""),
        text: j.text ? String(j.text) : undefined,
        html: j.html ? String(j.html) : undefined,
        messageId: j.messageId ? String(j.messageId) : undefined,
        inReplyTo: j.inReplyTo ? String(j.inReplyTo) : undefined,
        references: Array.isArray(j.references) ? (j.references as string[]) : undefined,
      };
    }
  }
  const result = await handleInboundEmail(email, channel);
  return c.json(result, result.ok ? 200 : 422);
});
