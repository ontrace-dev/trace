import { and, desc, eq, gte, inArray, notInArray, or, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { integrations, organization, spans, ticketLinks, tickets } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { bus } from "../../lib/bus.ts";
import { id } from "../../lib/ids.ts";
import { truncate } from "../../lib/text.ts";
import type { JiraConfig, LinearConfig } from "../../lib/types.ts";
import { loadContext } from "../ai/agent.ts";
import { callClaude, getClaude, textOf } from "../ai/client.ts";
import { ticketFieldValues } from "../fields.ts";
import { addMessage, getTicket } from "../tickets.ts";
import { Trace } from "../tracer.ts";
import { getSettings } from "../workspace.ts";
import { type Issue, trackerFor } from "./trackers.ts";

export type TrackerRow = typeof integrations.$inferSelect & { config: LinearConfig | JiraConfig };
export type TicketLink = typeof ticketLinks.$inferSelect;

const PROVIDER_NAME = { linear: "Linear", jira: "Jira" } as const;

export async function getTracker(orgId: string, integrationId: string) {
  const [row] = await db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.orgId, orgId),
        eq(integrations.id, integrationId),
        inArray(integrations.provider, ["linear", "jira"]),
      ),
    );
  if (!row) throw new Error("Issue tracker not found");
  const t = row as TrackerRow;
  return { row: t, client: trackerFor(t.config) };
}

export async function listTrackers(orgId: string) {
  const rows = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.orgId, orgId), inArray(integrations.provider, ["linear", "jira"])));
  return rows as TrackerRow[];
}

async function ticketUrl(orgId: string, number: number) {
  const [org] = await db.select({ slug: organization.slug }).from(organization).where(eq(organization.id, orgId));
  return `${env.APP_URL}/w/${org?.slug ?? ""}/inbox/all/${number}`;
}

// ---------------------------------------------------------------- draft

export interface DraftOptions {
  type: string | null;
  include: { link: boolean; trace: boolean; fields: boolean; customerEmail: boolean };
}

/** What trace found while working the ticket — tool calls, actions and integrations, not the reply itself. */
async function traceHighlights(ticketId: string) {
  const rows = await db
    .select({ name: spans.name, summary: spans.summary, kind: spans.kind, traceId: spans.traceId })
    .from(spans)
    .where(and(eq(spans.ticketId, ticketId), inArray(spans.kind, ["tool", "integration"])))
    .orderBy(desc(spans.startedAt))
    .limit(12);
  const lastTrace = (
    await db
      .select({ traceId: spans.traceId })
      .from(spans)
      .where(eq(spans.ticketId, ticketId))
      .orderBy(desc(spans.startedAt))
      .limit(1)
  )[0]?.traceId;
  return {
    traceId: lastTrace ?? null,
    lines: rows
      .reverse()
      .filter((r) => r.summary && !r.name.startsWith("route.") && !r.name.startsWith("notify."))
      .map((r) => `${r.name}: ${truncate(r.summary!, 140)}`),
  };
}

