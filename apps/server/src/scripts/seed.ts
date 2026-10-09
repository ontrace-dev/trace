import { and, eq } from "drizzle-orm";
import { auth } from "../auth.ts";
import { db } from "../db/index.ts";
import { articles, channels, member, organization, tickets, user, workspaceSettings } from "../db/schema.ts";
import { id, secretToken } from "../lib/ids.ts";
import { runTicketAgent } from "../services/ai/agent.ts";
import { addMessage, createTicket, upsertCustomer } from "../services/tickets.ts";
import { ensureWorkspace, invalidateSettings } from "../services/workspace.ts";
import { backfillIndex } from "../services/knowledge/indexer.ts";
import {
  demoArticles,
  demoCustomers,
  demoFields,
  demoProcedure,
  historicalTickets,
  openTickets,
  weekTickets,
} from "./seed-data.ts";
import { agentStatus, routingGroupMembers, routingGroups, routingRules, ticketFields } from "../db/schema.ts";
import { requestApproval } from "../services/actions/runs.ts";
import { getFields } from "../services/fields.ts";
import { defaultRouting, routeTicket } from "../services/routing/engine.ts";
import { bus } from "../lib/bus.ts";
import { actions, procedures, workspaceSecrets } from "../db/schema.ts";
import { encrypt } from "../lib/crypto.ts";
import { DEMO_BILLING_KEY, getPreset } from "../services/actions/presets.ts";

export const DEMO_EMAIL = "demo@trace.dev";
export const DEMO_PASSWORD = "password";
export const DEMO_SLUG = "northwind";
/** Demo personas: in demo mode their password, email and account can't be changed. */
export const DEMO_TEAM = [
  { email: DEMO_EMAIL, name: "Sam Kim" },
  { email: "lena@trace.dev", name: "Lena Hart" },
  { email: "jo@trace.dev", name: "Jo Okafor" },
  { email: "maya@trace.dev", name: "Maya Chen" },
];

async function ensureUser(email: string, name: string) {
  const [existing] = await db.select().from(user).where(eq(user.email, email));
  if (existing) return existing;
  const res = await auth.api.signUpEmail({ body: { email, password: DEMO_PASSWORD, name } });
  return res.user;
}

