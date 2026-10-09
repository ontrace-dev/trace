import { and, count, desc, eq, ilike, isNotNull, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.ts";
import { knowledgeChunks, knowledgeDocuments, knowledgeSources } from "../db/schema.ts";
import { encrypt } from "../lib/crypto.ts";
import { badRequest, notFound } from "../lib/http.ts";
import { id } from "../lib/ids.ts";
import type { KnowledgeSourceConfig } from "../lib/types.ts";
import { ConnectorError, runConnector } from "../services/knowledge/connectors/index.ts";
import { parseFile } from "../services/knowledge/connectors/files.ts";
import { embeddingStatus } from "../services/knowledge/embeddings.ts";
import { deleteDocument, upsertDocument } from "../services/knowledge/indexer.ts";
import { searchKnowledge } from "../services/knowledge/search.ts";
import { isSyncing, type KnowledgeSource, syncSource } from "../services/knowledge/sync.ts";
import { type AppEnv, requireAdmin } from "./middleware.ts";

/** Knowledge sources (connectors, sync, documents, retrieval playground). Mounted at /api/w/:wid/knowledge */
export const knowledgeRoutes = new Hono<AppEnv>();

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL");
const list = z.array(z.string().trim().min(1)).default([]);

const configSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("website"),
    url: httpUrl,
    maxPages: z.coerce.number().int().min(1).max(500).default(50),
    include: list.optional(),
    exclude: list.optional(),
  }),
  z.object({
    type: z.literal("confluence"),
    baseUrl: httpUrl,
    email: z.string().trim().default(""),
    spaceKeys: list,
    cql: z.string().trim().optional(),
  }),
  z.object({
    type: z.literal("jira"),
    baseUrl: httpUrl,
    email: z.string().trim().default(""),
    jql: z.string().trim().default("updated >= -180d ORDER BY updated DESC"),
    maxIssues: z.coerce.number().int().min(1).max(5000).default(300),
    includeComments: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("notion"),
    query: z.string().trim().optional(),
    maxPages: z.coerce.number().int().min(1).max(2000).default(200),
  }),
  z.object({
    type: z.literal("zendesk"),
    subdomain: z.string().trim().min(1),
    locale: z.string().trim().optional(),
    email: z.string().trim().optional(),
  }),
  z.object({ type: z.literal("files") }),
]);

const needsSecret = new Set(["confluence", "jira", "notion"]);
const defaultVisibility = (type: string) => (type === "jira" ? "internal" : "public");

function serialize(s: KnowledgeSource) {
  const { secret, ...rest } = s;
  return { ...rest, hasSecret: !!secret, syncing: isSyncing(s.id) || s.status === "syncing" };
}

async function getSource(orgId: string, sourceId: string) {
  const [s] = await db
    .select()
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.orgId, orgId), eq(knowledgeSources.id, sourceId)));
  if (!s) throw notFound("Source not found");
  return s;
}

/** Pull a few documents without saving anything — validates URL and credentials. */
async function probe(config: KnowledgeSourceConfig, encryptedSecret: string | null) {
  if (config.type === "files") return { ok: true as const, samples: [] as { title: string; url: string | null }[] };
  const samples: { title: string; url: string | null }[] = [];
  try {
    const run = runConnector(config, encryptedSecret, { max: 3 });
    const deadline = Date.now() + 25_000;
    for await (const doc of run) {
      samples.push({ title: doc.title, url: doc.url ?? null });
      if (samples.length >= 3 || Date.now() > deadline) break;
    }
    if (!samples.length)
      return { ok: false as const, error: "Connected, but no documents were found with these settings." };
    return { ok: true as const, samples };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof ConnectorError || err instanceof Error ? err.message : String(err),
    };
  }
}

knowledgeRoutes.get("/status", async (c) => {
  const orgId = c.get("orgId");
  const rows = await db
    .select({
      origin: sql<string>`case when ${knowledgeDocuments.articleId} is not null then 'article' else coalesce(${knowledgeSources.type}, 'document') end`,
      documents: count(),
    })
    .from(knowledgeDocuments)
    .leftJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeDocuments.sourceId))
    .where(eq(knowledgeDocuments.orgId, orgId))
    .groupBy(sql`1`);
  const [chunks] = await db
    .select({ total: count(), embedded: sql<number>`count(${knowledgeChunks.embedding})`.mapWith(Number) })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.orgId, orgId));
  return c.json({
    embeddings: embeddingStatus(),
    byOrigin: rows,
    chunks: { total: chunks?.total ?? 0, embedded: chunks?.embedded ?? 0 },
  });
});

knowledgeRoutes.get("/sources", async (c) => {
  const rows = await db
    .select()
    .from(knowledgeSources)
    .where(eq(knowledgeSources.orgId, c.get("orgId")))
    .orderBy(desc(knowledgeSources.createdAt));
  return c.json({ sources: rows.map(serialize) });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  visibility: z.enum(["public", "internal"]).optional(),
  config: configSchema,
  secret: z.string().optional(),
  syncIntervalMinutes: z.coerce.number().int().min(15).max(10_080).optional(),
});

