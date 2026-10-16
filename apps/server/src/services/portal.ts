import { and, eq, gt, isNull } from "drizzle-orm";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { db } from "../db/index.ts";
import { channels, customers, organization, portalSignIns } from "../db/schema.ts";
import { env } from "../env.ts";
import { originMatches } from "../lib/guards.ts";
import { secretToken } from "../lib/ids.ts";
import { getTransport } from "../lib/mailer.ts";
import type { PortalSettings } from "../lib/types.ts";
import { escapeHtml, markdownToEmailHtml } from "../lib/text.ts";
import { type Customer, getCustomer, registerDeliverer, type Ticket, upsertCustomer } from "./tickets.ts";
import { getOrg, getSettings } from "./workspace.ts";

/**
 * The customer portal: customers sign in (a one-time email link, or signed in by your own platform)
 * and see every ticket they ever opened, on any channel.
 */

export const defaultPortal = (name = "Support", accent = "#b9a3ff"): PortalSettings => ({
  enabled: true,
  title: `${name} support`,
  intro: "Track your requests, reply to our team and find answers.",
  logoUrl: "",
  homeUrl: "",
  accentColor: accent,
  accentForeground: "",
  theme: "auto",
  radius: 12,
  fontFamily: "",
  emailSignIn: true,
  allowNewRequests: true,
  showKnowledge: true,
  showPoweredBy: true,
  allowedOrigins: [],
  customCss: "",
});

type Settings = Awaited<ReturnType<typeof getSettings>>;

/** Saved portal settings over the defaults (the column is null until someone saves). */
export function portalSettings(s: Settings, orgName?: string): PortalSettings {
  return { ...defaultPortal(orgName, s.widget.accentColor), ...s.portal };
}

export async function findOrgBySlug(slug: string) {
  const [org] = await db.select().from(organization).where(eq(organization.slug, slug));
  return org;
}

export const portalUrl = (slug: string, path = "") => `${env.PUBLIC_URL}/portal/${encodeURIComponent(slug)}${path}`;

// ---------------------------------------------------------------- session tokens

export interface PortalClaims {
  /** workspace (organization) id */
  o: string;
  /** customer id */
  c: string;
  /** Only this ticket (links in notification emails); absent = all of the customer's tickets. */
  t?: string;
  /** expiry, unix seconds */
  exp: number;
}

const DAY = 86_400;
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sig = (payload: string) =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(`portal:${payload}`).digest("base64url");

export function signPortalToken(claims: Omit<PortalClaims, "exp">, ttlSeconds: number) {
  const payload = b64(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  return `${payload}.${sig(payload)}`;
}

export function verifyPortalToken(token: string | undefined, orgId: string): PortalClaims | null {
  if (!token) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = sig(payload);
  if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as PortalClaims;
    if (claims.o !== orgId || !claims.c || claims.exp < Date.now() / 1000) return null;
    return claims;
  } catch {
    return null;
  }
}

export const SESSION_TTL = { email: 30 * DAY, platform: DAY / 2, ticketLink: 60 * DAY };

/** A link to one ticket that works without signing in (it was sent to the customer's mailbox). */
export function ticketLink(slug: string, ticket: Pick<Ticket, "id" | "orgId" | "number" | "customerId">) {
  if (!ticket.customerId) return portalUrl(slug, `/tickets/${ticket.number}`);
  const t = signPortalToken({ o: ticket.orgId, c: ticket.customerId, t: ticket.id }, SESSION_TTL.ticketLink);
  return portalUrl(slug, `/tickets/${ticket.number}?t=${t}`);
}

// ---------------------------------------------------------------- identity from the host platform

export function verifyUserHash(secret: string, subject: string | undefined, hash: string | undefined) {
  if (!hash || !secret || !subject) return false;
  const expected = createHmac("sha256", secret).update(subject).digest("hex");
  return expected.length === hash.length && timingSafeEqual(Buffer.from(expected), Buffer.from(hash.toLowerCase()));
}

/**
 * Find the customer for an identity your platform signed. Only the signed value is trusted:
 * a signed email matches every ticket that email ever opened; a signed userId matches the customer
 * with that external id, and an accompanying (unsigned) email is only attached when nobody else has it.
 */
export async function customerForSignedIdentity(
  orgId: string,
  input: { email?: string; userId?: string; name?: string; attributes?: Record<string, unknown> },
  signed: "email" | "userId",
): Promise<Customer> {
  if (signed === "email") {
    return upsertCustomer(orgId, { email: input.email, name: input.name, attributes: input.attributes });
  }
  const email = input.email?.trim().toLowerCase() || null;
  const [byId] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.orgId, orgId), eq(customers.externalId, input.userId!)));
  const emailTaken = email
    ? (
        await db
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.orgId, orgId), eq(customers.email, email)))
      )[0]
    : undefined;
  if (byId) {
    const patch: Partial<Customer> = { lastSeenAt: new Date() };
    if (input.name && !byId.name) patch.name = input.name;
    if (email && !byId.email && !emailTaken) patch.email = email;
    if (input.attributes) patch.attributes = { ...byId.attributes, ...input.attributes };
    const [row] = await db.update(customers).set(patch).where(eq(customers.id, byId.id)).returning();
    return row!;
  }
  return upsertCustomer(orgId, {
    email: emailTaken ? null : email,
    name: input.name ?? null,
    externalId: input.userId!,
    attributes: input.attributes,
  });
}

