import { and, eq } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "../../db/index.ts";
import { member, user } from "../../db/schema.ts";
import { env } from "../../env.ts";
import type { DiscordIntegration } from "./client.ts";

export interface MemberMatch {
  id: string;
  name: string;
  email: string;
}

/**
 * Discord doesn't expose emails, so teammates link their Discord account to their trace user
 * (via `/trace link` or by an admin in settings). A linked user acts as that member.
 */
export async function memberForDiscordUser(
  i: DiscordIntegration,
  discordUserId: string,
): Promise<MemberMatch | undefined> {
  const link = (i.config.userLinks ?? []).find((l) => l.discordUserId === discordUserId);
  if (!link) return undefined;
  const [m] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, i.orgId), eq(user.id, link.userId)))
    .limit(1);
  return m;
}

/* ------------------------------------------------------------------ self-service link tokens */

interface LinkPayload {
  i: string; // integration id
  d: string; // discord user id
  n: string; // discord display name
  e: number; // expiry (ms)
}

const sign = (data: string) =>
  createHmac("sha256", `discord-link:${env.BETTER_AUTH_SECRET}`).update(data).digest("base64url");

/** A short-lived token a Discord user opens in trace (while signed in) to link their account. */
export function createLinkToken(
  integrationId: string,
  discordUserId: string,
  discordName: string,
  ttlMs = 30 * 60_000,
) {
  const payload: LinkPayload = { i: integrationId, d: discordUserId, n: discordName, e: Date.now() + ttlMs };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${sign(data)}`;
}

export function readLinkToken(token: string): LinkPayload | null {
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = sign(data);
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const p = JSON.parse(Buffer.from(data, "base64url").toString()) as LinkPayload;
    return p.e > Date.now() ? p : null;
  } catch {
    return null;
  }
}
