import { and, eq, isNull, notInArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../../db/index.ts";
import { articles, knowledgeChunks, knowledgeDocuments, type KnowledgeVisibility } from "../../db/schema.ts";
import { id } from "../../lib/ids.ts";
import { embed } from "./embeddings.ts";

/**
 * Everything the agent can retrieve is a knowledge document split into chunks: help articles,
 * Confluence pages, Jira issues, crawled web pages, uploaded files. Connectors call upsertDocument();
 * unchanged documents (same content hash) are skipped, so re-syncs are cheap.
 */

// The embedding model reads ~128 tokens, so chunks stay short; full-text search covers the rest.
const CHUNK_CHARS = 640;
const OVERLAP_CHARS = 120;

export function chunkText(text: string): string[] {
  const clean = text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const p of paragraphs) {
    if (p.length > CHUNK_CHARS) {
      flush();
      // Split long paragraphs on sentence boundaries with overlap.
      const sentences = p.split(/(?<=[.!?])\s+/);
      let buf = "";
      for (const s of sentences) {
        if ((buf + " " + s).length > CHUNK_CHARS && buf) {
          chunks.push(buf.trim());
          buf = buf.slice(-OVERLAP_CHARS) + " " + s;
        } else buf = buf ? `${buf} ${s}` : s;
      }
      if (buf.trim()) chunks.push(buf.trim().slice(0, CHUNK_CHARS * 2));
      continue;
    }
    if ((current + "\n\n" + p).length > CHUNK_CHARS) flush();
    current = current ? `${current}\n\n${p}` : p;
  }
  flush();
  return chunks;
}

export interface DocumentInput {
  orgId: string;
  sourceId?: string | null;
  articleId?: string | null;
  externalId?: string | null;
  title: string;
  url?: string | null;
  content: string;
  visibility?: KnowledgeVisibility;
  metadata?: Record<string, unknown>;
  externalUpdatedAt?: Date | null;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** Insert or update a document and (re)index its chunks. Returns whether anything changed. */
export async function upsertDocument(input: DocumentInput): Promise<{ id: string; changed: boolean }> {
  const contentHash = hash(`${input.title}\n${input.url ?? ""}\n${input.visibility ?? "public"}\n${input.content}`);
  const where = input.articleId
    ? eq(knowledgeDocuments.articleId, input.articleId)
    : and(
        input.sourceId ? eq(knowledgeDocuments.sourceId, input.sourceId) : isNull(knowledgeDocuments.sourceId),
        eq(knowledgeDocuments.externalId, input.externalId ?? ""),
      );
  const [existing] = await db
    .select()
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.orgId, input.orgId), where));
  if (existing && existing.contentHash === contentHash && existing.indexedAt) {
    return { id: existing.id, changed: false };
  }
  const values = {
    title: input.title.slice(0, 500),
    url: input.url ?? null,
    content: input.content,
    visibility: input.visibility ?? "public",
    metadata: input.metadata ?? {},
    contentHash,
    externalUpdatedAt: input.externalUpdatedAt ?? null,
    indexedAt: null,
  };
  let docId: string;
  if (existing) {
    docId = existing.id;
    await db.update(knowledgeDocuments).set(values).where(eq(knowledgeDocuments.id, docId));
  } else {
    docId = id("doc");
    await db.insert(knowledgeDocuments).values({
      id: docId,
      orgId: input.orgId,
      sourceId: input.sourceId ?? null,
      articleId: input.articleId ?? null,
      externalId: input.externalId ?? (input.articleId ? null : ""),
      ...values,
    });
  }
  await indexDocument(docId);
  return { id: docId, changed: true };
}

/** (Re)build a document's chunks and embeddings. */
export async function indexDocument(documentId: string) {
  const [doc] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, documentId));
  if (!doc) return;
  const pieces = chunkText(doc.content);
  if (!pieces.length) pieces.push(doc.title);
  // The title gives every chunk context ("Refund policy — …") for both retrievers.
  const texts = pieces.map((p) => `${doc.title}\n${p}`);
  const vectors = await embed(texts);
  await db.transaction(async (tx) => {
    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId));
    await tx.insert(knowledgeChunks).values(
      texts.map((content, position) => ({
        id: id("chk"),
        orgId: doc.orgId,
        documentId,
        position,
        content,
        embedding: vectors?.[position] ?? null,
      })),
    );
    await tx.update(knowledgeDocuments).set({ indexedAt: new Date() }).where(eq(knowledgeDocuments.id, documentId));
  });
}

export async function deleteDocument(documentId: string) {
  await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, documentId));
}

/** After a full sync: remove documents of a source that no longer exist upstream. */
export async function removeStaleDocuments(sourceId: string, keepExternalIds: string[]) {
  const where = keepExternalIds.length
    ? and(eq(knowledgeDocuments.sourceId, sourceId), notInArray(knowledgeDocuments.externalId, keepExternalIds))
    : eq(knowledgeDocuments.sourceId, sourceId);
  const removed = await db.delete(knowledgeDocuments).where(where).returning({ id: knowledgeDocuments.id });
  return removed.length;
}

// ---------------------------------------------------------------- help articles

/** Published articles are knowledge documents; drafts and deleted articles are removed from the index. */
export async function syncArticle(articleId: string) {
  const [a] = await db.select().from(articles).where(eq(articles.id, articleId));
  if (!a || a.status !== "published") {
    await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.articleId, articleId));
    return;
  }
  await upsertDocument({
    orgId: a.orgId,
    articleId: a.id,
    title: a.title,
    content: a.body,
    visibility: "public",
    metadata: { tags: a.tags },
  });
}

/** Index anything that isn't indexed yet (new installs, articles created before this feature, failed embeds). */
export async function backfillIndex() {
  const published = await db
    .select({ id: articles.id })
    .from(articles)
    .leftJoin(knowledgeDocuments, eq(knowledgeDocuments.articleId, articles.id))
    .where(and(eq(articles.status, "published"), isNull(knowledgeDocuments.id)));
  for (const a of published) await syncArticle(a.id);
  const unindexed = await db
    .select({ id: knowledgeDocuments.id })
    .from(knowledgeDocuments)
    .where(isNull(knowledgeDocuments.indexedAt));
  for (const d of unindexed) await indexDocument(d.id);
  // Chunks indexed while embeddings were unavailable get vectors now.
  const missing = await db
    .selectDistinct({ documentId: knowledgeChunks.documentId })
    .from(knowledgeChunks)
    .where(isNull(knowledgeChunks.embedding))
    .limit(500);
  if (missing.length && (await embed(["probe"]))) {
    for (const m of missing) await indexDocument(m.documentId);
  }
  if (published.length || unindexed.length || missing.length) {
    console.log(`[knowledge] indexed ${published.length} articles, ${unindexed.length + missing.length} documents`);
  }
}

// Serialize background indexing so bursts of edits don't stampede the CPU.
let queue: Promise<unknown> = Promise.resolve();
export function enqueueIndexing(fn: () => Promise<unknown>) {
  queue = queue.then(fn).catch((err) => console.error("[knowledge] indexing failed", err));
  return queue;
}
