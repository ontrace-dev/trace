import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.ts";
import { integrations, ticketLinks } from "../db/schema.ts";
import { encrypt } from "../lib/crypto.ts";
import { badRequest, notFound } from "../lib/http.ts";
import { id } from "../lib/ids.ts";
import type { JiraConfig, LinearConfig } from "../lib/types.ts";
import {
  createIssue,
  draftIssue,
  getTracker,
  linkExisting,
  listTrackers,
  similarIssues,
  ticketIssueLinks,
} from "../services/issues/index.ts";
import { jiraBase, trackerFor } from "../services/issues/trackers.ts";
import { getTicket, getTicketByNumber } from "../services/tickets.ts";
import { type AppEnv, requireAdmin } from "./middleware.ts";

/** Linear & Jira: connect, configure, and file / link issues from tickets. Mounted at /api/w/:wid/issues */
export const issuesRoutes = new Hono<AppEnv>();

const actor = (c: { get: (k: "user") => { id: string; name: string } }) => ({
  id: c.get("user").id,
  name: c.get("user").name,
});
const fail = (err: unknown) => badRequest(err instanceof Error ? err.message : String(err));

/** Connected trackers with their teams / projects (fetched live; errors shown per tracker). */
issuesRoutes.get("/trackers", async (c) => {
  const rows = await listTrackers(c.get("orgId"));
  const out = await Promise.all(
    rows.map(async (r) => {
      const client = trackerFor(r.config);
      const containers = await client.containers().then(
        (x) => ({ ok: true as const, list: x }),
        (err: Error) => ({ ok: false as const, error: err.message }),
      );
      // Never send credentials to the browser.
      const safe = { ...r.config, apiKey: undefined, apiToken: undefined };
      return {
        id: r.id,
        provider: r.provider,
        name: r.name,
        status: containers.ok ? "connected" : "error",
        statusMessage: containers.ok ? null : containers.error,
        config: safe,
        containers: containers.ok ? containers.list : [],
      };
    }),
  );
  return c.json({ trackers: out });
});

issuesRoutes.post("/trackers/linear", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const { apiKey } = z.object({ apiKey: z.string().trim().min(10) }).parse(await c.req.json());
  const config: LinearConfig = { kind: "linear", apiKey: encrypt(apiKey) };
  const client = trackerFor(config);
  let name: string;
  let teams;
  try {
    name = (await client.verify()).name;
    teams = await client.containers();
  } catch (err) {
    throw fail(err);
  }
  config.workspace = name;
  config.defaultTeamId = teams[0]?.id;
  const [row] = await db
    .insert(integrations)
    .values({ id: id("int"), orgId, provider: "linear", name: `Linear · ${name}`, config, status: "connected" })
    .returning();
  return c.json({ id: row!.id, name: row!.name }, 201);
});

issuesRoutes.post("/trackers/jira", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const b = z
    .object({ site: z.string().trim().min(2), email: z.string().trim().email(), apiToken: z.string().trim().min(8) })
    .parse(await c.req.json());
  const config: JiraConfig = { kind: "jira", site: jiraBase(b.site), email: b.email, apiToken: encrypt(b.apiToken) };
  const client = trackerFor(config);
  let projects;
  try {
    await client.verify();
    projects = await client.containers();
  } catch (err) {
    throw fail(err);
  }
  config.defaultProjectKey = projects[0]?.key;
  const [row] = await db
    .insert(integrations)
    .values({
      id: id("int"),
      orgId,
      provider: "jira",
      name: `Jira · ${new URL(config.site).hostname}`,
      config,
      status: "connected",
    })
    .returning();
  return c.json({ id: row!.id, name: row!.name }, 201);
});

