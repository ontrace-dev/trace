import { and, count, eq, ne } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { knowledgeDocuments, knowledgeSources } from "../../db/schema.ts";
import { ConnectorError, runConnector } from "./connectors/index.ts";
import { removeStaleDocuments, upsertDocument } from "./indexer.ts";

export type KnowledgeSource = typeof knowledgeSources.$inferSelect;

const MAX_CONCURRENT_SYNCS = 2;
const TICK_MS = 5 * 60_000;

const active = new Set<string>();
const waiting: string[] = [];
let running = 0;

function errorMessage(err: unknown) {
  if (err instanceof ConnectorError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

async function refreshCount(sourceId: string) {
  const [r] = await db.select({ n: count() }).from(knowledgeDocuments).where(eq(knowledgeDocuments.sourceId, sourceId));
  return r?.n ?? 0;
}

/**
 * Pull every document from the source's connector, upsert + index them (unchanged ones are skipped by
 * content hash), then drop documents that disappeared upstream. Per-document failures are counted, not fatal.
 */
async function runSync(sourceId: string) {
  const [source] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, sourceId));
  if (!source || !source.enabled || source.type === "files") return;
  await db
    .update(knowledgeSources)
    .set({ status: "syncing", statusMessage: null })
    .where(eq(knowledgeSources.id, sourceId));
  const seen: string[] = [];
  let changed = 0;
  let failed = 0;
  let firstDocError: string | null = null;
  try {
    for await (const doc of runConnector(source.config, source.secret)) {
      seen.push(doc.externalId);
      try {
        const r = await upsertDocument({
          orgId: source.orgId,
          sourceId: source.id,
          externalId: doc.externalId,
          title: doc.title,
          url: doc.url ?? null,
          content: doc.content,
          visibility: source.visibility,
          metadata: doc.metadata ?? {},
          externalUpdatedAt: doc.updatedAt ?? null,
        });
        if (r.changed) changed++;
      } catch (err) {
        failed++;
        firstDocError ??= `${doc.title}: ${errorMessage(err)}`;
      }
    }
    const removed = seen.length ? await removeStaleDocuments(source.id, seen) : 0;
    const documentCount = await refreshCount(source.id);
    const parts = [`${seen.length} found`, `${changed} updated`];
    if (removed) parts.push(`${removed} removed`);
    if (failed) parts.push(`${failed} failed (${firstDocError})`);
    await db
      .update(knowledgeSources)
      .set({
        status: seen.length ? "ready" : "error",
        statusMessage: seen.length ? parts.join(" · ") : "The source returned no documents",
        documentCount,
        lastSyncedAt: new Date(),
      })
      .where(eq(knowledgeSources.id, sourceId));
    console.log(`[knowledge] synced ${source.type} "${source.name}": ${parts.join(", ")}`);
  } catch (err) {
    // Keep already-indexed documents when the upstream is temporarily unreachable.
    await db
      .update(knowledgeSources)
      .set({
        status: "error",
        statusMessage: errorMessage(err),
        documentCount: await refreshCount(source.id),
        lastSyncedAt: new Date(),
      })
      .where(eq(knowledgeSources.id, sourceId));
    console.warn(`[knowledge] sync failed for "${source.name}":`, errorMessage(err));
  }
}

function pump() {
  while (running < MAX_CONCURRENT_SYNCS && waiting.length) {
    const sourceId = waiting.shift()!;
    running++;
    runSync(sourceId)
      .catch((err) => console.error("[knowledge] sync crashed", err))
      .finally(() => {
        running--;
        active.delete(sourceId);
        pump();
      });
  }
}

/** Queue a sync. A source never syncs twice concurrently; returns false if it's already queued/running. */
export function syncSource(sourceId: string) {
  if (active.has(sourceId)) return false;
  active.add(sourceId);
  waiting.push(sourceId);
  pump();
  return true;
}

export function isSyncing(sourceId: string) {
  return active.has(sourceId);
}

async function tick() {
  const sources = await db
    .select({
      id: knowledgeSources.id,
      lastSyncedAt: knowledgeSources.lastSyncedAt,
      interval: knowledgeSources.syncIntervalMinutes,
      status: knowledgeSources.status,
    })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.enabled, true), ne(knowledgeSources.type, "files")));
  const now = Date.now();
  for (const s of sources) {
    const due =
      !s.lastSyncedAt ||
      s.status === "syncing" || // interrupted by a restart
      now - s.lastSyncedAt.getTime() >= Math.max(s.interval, 15) * 60_000;
    if (due) syncSource(s.id);
  }
}

/** Periodic background sync; also resumes syncs interrupted by a restart. */
export function startKnowledgeSync() {
  setTimeout(() => tick().catch((err) => console.error("[knowledge] scheduler", err)), 15_000);
  setInterval(() => tick().catch((err) => console.error("[knowledge] scheduler", err)), TICK_MS).unref();
}