/** Creates the demo "northwind" workspace. Idempotent: does nothing if it already exists. */
export async function seedDemo({ log = console.log }: { log?: (...a: unknown[]) => void } = {}) {
  const [existingOrg] = await db.select().from(organization).where(eq(organization.slug, DEMO_SLUG));
  if (existingOrg) {
    // Workspaces seeded before actions existed get the demo automation added.
    if (await ensureDemoAutomation(existingOrg.id)) log("[seed] added demo actions & procedure to northwind");
    log("[seed] demo workspace already exists — skipping");
    return;
  }
  const team = [];
  for (const p of DEMO_TEAM) team.push(await ensureUser(p.email, p.name));
  const owner = team[0]!;
  const org = await auth.api.createOrganization({ body: { name: "Northwind", slug: DEMO_SLUG, userId: owner.id } });
  if (!org) throw new Error("could not create organization");
  for (const mate of team.slice(1)) {
    const [hasMember] = await db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, org.id), eq(member.userId, mate.id)));
    if (!hasMember) {
      await db
        .insert(member)
        .values({ id: id("mem"), organizationId: org.id, userId: mate.id, role: "member", createdAt: new Date() });
    }
  }
  await ensureWorkspace(org.id);
  await db.update(workspaceSettings).set({ ticketSeq: 4800 }).where(eq(workspaceSettings.orgId, org.id));
  invalidateSettings(org.id);

  const [emailChannel] = await db
    .insert(channels)
    .values({
      id: id("ch"),
      orgId: org.id,
      type: "email",
      name: "Support",
      address: "support@northwind.io",
      inboundToken: secretToken(20).toLowerCase(),
      config: { fromName: "Northwind Support", signature: "— Northwind Support" },
    })
    .returning();

  await db.insert(articles).values(
    demoArticles.map((a) => ({
      id: id("art"),
      orgId: org.id,
      ...a,
      status: "published" as const,
      authorId: owner.id,
      citations: Math.floor(Math.random() * 40),
    })),
  );
  for (const c of demoCustomers) await upsertCustomer(org.id, c);
  await ensureDemoAutomation(org.id);
  await ensureDemoFields(org.id);
  await ensureDemoRouting(org.id, team);
  log("[seed] indexing knowledge (downloads the local embedding model on first run)…");
  await backfillIndex();

  const ago = (m: number) => new Date(Date.now() - m * 60_000);
  const make = async (t: (typeof openTickets)[number]) => {
    const { ticket } = await createTicket(org.id, {
      subject: t.subject,
      body: t.body,
      channel: t.channel,
      channelId: t.channel === "email" ? emailChannel!.id : null,
      customer: demoCustomers.find((c) => c.email === t.email) ?? { email: t.email },
      tags: t.tags,
      priority: t.priority,
      skipAi: true,
      createdAt: ago(t.minutesAgo),
      email: t.channel === "email" ? { channelAddress: "support@northwind.io", references: [] } : undefined,
    });
    for (const r of t.replies ?? []) {
      await addMessage(org.id, ticket.id, {
        authorType: r.from === "customer" ? "customer" : r.from,
        authorId: r.from === "agent" ? owner.id : null,
        authorName: r.from === "agent" ? owner.name : r.from === "ai" ? "trace" : null,
        body: r.body,
        meta: { via: "web" },
        createdAt: ago(r.minutesAgo),
        skipAi: true,
        deliver: false,
      });
    }
    if (t.status && t.status !== "open") {
      await db
        .update(tickets)
        .set({
          status: t.status,
          resolvedAt:
            t.status === "resolved" || t.status === "closed"
              ? ago((t.replies?.at(-1)?.minutesAgo ?? t.minutesAgo) - 5)
              : null,
        })
        .where(eq(tickets.id, ticket.id));
    }
    if (t.channel !== "email") await db.update(tickets).set({ email: null }).where(eq(tickets.id, ticket.id));
    return ticket;
  };

  for (const t of [...historicalTickets, ...weekTickets]) await make(t);
  const live = [];
  for (const t of [...openTickets].reverse()) live.push({ t, ticket: await make(t) });

  log(`[seed] running the AI agent on ${live.filter((x) => x.t.runAgent).length} open tickets…`);
  for (const { t, ticket } of live) {
    if (t.runAgent) await runTicketAgent(org.id, ticket.id);
  }
  await demoStates(
    org.id,
    live.map((x) => x.ticket),
  );
  // Route what needs a person, the way the routing worker would after each agent run.
  const routing = defaultRouting();
  for (const { ticket } of live) {
    const [t] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
    if (!t || t.assigneeId || !["open", "pending"].includes(t.status)) continue;
    if (t.aiState === "awaiting_approval") await routeTicket(org.id, t.id, "approval", "an action waits for approval");
    else if (t.aiState === "escalated") await routeTicket(org.id, t.id, "handoff", "trace handed off");
    else if (t.aiState === "draft_ready" && (t.aiConfidence ?? 1) < routing.triggers.confidenceBelow)
      await routeTicket(
        org.id,
        t.id,
        "low_confidence",
        `trace's draft ${Math.round((t.aiConfidence ?? 0) * 100)}% < ${Math.round(routing.triggers.confidenceBelow * 100)}%`,
      );
  }
  log(`[seed] demo workspace ready → sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

/**
 * Demo automation for the northwind workspace: a fake billing API key, two actions
 * (lookup_charges — read-only; refund_charge — needs approval) and the "Duplicate charge" procedure.
 * Idempotent; returns true when something was added.
 */
export async function ensureDemoAutomation(orgId: string) {
  let added = false;
  const [secret] = await db
    .select({ id: workspaceSecrets.id })
    .from(workspaceSecrets)
    .where(and(eq(workspaceSecrets.orgId, orgId), eq(workspaceSecrets.name, "DEMO_BILLING_KEY")));
  if (!secret) {
    await db
      .insert(workspaceSecrets)
      .values({ id: id("sec"), orgId, name: "DEMO_BILLING_KEY", value: encrypt(DEMO_BILLING_KEY) });
    added = true;
  }
  for (const presetId of ["demo.lookup_charges", "demo.refund_charge"]) {
    const { id: _id, group: _g, secrets: _s, setup: _setup, ...fields } = getPreset(presetId)!;
    const [exists] = await db
      .select({ id: actions.id })
      .from(actions)
      .where(and(eq(actions.orgId, orgId), eq(actions.name, fields.name)));
    if (exists) continue;
    await db.insert(actions).values({ id: id("act"), orgId, ...fields, preset: presetId });
    added = true;
  }
  const [proc] = await db
    .select({ id: procedures.id })
    .from(procedures)
    .where(and(eq(procedures.orgId, orgId), eq(procedures.name, demoProcedure.name)));
  if (!proc) {
    await db.insert(procedures).values({ id: id("proc"), orgId, ...demoProcedure, position: 0 });
    added = true;
  }
  return added;
}

/** Ticket fields shown in the demo: org_id from the customer record, app version trace extracts, severity. */
export async function ensureDemoFields(orgId: string) {
  const existing = await getFields(orgId);
  let position = existing.length;
  for (const f of demoFields) {
    if (existing.some((e) => e.key === f.key)) continue;
    await db.insert(ticketFields).values({ id: id("fld"), orgId, ...f, position: position++ });
  }
}

/** Groups, rules and availability so the demo opens with routed, assigned tickets. */
async function ensureDemoRouting(orgId: string, team: { id: string; email: string }[]) {
  const byEmail = (e: string) => team.find((t) => t.email === e)!.id;
  const [sam, lena, jo, maya] = [DEMO_EMAIL, "lena@trace.dev", "jo@trace.dev", "maya@trace.dev"].map(byEmail);
  const group = async (name: string, description: string, members: string[]) => {
    const [g] = await db
      .insert(routingGroups)
      .values({ id: id("grp"), orgId, name, description })
      .returning();
    await db.insert(routingGroupMembers).values(members.map((userId) => ({ groupId: g!.id, userId, orgId })));
    return g!.id;
  };
  const billing = await group("Billing", "Invoices, charges, refunds, plans", [sam!, lena!]);
  const technical = await group("Technical", "API, auth, portal and bugs", [jo!, maya!, sam!]);
  const support = await group("Support", "Everyone, for everything else", [sam!, lena!, jo!, maya!]);
  await db.insert(routingRules).values([
    {
      id: id("rul"),
      orgId,
      position: 0,
      groupId: billing,
      conditions: { intents: ["billing_issue", "refund"], tags: ["billing"] },
    },
    {
      id: id("rul"),
      orgId,
      position: 1,
      groupId: technical,
      conditions: { intents: ["bug_report", "login_issue", "outage"], tags: ["api", "auth", "portal"] },
    },
  ]);
  await db
    .update(workspaceSettings)
    .set({ routing: { ...defaultRouting(), enabled: true, fallbackGroupId: support } })
    .where(eq(workspaceSettings.orgId, orgId));
  invalidateSettings(orgId);
  // Maya is away: routing skips her, which the demo's decision log shows.
  await db.insert(agentStatus).values({ orgId, userId: maya!, status: "away" }).onConflictDoNothing();
}

/**
 * The offline agent never asks for approvals or hands off, so the demo sets one of each up by hand —
 * enough for Home's "Needs you" to show every kind of row.
 */
async function demoStates(orgId: string, list: { id: string; subject: string }[]) {
  const settings = await ensureWorkspace(orgId);
  const charge = list.find((t) => t.subject.startsWith("Invoice #4821"));
  const [refund] = await db
    .select()
    .from(actions)
    .where(and(eq(actions.orgId, orgId), eq(actions.name, "refund_charge")));
  if (charge && refund) {
    const [t] = await db.select({ aiState: tickets.aiState }).from(tickets).where(eq(tickets.id, charge.id));
    if (t?.aiState !== "awaiting_approval") {
      await requestApproval({
        orgId,
        ticketId: charge.id,
        action: refund,
        input: {
          charge_id: "ch_3PqL5k",
          reason: "Duplicate of ch_3PqL2x — same invoice #4821, same amount, 4 minutes apart",
        },
        reason: "Duplicate of ch_3PqL2x — same invoice #4821, same amount, 4 minutes apart",
        traceId: "trc_seed",
        agentName: settings.ai.agentName,
      });
      await db.update(tickets).set({ aiState: "awaiting_approval" }).where(eq(tickets.id, charge.id));
    }
  }
  const sso = list.find((t) => t.subject.startsWith("SSO redirect"));
  if (sso) {
    await addMessage(orgId, sso.id, {
      kind: "note",
      authorType: "ai",
      authorName: settings.ai.agentName,
      body: "**Escalated:** staging-only redirect loop with the same Okta app — likely a callback URL mismatch on our side. Needs engineering; the customer is blocked on a release.",
      meta: { via: "ai" },
      skipAi: true,
    });
    await db.update(tickets).set({ aiState: "escalated", aiConfidence: 0 }).where(eq(tickets.id, sso.id));
    bus.publish({ type: "ai.state", orgId, ticketId: sso.id, state: "escalated" });
  }
}
