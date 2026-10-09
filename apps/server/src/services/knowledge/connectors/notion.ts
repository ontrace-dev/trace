import type { NotionSourceConfig } from "../../../lib/types.ts";
import { ConnectorError, type ConnectorRun, ensureOk, fetchWithRetry } from "./util.ts";

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

interface RichText {
  plain_text?: string;
  href?: string | null;
}
interface Block {
  id: string;
  type: string;
  has_children?: boolean;
  [k: string]: unknown;
}

const rt = (arr: unknown) => ((arr as RichText[] | undefined) ?? []).map((t) => t.plain_text ?? "").join("");

/** Notion's documented limit is ~3 requests/second per integration. */
let last = 0;
async function throttle() {
  const wait = last + 350 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
}

async function notion(path: string, token: string, init: RequestInit = {}) {
  await throttle();
  const res = await fetchWithRetry(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "notion-version": VERSION, "content-type": "application/json" },
  });
  await ensureOk(res, "Notion");
  return res.json() as Promise<Record<string, unknown>>;
}

function blockText(b: Block): string {
  const data = (b[b.type] ?? {}) as Record<string, unknown>;
  const text = rt(data.rich_text);
  switch (b.type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${data.checked ? "x" : " "}] ${text}`;
    case "toggle":
      return text;
    case "quote":
      return `> ${text}`;
    case "callout":
      return `${(data.icon as { emoji?: string } | undefined)?.emoji ?? "💡"} ${text}`;
    case "code":
      return `\`\`\`\n${text}\n\`\`\``;
    case "divider":
      return "---";
    case "child_page":
      return `(page: ${String(data.title ?? "")})`;
    case "table_row":
      return ((data.cells as unknown[][]) ?? []).map((c) => rt(c)).join(" | ");
    case "bookmark":
    case "embed":
    case "link_preview":
      return String(data.url ?? "");
    default:
      return text;
  }
}

async function pageText(pageId: string, token: string, depth = 0): Promise<string> {
  const lines: string[] = [];
  let cursor: string | undefined;
  do {
    const data = (await notion(
      `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
      token,
    )) as {
      results: Block[];
      next_cursor?: string | null;
      has_more?: boolean;
    };
    for (const b of data.results) {
      const t = blockText(b);
      if (t) lines.push(`${"  ".repeat(depth)}${t}`);
      // Recurse into nested blocks (toggles, lists, columns, tables) but not into child pages — those are their own documents.
      if (b.has_children && b.type !== "child_page" && b.type !== "child_database" && depth < 4) {
        lines.push(await pageText(b.id, token, depth + 1));
      }
    }
    cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return lines.filter(Boolean).join("\n");
}

function pageTitle(page: Record<string, unknown>) {
  const props = (page.properties ?? {}) as Record<string, { type?: string; title?: unknown }>;
  const titleProp = Object.values(props).find((p) => p.type === "title");
  return rt(titleProp?.title) || "Untitled";
}

export async function* fetchNotion(cfg: NotionSourceConfig, token: string, opts: { max?: number } = {}): ConnectorRun {
  if (!token) throw new ConnectorError("A Notion integration token is required");
  const max = Math.min(opts.max ?? (cfg.maxPages || 200), 2000);
  let produced = 0;
  let cursor: string | undefined;
  do {
    const data = (await notion("/search", token, {
      method: "POST",
      body: JSON.stringify({
        query: cfg.query?.trim() || undefined,
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 50,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    })) as { results: Record<string, unknown>[]; has_more?: boolean; next_cursor?: string | null };
    if (!produced && !data.results.length && !cursor) {
      throw new ConnectorError(
        "The integration can't see any pages — share pages with it via ••• → Connections in Notion",
      );
    }
    for (const page of data.results) {
      if (produced >= max) break;
      if (page.archived || page.in_trash) continue;
      const content = await pageText(String(page.id), token);
      const title = pageTitle(page);
      produced++;
      yield {
        externalId: String(page.id),
        title,
        url: String(page.url ?? ""),
        content: content || title,
        metadata: { lastEditedBy: (page.last_edited_by as { id?: string } | undefined)?.id },
        updatedAt: page.last_edited_time ? new Date(String(page.last_edited_time)) : null,
      };
    }
    cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
  } while (cursor && produced < max);
}
