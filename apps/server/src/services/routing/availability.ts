import { db } from "../../db/index.ts";
import { agentStatus } from "../../db/schema.ts";

/** Available people get tickets from auto-assignment; away people are skipped (when the workspace says so). */
export async function setAvailability(orgId: string, userId: string, status: "available" | "away") {
  await db
    .insert(agentStatus)
    .values({ orgId, userId, status })
    .onConflictDoUpdate({ target: [agentStatus.orgId, agentStatus.userId], set: { status, updatedAt: new Date() } });
}
