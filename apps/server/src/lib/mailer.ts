import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../env.ts";

const transports = new Map<string, Transporter>();

export function getTransport(smtpUrl = env.SMTP_URL): Transporter {
  let t = transports.get(smtpUrl);
  if (!t) {
    t = nodemailer.createTransport(smtpUrl);
    transports.set(smtpUrl, t);
  }
  return t;
}

/** System mail (invitations, password resets). Goes to Mailpit locally. */
export async function sendSystemMail(opts: { to: string; subject: string; text: string; html?: string }) {
  try {
    await getTransport().sendMail({ from: env.MAIL_FROM, ...opts });
  } catch (err) {
    console.error("[mail] failed to send system mail", err);
  }
}
