import { SMTPServer } from "smtp-server";
import { env } from "../../env.ts";
import { handleInboundEmail, parseRaw, resolveChannel } from "./inbound.ts";

/**
 * Built-in inbound SMTP server. Point an MX record (or a forwarding rule from Gmail/Google
 * Workspace/Microsoft 365) at this host and mail to support@yourdomain becomes tickets.
 * Locally you can send to it on port 2525 (see README).
 */
export function startInboundSmtp() {
  if (!env.INBOUND_SMTP_PORT) return;
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"],
    banner: "trace inbound",
    size: 25 * 1024 * 1024,
    logger: false,
    async onRcptTo(address, _session, callback) {
      const channel = await resolveChannel([address.address]).catch(() => undefined);
      if (!channel) return callback(new Error(`550 No mailbox for ${address.address}`));
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", async () => {
        try {
          const rcpt = session.envelope.rcptTo.map((r) => r.address);
          const email = await parseRaw(Buffer.concat(chunks), rcpt);
          const result = await handleInboundEmail(email);
          if (!result.ok) console.warn("[smtp] dropped:", result.reason);
          callback();
        } catch (err) {
          console.error("[smtp] failed to process message", err);
          callback(new Error("451 Temporary failure, please retry"));
        }
      });
    },
  });
  server.on("error", (err) => console.error("[smtp]", err.message));
  server.listen(env.INBOUND_SMTP_PORT, () =>
    console.log(`[smtp] inbound mail server listening on :${env.INBOUND_SMTP_PORT}`),
  );
  return server;
}