// ---------------------------------------------------------------- one-time sign-in links

const hashCode = (code: string) => createHash("sha256").update(`portal-sign-in:${code}`).digest("hex");
const SIGN_IN_MINUTES = 30;

/** Where a sign-in link may send the customer: the hosted portal, or a page on a site you listed. */
export function signInTarget(slug: string, portal: PortalSettings, returnTo?: string) {
  if (returnTo) {
    try {
      const u = new URL(returnTo);
      // Never "*": a sign-in link that can point anywhere would hand the code to whoever asked for it.
      if (/^https?:$/.test(u.protocol) && originMatches(u.origin, portal.allowedOrigins, { wildcard: false })) {
        u.searchParams.delete("trace_code");
        return u;
      }
    } catch {
      /* fall through to the hosted portal */
    }
  }
  return new URL(portalUrl(slug));
}

export async function sendSignInLink(opts: {
  orgId: string;
  slug: string;
  email: string;
  portal: PortalSettings;
  returnTo?: string;
}) {
  const email = opts.email.trim().toLowerCase();
  const code = secretToken(40);
  await db.insert(portalSignIns).values({
    codeHash: hashCode(code),
    orgId: opts.orgId,
    email,
    expiresAt: new Date(Date.now() + SIGN_IN_MINUTES * 60_000),
  });
  const target = signInTarget(opts.slug, opts.portal, opts.returnTo);
  target.searchParams.set("trace_code", code);
  const link = target.toString();
  const org = await getOrg(opts.orgId);
  const name = opts.portal.title || `${org?.name ?? "Support"} support`;
  const from = await senderFor(opts.orgId, org?.name);
  await getTransport(from.smtpUrl).sendMail({
    from: from.from,
    to: email,
    subject: `Sign in to ${name}`,
    text: `Use this link to sign in to ${name} and see your requests:\n\n${link}\n\nIt works once and expires in ${SIGN_IN_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`,
    html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#111">
<p>Use this link to sign in to <b>${escapeHtml(name)}</b> and see your requests:</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:${escapeHtml(opts.portal.accentColor)};color:#111;text-decoration:none;font-weight:600">Sign in</a></p>
<p style="color:#888;font-size:12px">It works once and expires in ${SIGN_IN_MINUTES} minutes. If you didn't ask for it, you can ignore this email.</p></div>`,
  });
}

/** Trade a sign-in code for the email it was sent to (once). */
export async function redeemSignIn(orgId: string, code: string) {
  const [row] = await db
    .update(portalSignIns)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(portalSignIns.codeHash, hashCode(code)),
        eq(portalSignIns.orgId, orgId),
        isNull(portalSignIns.usedAt),
        gt(portalSignIns.expiresAt, new Date()),
      ),
    )
    .returning();
  return row?.email ?? null;
}

// ---------------------------------------------------------------- notifications

/** Mail from the workspace's support address when it has one, so replying by email continues the ticket. */
async function senderFor(orgId: string, orgName?: string) {
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.type, "email"), eq(channels.enabled, true)))
    .limit(1);
  const address = channel?.address || env.MAIL_FROM.match(/<(.+)>/)?.[1] || "support@trace.local";
  return {
    from: { name: channel?.config.fromName || orgName || "Support", address },
    smtpUrl: channel?.config.smtpUrl || env.SMTP_URL,
    canReply: !!channel?.address,
  };
}

/** Footer line for email replies: a link to the request in the portal. Empty when the portal is off. */
export async function portalFooterLink(ticket: Ticket) {
  const s = await getSettings(ticket.orgId);
  if (!portalSettings(s).enabled) return null;
  const org = await getOrg(ticket.orgId);
  return org ? ticketLink(org.slug, ticket) : null;
}

/** Tickets opened in the portal have no mail thread yet: agent replies are emailed with a link back. */
export function registerPortalDelivery() {
  registerDeliverer("portal", async (ticket, message) => {
    const customer = await getCustomer(ticket.customerId);
    if (!customer?.email) return;
    const settings = await getSettings(ticket.orgId);
    const org = await getOrg(ticket.orgId);
    if (!org) return;
    const portal = portalSettings(settings, org.name);
    const ref = `${settings.ticketPrefix}-${ticket.number}`;
    const link = ticketLink(org.slug, ticket);
    const sender = await senderFor(ticket.orgId, org.name);
    const reply = sender.canReply ? "Reply to this email or open your request" : "Open your request to reply";
    await getTransport(sender.smtpUrl).sendMail({
      from: sender.from,
      to: customer.name ? { name: customer.name, address: customer.email } : customer.email,
      replyTo: sender.from.address,
      subject: `Re: ${ticket.subject} [${ref}]`,
      text: `${message.body}\n\n—\n${reply}: ${link}`,
      html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#111">${markdownToEmailHtml(message.body)}<p style="color:#888;font-size:12px;margin-top:24px">${ref} · ${reply}: <a href="${escapeHtml(link)}" style="color:#555">${escapeHtml(portal.title)}</a></p></div>`,
    });
    return { via: message.meta.via };
  });
}
