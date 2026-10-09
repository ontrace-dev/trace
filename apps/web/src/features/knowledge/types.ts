import { BookText, FileUp, Globe, LifeBuoy, ListChecks, type LucideIcon, NotebookText, Newspaper } from "lucide-react";

export type SourceType = "website" | "confluence" | "jira" | "notion" | "zendesk" | "files";
export type Visibility = "public" | "internal";

export interface KnowledgeSource {
  id: string;
  type: SourceType;
  name: string;
  enabled: boolean;
  visibility: Visibility;
  config: Record<string, unknown> & { type: SourceType };
  hasSecret: boolean;
  status: "idle" | "syncing" | "ready" | "error";
  statusMessage: string | null;
  documentCount: number;
  syncIntervalMinutes: number;
  lastSyncedAt: string | null;
  createdAt: string;
  syncing: boolean;
}

export interface KnowledgeDocumentRow {
  id: string;
  title: string;
  url: string | null;
  visibility: Visibility;
  metadata: Record<string, unknown>;
  externalUpdatedAt: string | null;
  updatedAt: string;
  indexedAt: string | null;
  chars: number;
  chunks: number;
}

export interface KnowledgeHit {
  documentId: string;
  articleId: string | null;
  title: string;
  url: string | null;
  origin: string;
  visibility: Visibility;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface KnowledgeStatus {
  embeddings: { status: "off" | "loading" | "ready" | "error"; error?: string; model: string };
  byOrigin: { origin: string; documents: number }[];
  chunks: { total: number; embedded: number };
}

export interface TestResult {
  ok: boolean;
  samples?: { title: string; url: string | null }[];
  error?: string;
}

export const SOURCE_META: Record<
  SourceType,
  { label: string; icon: LucideIcon; blurb: string; defaultVisibility: Visibility; needsSecret: boolean }
> = {
  website: {
    label: "Website",
    icon: Globe,
    blurb: "Crawl a docs or help site. Uses the sitemap when available.",
    defaultVisibility: "public",
    needsSecret: false,
  },
  confluence: {
    label: "Confluence",
    icon: BookText,
    blurb: "Sync pages from Confluence spaces (Cloud or Data Center).",
    defaultVisibility: "public",
    needsSecret: true,
  },
  jira: {
    label: "Jira",
    icon: ListChecks,
    blurb: "Known bugs and their status — internal context for the agent.",
    defaultVisibility: "internal",
    needsSecret: true,
  },
  notion: {
    label: "Notion",
    icon: NotebookText,
    blurb: "Pages shared with a Notion integration.",
    defaultVisibility: "public",
    needsSecret: true,
  },
  zendesk: {
    label: "Zendesk Help Center",
    icon: LifeBuoy,
    blurb: "Import your existing Help Center — no credentials needed for public articles.",
    defaultVisibility: "public",
    needsSecret: false,
  },
  files: {
    label: "Files",
    icon: FileUp,
    blurb: "Upload PDF, Markdown, text or HTML documents.",
    defaultVisibility: "public",
    needsSecret: false,
  },
};

export const ORIGIN_ICON: Record<string, LucideIcon> = {
  article: Newspaper,
  ...Object.fromEntries(Object.entries(SOURCE_META).map(([k, v]) => [k, v.icon])),
};

export const ORIGIN_LABEL: Record<string, string> = {
  article: "Article",
  ...Object.fromEntries(Object.entries(SOURCE_META).map(([k, v]) => [k, v.label])),
};