/** Default team/project and how classification values map to labels / issue types. */
issuesRoutes.patch("/trackers/:id", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const { row } = await getTracker(orgId, c.req.param("id")).catch(() => {
    throw notFound("Tracker not found");
  });
  const b = z
    .object({
      defaultContainer: z.string().nullable().optional(),
      typeMap: z.record(z.string(), z.string()).optional(),
    })
    .parse(await c.req.json());
  const config =
    row.config.kind === "linear"
      ? {
          ...row.config,
          ...(b.defaultContainer !== undefined ? { defaultTeamId: b.defaultContainer ?? undefined } : {}),
          ...(b.typeMap ? { typeLabels: b.typeMap } : {}),
        }
      : {
          ...row.config,
          ...(b.defaultContainer !== undefined ? { defaultProjectKey: b.defaultContainer ?? undefined } : {}),
          ...(b.typeMap ? { typeIssueTypes: b.typeMap } : {}),
        };
  await db.update(integrations).set({ config }).where(eq(integrations.id, row.id));
  return c.json({ ok: true });
});

/** Labels (Linear) or issue types (Jira) of a team/project — for the type mapping. */
issuesRoutes.get("/trackers/:id/kinds", async (c) => {
  const container = c.req.query("container");
  if (!container) throw badRequest("container is required");
  const { client } = await getTracker(c.get("orgId"), c.req.param("id"));
  try {
    return c.json({ kinds: await client.kinds(container) });
  } catch (err) {
    throw fail(err);
  }
});

// ---------------------------------------------------------------- per ticket

async function ticketOf(orgId: string, ref: string) {
  const t = /^\d+$/.test(ref) ? await getTicketByNumber(orgId, Number(ref)) : await getTicket(orgId, ref);
  if (!t) throw notFound("Ticket not found");
  return t;
}

const includeSchema = z
  .object({ link: z.boolean(), trace: z.boolean(), fields: z.boolean(), customerEmail: z.boolean() })
  .default({ link: true, trace: true, fields: true, customerEmail: false });

issuesRoutes.post("/tickets/:ref/draft", async (c) => {
  const orgId = c.get("orgId");
  const t = await ticketOf(orgId, c.req.param("ref"));
  const b = z.object({ type: z.string().nullable().default(null), include: includeSchema }).parse(await c.req.json());
  try {
    return c.json(await draftIssue(orgId, t.id, b));
  } catch (err) {
    throw fail(err);
  }
});

issuesRoutes.get("/tickets/:ref/similar", async (c) => {
  const orgId = c.get("orgId");
  await ticketOf(orgId, c.req.param("ref"));
  const integrationId = c.req.query("integration");
  const text = c.req.query("q") ?? "";
  if (!integrationId || text.trim().length < 4) return c.json({ issues: [] });
  return c.json({ issues: await similarIssues(orgId, integrationId, text, c.req.query("container")) });
});

issuesRoutes.get("/tickets/:ref/links", async (c) => {
  const orgId = c.get("orgId");
  const t = await ticketOf(orgId, c.req.param("ref"));
  return c.json({ links: await ticketIssueLinks(orgId, t.id) });
});

issuesRoutes.post("/tickets/:ref/links", async (c) => {
  const orgId = c.get("orgId");
  const t = await ticketOf(orgId, c.req.param("ref"));
  const b = z
    .object({
      integrationId: z.string(),
      container: z.string().min(1),
      type: z.string().nullable().default(null),
      title: z.string().trim().min(3).max(250),
      description: z.string().max(20_000).default(""),
      link: z.boolean().default(true),
    })
    .parse(await c.req.json());
  try {
    return c.json(await createIssue(orgId, t.id, b, actor(c)), 201);
  } catch (err) {
    throw fail(err);
  }
});

issuesRoutes.post("/tickets/:ref/links/existing", async (c) => {
  const orgId = c.get("orgId");
  const t = await ticketOf(orgId, c.req.param("ref"));
  const b = z.object({ integrationId: z.string(), key: z.string().min(2) }).parse(await c.req.json());
  try {
    return c.json(await linkExisting(orgId, t.id, b.integrationId, b.key, actor(c)), 201);
  } catch (err) {
    throw fail(err);
  }
});

issuesRoutes.delete("/tickets/:ref/links/:linkId", async (c) => {
  const orgId = c.get("orgId");
  const t = await ticketOf(orgId, c.req.param("ref"));
  await db
    .delete(ticketLinks)
    .where(
      and(eq(ticketLinks.orgId, orgId), eq(ticketLinks.ticketId, t.id), eq(ticketLinks.id, c.req.param("linkId"))),
    );
  return c.json({ ok: true });
});