export async function draftIssue(orgId: string, ticketId: string, opts: DraftOptions) {
  const ctx = await loadContext(orgId, ticketId);
  if (!ctx) throw new Error("ticket not found");
  const settings = await getSettings(orgId);
  const fields = (await ticketFieldValues(orgId, ctx.ticket)).filter((f) => f.value != null && f.key !== "type");
  const highlights = await traceHighlights(ticketId);
  const url = await ticketUrl(orgId, ctx.ticket.number);
  const ref = `${settings.ticketPrefix}-${ctx.ticket.number}`;
  const feature = opts.type === "feature request";

  const context: string[] = [];
  if (opts.include.fields && fields.length)
    context.push(
      fields.map((f) => `${f.key} ${Array.isArray(f.value) ? f.value.join(", ") : String(f.value)}`).join(" · "),
    );
  const plan = ctx.customer?.attributes?.plan;
  const who = [
    ctx.customer?.company,
    typeof plan === "string" ? `${plan} plan` : null,
    opts.include.customerEmail ? ctx.customer?.email : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (who) context.push(`Customer: ${who}`);
  if (opts.include.link)
    context.push(
      `Ticket ${ref}${highlights.traceId && opts.include.trace ? ` · trace ${highlights.traceId}` : ""} · ${url}`,
    );

  const firstCustomer = ctx.history.find((m) => m.authorType === "customer" && m.kind === "message")?.body ?? "";
  const claude = getClaude(ctx.ai);
  if (claude) {
    const convo = ctx.history
      .filter((m) => m.kind !== "event")
      .slice(-12)
      .map(
        (m) =>
          `${m.authorType === "customer" ? "Customer" : m.kind === "note" ? "Internal note" : "Support"}: ${truncate(m.body, 1200)}`,
      )
      .join("\n\n");
    const res = await callClaude(claude, {
      max_tokens: 3000,
      system: `You write ${feature ? "feature requests" : "bug reports"} for an engineering issue tracker from support conversations. Be concrete and short. Never include customer names, emails or other personal data unless they appear in the CONTEXT block. Output exactly:
TITLE: <one line, under 90 characters, describes the problem not the customer>
---
<markdown body>
${feature ? "Body sections: ## Request, ## Why it matters (customer impact), ## Context." : "Body sections: ## What the customer saw, ## Steps to reproduce (numbered; only what the conversation supports — write 'Unknown' if it doesn't), ## Expected / actual, ## What support found (only if there are findings), ## Context."}
Copy the CONTEXT lines verbatim into ## Context.`,
      messages: [
        {
          role: "user",
          content: `Ticket "${ctx.ticket.subject}"\n\nCONVERSATION\n${convo}\n\n${opts.include.trace && highlights.lines.length ? `WHAT SUPPORT/AI FOUND\n${highlights.lines.join("\n")}\n\n` : ""}CONTEXT\n${context.join("\n") || "(none)"}`,
        },
      ],
    });
    const out = textOf(res);
    const m = out.match(/^\s*TITLE:\s*(.+?)\s*\n-{3,}\s*\n([\s\S]*)$/);
    if (m) return { title: truncate(m[1]!, 120), description: m[2]!.trim(), offline: false };
  }
  // Offline: a structured template from what we know.
  const body = truncate(firstCustomer.replace(/\n{3,}/g, "\n\n").trim(), 900);
  const sections = feature
    ? [`## Request\n${body}`, `## Why it matters\n${ctx.ticket.aiSummary ?? "Requested by a customer in support."}`]
    : [
        `## What the customer saw\n${body}`,
        "## Steps to reproduce\n1. Unknown — see the ticket",
        "## Expected / actual\nUnknown",
        ...(opts.include.trace && highlights.lines.length
          ? [`## What support found\n${highlights.lines.map((l) => `- ${l}`).join("\n")}`]
          : []),
      ];
  if (context.length) sections.push(`## Context\n${context.join("\n")}`);
  return { title: truncate(ctx.ticket.subject, 120), description: sections.join("\n\n"), offline: true };
}

// ---------------------------------------------------------------- links

/** Issues linked to a ticket, with how many tickets share each issue. */
export async function ticketIssueLinks(orgId: string, ticketId: string) {
  const rows = await db
    .select()
    .from(ticketLinks)
    .where(and(eq(ticketLinks.orgId, orgId), eq(ticketLinks.ticketId, ticketId)));
  if (!rows.length) return [];
  const counts = await db
    .select({ provider: ticketLinks.provider, key: ticketLinks.key, n: sql<number>`count(*)`.mapWith(Number) })
    .from(ticketLinks)
    .where(
      and(
        eq(ticketLinks.orgId, orgId),
        inArray(
          ticketLinks.key,
          rows.map((r) => r.key),
        ),
      ),
    )
    .groupBy(ticketLinks.provider, ticketLinks.key);
  return rows.map((r) => ({ ...r, tickets: counts.find((c) => c.provider === r.provider && c.key === r.key)?.n ?? 1 }));
}

async function saveLink(
  orgId: string,
  ticketId: string,
  tracker: TrackerRow,
  issue: Issue,
  createdByTrace: boolean,
  actor: { id?: string | null; name?: string | null },
) {
  const [link] = await db
    .insert(ticketLinks)
    .values({
      id: id("lnk"),
      orgId,
      ticketId,
      provider: tracker.provider as "linear" | "jira",
      integrationId: tracker.id,
      externalId: issue.externalId,
      key: issue.key,
      url: issue.url,
      title: issue.title,
      status: issue.status,
      statusCategory: issue.statusCategory,
      createdByTrace,
      createdBy: actor.id ?? null,
      syncedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  bus.publish({ type: "ticket.updated", orgId, ticketId, changes: ["links"], actorId: actor.id ?? undefined });
  return link;
}

export async function createIssue(
  orgId: string,
  ticketId: string,
  input: {
    integrationId: string;
    container: string;
    type: string | null;
    title: string;
    description: string;
    link: boolean;
  },
  actor: { id?: string | null; name?: string | null },
) {
  const ticket = await getTicket(orgId, ticketId);
  if (!ticket) throw new Error("ticket not found");
  const { row, client } = await getTracker(orgId, input.integrationId);
  const trace = new Trace(orgId, ticketId);
  const span = trace.start("issue.create", "integration");
  let issue: Issue;
  try {
    issue = await client.create({
      container: input.container,
      title: input.title,
      description: input.description,
      type: input.type,
    });
  } catch (err) {
    await span.end({ status: "error", summary: (err as Error).message });
    throw err;
  }
  const settings = await getSettings(orgId);
  if (input.link)
    await client.linkBack(
      issue,
      await ticketUrl(orgId, ticket.number),
      `${settings.ticketPrefix}-${ticket.number} · ${ticket.subject}`,
    );
  const name = PROVIDER_NAME[row.provider as "linear" | "jira"];
  await span.end({
    summary: `${name} ${issue.key} · ${input.type ?? "issue"} · ${issue.status || "created"}`,
    attributes: { provider: row.provider, key: issue.key, url: issue.url, by: actor.name },
  });
  const link = await saveLink(orgId, ticketId, row, issue, true, actor);
  await addMessage(orgId, ticketId, {
    kind: "note",
    authorType: "agent",
    authorId: actor.id ?? null,
    authorName: actor.name ?? null,
    body: `Filed **${issue.key}** in ${name}: [${issue.title}](${issue.url})`,
    meta: { via: "web" },
  });
  return { link, issue };
}

export async function linkExisting(
  orgId: string,
  ticketId: string,
  integrationId: string,
  keyOrUrl: string,
  actor: { id?: string | null; name?: string | null },
) {
  const { row, client } = await getTracker(orgId, integrationId);
  // Accept "ENG-482", a Linear URL (…/issue/ENG-482/…) or a Jira URL (…/browse/SUP-219).
  const key = keyOrUrl
    .trim()
    .match(/([A-Za-z][A-Za-z0-9]*-\d+)/)?.[1]
    ?.toUpperCase();
  if (!key) throw new Error("Paste an issue key like ENG-482 or a link to the issue");
  const issue = await client.get(key);
  const link = await saveLink(orgId, ticketId, row, issue, false, actor);
  if (!link) throw new Error(`${issue.key} is already linked`);
  const name = PROVIDER_NAME[row.provider as "linear" | "jira"];
  await new Trace(orgId, ticketId).event("issue.link", "integration", `${name} ${issue.key} · ${issue.status}`, {
    key: issue.key,
    by: actor.name,
  });
  await addMessage(orgId, ticketId, {
    kind: "note",
    authorType: "agent",
    authorId: actor.id ?? null,
    authorName: actor.name ?? null,
    body: `Linked **${issue.key}** in ${name}: [${issue.title}](${issue.url}) · ${issue.status}`,
    meta: { via: "web" },
  });
  return { link, issue };
}

/** Issues in the tracker that look like this ticket — offered as "link instead". */
export async function similarIssues(orgId: string, integrationId: string, text: string, container?: string) {
  const { client, row } = await getTracker(orgId, integrationId);
  const found = await client.search(text, row.provider === "jira" ? container : undefined).catch(() => []);
  if (!found.length) return [];
  const counts = await db
    .select({ key: ticketLinks.key, n: sql<number>`count(*)`.mapWith(Number) })
    .from(ticketLinks)
    .where(
      and(
        eq(ticketLinks.orgId, orgId),
        inArray(
          ticketLinks.key,
          found.map((i) => i.key),
        ),
      ),
    )
    .groupBy(ticketLinks.key);
  return found.map((i) => ({ ...i, tickets: counts.find((c) => c.key === i.key)?.n ?? 0 }));
}

// ---------------------------------------------------------------- status sync

const CATEGORY_WORD = { todo: "to do", started: "in progress", done: "done", canceled: "canceled" } as const;

/** Poll linked issues for status changes and leave a note on every ticket that shares the issue. */
export async function syncIssues() {
  const stale = await db
    .select({ link: ticketLinks, ticketStatus: tickets.status })
    .from(ticketLinks)
    .innerJoin(tickets, eq(tickets.id, ticketLinks.ticketId))
    .where(
      and(
        gte(tickets.updatedAt, new Date(Date.now() - 120 * 86_400_000)),
        or(
          notInArray(ticketLinks.statusCategory, ["done", "canceled"]),
          sql`${ticketLinks.syncedAt} < now() - interval '6 hours'`,
        ),
      ),
    )
    .limit(200);
  const byIssue = new Map<string, typeof stale>();
  for (const s of stale) {
    if (!s.link.integrationId) continue;
    const k = `${s.link.integrationId}:${s.link.key}`;
    byIssue.set(k, [...(byIssue.get(k) ?? []), s]);
  }
  for (const group of byIssue.values()) {
    const first = group[0]!.link;
    try {
      const { client, row } = await getTracker(first.orgId, first.integrationId!);
      const issue = await client.get(first.key);
      const changed = issue.status !== first.status;
      await db
        .update(ticketLinks)
        .set({ status: issue.status, statusCategory: issue.statusCategory, title: issue.title, syncedAt: new Date() })
        .where(
          and(
            eq(ticketLinks.orgId, first.orgId),
            eq(ticketLinks.key, first.key),
            eq(ticketLinks.provider, first.provider),
          ),
        );
      if (!changed) continue;
      const name = PROVIDER_NAME[row.provider as "linear" | "jira"];
      for (const { link, ticketStatus } of group) {
        const tell =
          issue.statusCategory === "done" && ticketStatus !== "closed" ? " — you can let the customer know." : "";
        await addMessage(link.orgId, link.ticketId, {
          kind: "note",
          authorType: "system",
          authorName: name,
          body: `**${issue.key}** moved to ${issue.status || CATEGORY_WORD[issue.statusCategory]} in ${name}${tell}`,
          meta: { via: "api" },
        });
        await new Trace(link.orgId, link.ticketId).event(
          "issue.status",
          "integration",
          `${name} ${issue.key} → ${issue.status}`,
          {
            key: issue.key,
            from: link.status,
            to: issue.status,
          },
        );
      }
    } catch (err) {
      console.error("[issues] sync", first.key, (err as Error).message);
    }
  }
}

export function startIssueSync() {
  setInterval(() => syncIssues().catch((err) => console.error("[issues] sync", err)), 5 * 60_000).unref();
}
