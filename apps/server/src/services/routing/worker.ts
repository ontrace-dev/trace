import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { tickets, workspaceSettings } from "../../db/schema.ts";
import { bus, type BusEvent } from "../../lib/bus.ts";
import { getSettings } from "../workspace.ts";
import { getRouting, routeTicket } from "./engine.ts";

/**
 * When routing runs: on the AI's hand-offs (bus events) and on a one-minute sweep for tickets whose
 * first reply is about to slip, plus the safety net that hands silent assignments back to the group.
 */

const pct = (n: number) => `${Math.round(n * 100)}%`;
const mins = (ms: number) => {
  const m = Math.round(Math.abs(ms) / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

async function onEvent(e: BusEvent) {
  if (!["ticket.escalated", "draft.ready", "ai.state", "ticket.created"].includes(e.type)) return;
  const settings = await getRouting(e.orgId);
  if (!settings.enabled) return;
  const ticketId = (e as { ticketId: string }).ticketId;
  const tr = settings.triggers;

  if (e.type === "ticket.created") {
    const ai = (await getSettings(e.orgId)).ai;
    // Without the AI agent there is no AI-first step: every ticket needs a person.
    if (tr.everyTicket || !ai.enabled)
      await routeTicket(e.orgId, ticketId, "new", ai.enabled ? "every new ticket" : "AI agent is off");
    return;
  }
  if (e.type === "ticket.escalated") {
    const [t] = await db.select({ aiState: tickets.aiState }).from(tickets).where(eq(tickets.id, ticketId));
    if (t?.aiState === "awaiting_approval" || /approval/i.test(e.reason)) {
      if (tr.approval) await routeTicket(e.orgId, ticketId, "approval", "an action waits for approval");
    } else if (tr.handoff) {
      await routeTicket(e.orgId, ticketId, "handoff", e.reason ? `trace handed off: ${e.reason}` : "trace handed off");
    }
    return;
  }
  if (e.type === "draft.ready") {
    if (!tr.lowConfidence) return;
    const [t] = await db
      .select({ c: tickets.aiConfidence, aiState: tickets.aiState })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    if (t?.c != null && t.aiState === "draft_ready" && t.c < tr.confidenceBelow)
      await routeTicket(e.orgId, ticketId, "low_confidence", `trace's draft ${pct(t.c)} < ${pct(tr.confidenceBelow)}`);
    return;
  }
  if (e.type === "ai.state" && e.state === "error" && tr.handoff) {
    await routeTicket(e.orgId, ticketId, "ai_error", "trace failed on this ticket");
  }
}

/** One pass over every workspace with routing on. */
export async function sweep() {
  const orgs = await db
    .select({ orgId: workspaceSettings.orgId })
    .from(workspaceSettings)
    .where(sql`(${workspaceSettings.routing} ->> 'enabled')::boolean is true`);
  const now = Date.now();
  for (const { orgId } of orgs) {
    const s = await getRouting(orgId);
    // First reply about to slip (or already late) and nobody owns it.
    if (s.triggers.slaSoon) {
      const due = await db
        .select({ id: tickets.id, dueAt: tickets.firstResponseDueAt })
        .from(tickets)
        .where(
          and(
            eq(tickets.orgId, orgId),
            eq(tickets.status, "open"),
            isNull(tickets.assigneeId),
            isNull(tickets.firstRespondedAt),
            sql`${tickets.firstResponseDueAt} < ${new Date(now + s.triggers.slaMinutes * 60_000).toISOString()}`,
          ),
        )
        .limit(50);
      for (const t of due) {
        const left = t.dueAt!.getTime() - now;
        await routeTicket(
          orgId,
          t.id,
          "sla",
          left > 0 ? `first reply due in ${mins(left)}` : `first reply ${mins(left)} late`,
        );
      }
    }
    // Safety net: an auto-assigned ticket nobody has answered goes back to the group.
    if (s.reassign.enabled) {
      const window = s.reassign.minutesBeforeDue * 60_000;
      const silent = await db
        .select({
          id: tickets.id,
          dueAt: tickets.firstResponseDueAt,
          assignedAt: tickets.assignedAt,
          routing: tickets.routing,
        })
        .from(tickets)
        .where(
          and(
            eq(tickets.orgId, orgId),
            inArray(tickets.status, ["open"]),
            isNotNull(tickets.assigneeId),
            isNull(tickets.firstRespondedAt),
            isNotNull(tickets.firstResponseDueAt),
            sql`(${tickets.routing} ->> 'auto')::boolean is true`,
            sql`coalesce((${tickets.routing} ->> 'reassignments')::int, 0) < ${s.reassign.maxTimes}`,
          ),
        )
        .limit(50);
      for (const t of silent) {
        const windowStart = t.dueAt!.getTime() - window;
        const assigned = t.assignedAt?.getTime() ?? 0;
        // Assigned before the window opened: hand back once it opens. Assigned inside it (e.g. already late):
        // the assignee still gets the same grace period before it moves on.
        const handBack = assigned < windowStart ? now >= windowStart : now - assigned >= Math.max(window, 5 * 60_000);
        if (!handBack) continue;
        const left = t.dueAt!.getTime() - now;
        await routeTicket(
          orgId,
          t.id,
          "reassign",
          left > 0 ? `no reply ${mins(left)} before target` : `no reply, ${mins(left)} past target`,
        );
      }
    }
  }
}

export function startRouting() {
  bus.on("event", (e: BusEvent) => {
    onEvent(e).catch((err) => console.error("[routing]", err));
  });
  setInterval(() => sweep().catch((err) => console.error("[routing] sweep", err)), 60_000).unref();
}