knowledgeRoutes.post("/sources", requireAdmin, async (c) => {
  const b = createSchema.parse(await c.req.json());
  const type = b.config.type;
  if (needsSecret.has(type) && !b.secret?.trim()) throw badRequest("An API token is required for this source");
  const [row] = await db
    .insert(knowledgeSources)
    .values({
      id: id("src"),
      orgId: c.get("orgId"),
      type,
      name: b.name,
      visibility: b.visibility ?? defaultVisibility(type),
      config: b.config as KnowledgeSourceConfig,
      secret: b.secret?.trim() ? encrypt(b.secret.trim()) : null,
      syncIntervalMinutes: b.syncIntervalMinutes ?? 360,
      status: type === "files" ? "ready" : "idle",
    })
    .returning();
  if (type !== "files") syncSource(row!.id);
  return c.json({ source: serialize(row!) });
});

/** Test settings before saving (or an existing source when :id is given and no new secret is sent). */
knowledgeRoutes.post("/test", requireAdmin, async (c) => {
  const b = z
    .object({ config: configSchema, secret: z.string().optional(), sourceId: z.string().optional() })
    .parse(await c.req.json());
  let secret = b.secret?.trim() ? encrypt(b.secret.trim()) : null;
  if (!secret && b.sourceId) secret = (await getSource(c.get("orgId"), b.sourceId)).secret;
  if (needsSecret.has(b.config.type) && !secret) return c.json({ ok: false, error: "An API token is required" });
  return c.json(await probe(b.config as KnowledgeSourceConfig, secret));
});

knowledgeRoutes.post("/sources/:id/test", requireAdmin, async (c) => {
  const s = await getSource(c.get("orgId"), c.req.param("id"));
  return c.json(await probe(s.config, s.secret));
});

knowledgeRoutes.patch("/sources/:id", requireAdmin, async (c) => {
  const orgId = c.get("orgId");
  const cur = await getSource(orgId, c.req.param("id"));
  const b = z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      visibility: z.enum(["public", "internal"]).optional(),
      enabled: z.boolean().optional(),
      config: configSchema.optional(),
      secret: z.string().optional(),
      syncIntervalMinutes: z.coerce.number().int().min(15).max(10_080).optional(),
    })
    .parse(await c.req.json());
  if (b.config && b.config.type !== cur.type) throw badRequest("The source type can't be changed");
  const [row] = await db
    .update(knowledgeSources)
    .set({
      name: b.name,
      visibility: b.visibility,
      enabled: b.enabled,
      config: b.config as KnowledgeSourceConfig | undefined,
      secret: b.secret?.trim() ? encrypt(b.secret.trim()) : undefined,
      syncIntervalMinutes: b.syncIntervalMinutes,
    })
    .where(eq(knowledgeSources.id, cur.id))
    .returning();
  // Visibility applies to already-synced documents immediately (re-sync not required).
  if (b.visibility && b.visibility !== cur.visibility) {
    await db
      .update(knowledgeDocuments)
      .set({ visibility: b.visibility })
      .where(eq(knowledgeDocuments.sourceId, cur.id));
  }
  const configChanged = (b.config && JSON.stringify(b.config) !== JSON.stringify(cur.config)) || !!b.secret?.trim();
  if (row!.enabled && row!.type !== "files" && (configChanged || (b.enabled && !cur.enabled))) syncSource(row!.id);
  return c.json({ source: serialize(row!) });
});

knowledgeRoutes.delete("/sources/:id", requireAdmin, async (c) => {
  const s = await getSource(c.get("orgId"), c.req.param("id"));
  // Documents and chunks cascade.
  await db.delete(knowledgeSources).where(eq(knowledgeSources.id, s.id));
  return c.json({ ok: true });
});

knowledgeRoutes.post("/sources/:id/sync", requireAdmin, async (c) => {
  const s = await getSource(c.get("orgId"), c.req.param("id"));
  if (s.type === "files") throw badRequest("File sources are updated by uploading");
  if (!s.enabled) throw badRequest("Enable the source first");
  const queued = syncSource(s.id);
  if (queued)
    await db
      .update(knowledgeSources)
      .set({ status: "syncing", statusMessage: null })
      .where(eq(knowledgeSources.id, s.id));
  return c.json({ ok: true, alreadyRunning: !queued });
});

