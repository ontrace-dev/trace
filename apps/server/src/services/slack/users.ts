import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { member, user } from "../../db/schema.ts";
import { type SlackIntegration, slackOf } from "./client.ts";

export interface SlackProfile {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  isBot: boolean;
}

const profileCache = new Map<string, { at: number; p: SlackProfile }>();
const TTL = 10 * 60_000;

export async function slackProfile(i: SlackIntegration, slackUserId: string): Promise<SlackProfile> {
  const key = `${i.id}:${slackUserId}`;
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  let p: SlackProfile = { id: slackUserId, name: slackUserId, isBot: false };
  try {
    const res = await slackOf(i).users.info({ user: slackUserId });
    const u = res.user;
    if (u) {
      p = {
        id: slackUserId,
        name: u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || slackUserId,
        email: u.profile?.email?.toLowerCase(),
        avatar: u.profile?.image_72,
        isBot: !!u.is_bot,
      };
    }
  } catch (err) {
    console.warn("[slack] users.info failed", slackUserId, (err as Error).message);
  }
  profileCache.set(key, { at: Date.now(), p });
  return p;
}

export interface MemberMatch {
  id: string;
  name: string;
  email: string;
}

/** A Slack user is a trace agent when their Slack email matches a member of the workspace. */
export async function memberForSlackUser(i: SlackIntegration, slackUserId: string): Promise<MemberMatch | undefined> {
  const p = await slackProfile(i, slackUserId);
  if (!p.email) return undefined;
  const [m] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, i.orgId), sql`lower(${user.email}) = ${p.email}`))
    .limit(1);
  return m;
}
