import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { knowledgeChunks, knowledgeDocuments, knowledgeSources } from "../../db/schema.ts";
import type { Source } from "../../lib/types.ts";
import { keywords, stem } from "../ai/knowledge.ts";
import { embedOne } from "./embeddings.ts";

export interface KnowledgeHit {
  documentId: string;
  articleId: string | null;
  title: string;
  url: string | null;
  /** "article" for help-center articles, otherwise the connector type (confluence, jira, website, …). */
  origin: string;
  visibility: "public" | "internal";
  /** The best matching passages of the document, in document order. */
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

const RRF_K = 60;

/**
 * Hybrid retrieval: semantic (pgvector cosine over local multilingual embeddings) fused with
 * keyword full-text search by reciprocal rank fusion, then grouped per document.
 */
export async function searchKnowledge(
  orgId: string,
  query: string,
  opts: { limit?: number; includeInternal?: boolean } = {},
): Promise<KnowledgeHit[]> {
  const limit = opts.limit ?? 6;
  const q = query.trim();
  if (!q) return [];
  const visible = opts.includeInternal === false ? eq(knowledgeDocuments.visibility, "public") : undefined;

  const vector = await embedOne(q);
  const terms = keywords(q, 10)
    .map(stem)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((t) => t.length > 1);
  const tsq = terms.map((t) => `${t}:*`).join(" | ");

  const base = {
    chunkId: knowledgeChunks.id,
    documentId: knowledgeChunks.documentId,
    position: knowledgeChunks.position,
    content: knowledgeChunks.content,
  };
  const rankExpr = sql<number>`ts_rank(to_tsvector('simple', ${knowledgeChunks.content}), to_tsquery('simple', ${tsq}))`;
  const [semantic, lexical] = await Promise.all([
    vector
      ? db
          .select({
            ...base,
            sim: sql<number>`1 - (${knowledgeChunks.embedding} <=> ${JSON.stringify(vector)}::vector)`,
          })
          .from(knowledgeChunks)
          .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
          .where(and(eq(knowledgeChunks.orgId, orgId), isNotNull(knowledgeChunks.embedding), visible))
          .orderBy(sql`${knowledgeChunks.embedding} <=> ${JSON.stringify(vector)}::vector`)
          .limit(40)
      : Promise.resolve([]),
    tsq
      ? db
          .select({ ...base, rank: rankExpr })
          .from(knowledgeChunks)
          .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
          .where(
            and(
              eq(knowledgeChunks.orgId, orgId),
              visible,
              sql`to_tsvector('simple', ${knowledgeChunks.content}) @@ to_tsquery('simple', ${tsq})`,
            ),
          )
          .orderBy(sql`${rankExpr} desc`)
          .limit(40)
      : Promise.resolve([]),
  ]);

  // Reciprocal rank fusion. Weak semantic matches (low cosine) don't get a vote.
  const chunkScores = new Map<string, { score: number; documentId: string; position: number; content: string }>();
  const vote = (rows: { chunkId: string; documentId: string; position: number; content: string }[], weight: number) =>
    rows.forEach((r, i) => {
      const cur = chunkScores.get(r.chunkId) ?? {
        score: 0,
        documentId: r.documentId,
        position: r.position,
        content: r.content,
      };
      cur.score += weight / (RRF_K + i + 1);
      chunkScores.set(r.chunkId, cur);
    });
  // Meaning beats shared words ("login" appears everywhere); keywords still rescue exact terms like ids.
  vote(
    semantic.filter((r) => r.sim > 0.25),
    1,
  );
  vote(lexical, 0.6);
  if (!chunkScores.size) return [];

  // Group per document: best chunk score + a small bonus for additional matching chunks.
  const docs = new Map<string, { score: number; chunks: { position: number; content: string; score: number }[] }>();
  for (const c of chunkScores.values()) {
    const d = docs.get(c.documentId) ?? { score: 0, chunks: [] };
    d.chunks.push(c);
    d.score = Math.max(d.score, c.score) + (d.chunks.length > 1 ? c.score * 0.25 : 0);
    docs.set(c.documentId, d);
  }
  const ranked = [...docs.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
  const meta = await db
    .select({
      id: knowledgeDocuments.id,
      articleId: knowledgeDocuments.articleId,
      title: knowledgeDocuments.title,
      url: knowledgeDocuments.url,
      visibility: knowledgeDocuments.visibility,
      metadata: knowledgeDocuments.metadata,
      sourceType: knowledgeSources.type,
    })
    .from(knowledgeDocuments)
    .leftJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeDocuments.sourceId))
    .where(
      inArray(
        knowledgeDocuments.id,
        ranked.map(([id]) => id),
      ),
    );
  const byId = new Map(meta.map((m) => [m.id, m]));
  return ranked.flatMap(([documentId, d]) => {
    const m = byId.get(documentId);
    if (!m) return [];
    const best = d.chunks
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .sort((a, b) => a.position - b.position)
      // Chunks are stored with the title prepended; don't repeat it.
      .map((c) => c.content.slice(c.content.indexOf("\n") + 1));
    return [
      {
        documentId,
        articleId: m.articleId,
        title: m.title,
        url: m.url,
        origin: m.articleId ? "article" : (m.sourceType ?? "document"),
        visibility: m.visibility,
        content: best.join("\n…\n"),
        score: d.score,
        metadata: m.metadata,
      },
    ];
  });
}

/** How a hit is cited on messages and drafts. */
export function hitToSource(h: KnowledgeHit): Source {
  return h.articleId
    ? { type: "article", id: h.articleId, title: h.title }
    : { type: "document", id: h.documentId, title: h.title, url: h.url, origin: h.origin, visibility: h.visibility };
}