knowledgeRoutes.get("/sources/:id/documents", async (c) => {
  const s = await getSource(c.get("orgId"), c.req.param("id"));
  const q = c.req.query("q")?.trim();
  const cursor = c.req.query("cursor");
  const rows = await db
    .select({
      id: knowledgeDocuments.id,
      title: knowledgeDocuments.title,
      url: knowledgeDocuments.url,
      visibility: knowledgeDocuments.visibility,
      metadata: knowledgeDocuments.metadata,
      externalUpdatedAt: knowledgeDocuments.externalUpdatedAt,
      updatedAt: knowledgeDocuments.updatedAt,
      indexedAt: knowledgeDocuments.indexedAt,
      chars: sql<number>`length(${knowledgeDocuments.content})`.mapWith(Number),
      // Fully qualified: drizzle drops table prefixes on single-table selects, which breaks correlation.
      chunks:
        sql<number>`(select count(*) from "knowledge_chunks" kc where kc."document_id" = "knowledge_documents"."id")`.mapWith(
          Number,
        ),
    })
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.sourceId, s.id),
        q ? or(ilike(knowledgeDocuments.title, `%${q}%`), ilike(knowledgeDocuments.url, `%${q}%`)) : undefined,
        cursor ? lt(knowledgeDocuments.updatedAt, new Date(cursor)) : undefined,
      ),
    )
    .orderBy(desc(knowledgeDocuments.updatedAt))
    .limit(51);
  const page = rows.slice(0, 50);
  return c.json({
    documents: page,
    nextCursor: rows.length > 50 ? page.at(-1)!.updatedAt.toISOString() : null,
  });
});

knowledgeRoutes.get("/documents/:id", async (c) => {
  const [d] = await db
    .select()
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.orgId, c.get("orgId")), eq(knowledgeDocuments.id, c.req.param("id"))));
  if (!d) throw notFound("Document not found");
  return c.json({ document: d });
});

knowledgeRoutes.delete("/documents/:id", requireAdmin, async (c) => {
  const [d] = await db
    .select({
      id: knowledgeDocuments.id,
      sourceId: knowledgeDocuments.sourceId,
      articleId: knowledgeDocuments.articleId,
    })
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.orgId, c.get("orgId")), eq(knowledgeDocuments.id, c.req.param("id"))));
  if (!d) throw notFound("Document not found");
  if (d.articleId) throw badRequest("Unpublish or delete the article instead");
  await deleteDocument(d.id);
  if (d.sourceId) {
    const [r] = await db
      .select({ n: count() })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.sourceId, d.sourceId));
    await db
      .update(knowledgeSources)
      .set({ documentCount: r?.n ?? 0 })
      .where(eq(knowledgeSources.id, d.sourceId));
  }
  return c.json({ ok: true });
});

knowledgeRoutes.post("/sources/:id/files", requireAdmin, async (c) => {
  const s = await getSource(c.get("orgId"), c.req.param("id"));
  if (s.type !== "files") throw badRequest("Uploads are only for file sources");
  const form = await c.req.formData();
  const results: { name: string; ok: boolean; title?: string; error?: string }[] = [];
  for (const [, value] of form.entries()) {
    if (typeof value === "string") continue;
    const file = value as File;
    try {
      const doc = await parseFile(file.name, new Uint8Array(await file.arrayBuffer()));
      await upsertDocument({
        orgId: s.orgId,
        sourceId: s.id,
        externalId: doc.externalId,
        title: doc.title,
        url: null,
        content: doc.content,
        visibility: s.visibility,
        metadata: doc.metadata ?? {},
        externalUpdatedAt: new Date(),
      });
      results.push({ name: file.name, ok: true, title: doc.title });
    } catch (err) {
      results.push({ name: file.name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!results.length) throw badRequest("No files received");
  const [r] = await db.select({ n: count() }).from(knowledgeDocuments).where(eq(knowledgeDocuments.sourceId, s.id));
  const ok = results.filter((x) => x.ok).length;
  await db
    .update(knowledgeSources)
    .set({
      documentCount: r?.n ?? 0,
      lastSyncedAt: new Date(),
      status: "ready",
      statusMessage: `${ok} of ${results.length} file${results.length === 1 ? "" : "s"} indexed`,
    })
    .where(eq(knowledgeSources.id, s.id));
  return c.json({ results });
});

/** Retrieval playground: exactly what the agent's search_knowledge_base tool sees. */
knowledgeRoutes.get("/search", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  if (!q) return c.json({ hits: [] });
  const includeInternal = c.req.query("internal") !== "false";
  const t0 = performance.now();
  const hits = await searchKnowledge(c.get("orgId"), q, { limit: 10, includeInternal });
  return c.json({ hits, tookMs: Math.round(performance.now() - t0) });
});

/** Documents with no embeddings yet (e.g. model still downloading) — shown as a hint in the UI. */
knowledgeRoutes.get("/pending", async (c) => {
  const [r] = await db
    .select({ n: count() })
    .from(knowledgeChunks)
    .where(and(eq(knowledgeChunks.orgId, c.get("orgId")), sql`${knowledgeChunks.embedding} is null`));
  const [d] = await db
    .select({ n: count() })
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.orgId, c.get("orgId")), isNotNull(knowledgeDocuments.indexedAt)));
  return c.json({ unembeddedChunks: r?.n ?? 0, indexedDocuments: d?.n ?? 0 });
});
