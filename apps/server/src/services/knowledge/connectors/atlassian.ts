import type { ConfluenceSourceConfig, JiraSourceConfig } from "../../../lib/types.ts";
import {
  adfToText,
  basicAuth,
  ConnectorError,
  type ConnectorRun,
  ensureOk,
  fetchWithRetry,
  htmlToText,
} from "./util.ts";

/** Cloud uses email + API token (Basic). Data Center/Server uses a personal access token (Bearer) when no email is set. */
function authHeader(email: string, token: string) {
  if (!token) throw new ConnectorError("An API token is required");
  return email.trim() ? basicAuth(email.trim(), token) : `Bearer ${token}`;
}

const trimBase = (u: string) => u.trim().replace(/\/+$/, "");

// ---------------------------------------------------------------- Confluence

/** Confluence storage format (XHTML + ac:* macros) → text. */
export function confluenceStorageToText(storage: string) {
  const s = storage
    // Code macro bodies are CDATA in ac:plain-text-body.
    .replace(
      /<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>/gi,
      (_, code: string) => `<pre>${code.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`,
    )
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    // Panels/notes/info macros: keep their bodies.
    .replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/gi, "")
    .replace(/<ri:user[^>]*\/>/gi, "@user")
    .replace(
      /<ac:link[^>]*>\s*<ri:page[^>]*ri:content-title="([^"]*)"[^>]*\/>\s*(?:<ac:plain-text-link-body>[\s\S]*?<\/ac:plain-text-link-body>)?\s*<\/ac:link>/gi,
      "$1",
    )
    .replace(/<\/?(ac|ri):[^>]*>/gi, "");
  return htmlToText(s);
}

function confluenceCql(cfg: ConfluenceSourceConfig) {
  const keys = cfg.spaceKeys.map((k) => k.trim()).filter(Boolean);
  const parts = ["type = page"];
  if (keys.length) parts.push(`space in (${keys.map((k) => `"${k.replace(/"/g, "")}"`).join(",")})`);
  if (cfg.cql?.trim()) parts.push(`(${cfg.cql.trim()})`);
  return `${parts.join(" AND ")} ORDER BY lastmodified DESC`;
}

export async function* fetchConfluence(
  cfg: ConfluenceSourceConfig,
  token: string,
  opts: { max?: number } = {},
): ConnectorRun {
  const base = trimBase(cfg.baseUrl);
  if (!/^https?:\/\//.test(base)) throw new ConnectorError("Base URL must look like https://acme.atlassian.net/wiki");
  const headers = { authorization: authHeader(cfg.email, token), accept: "application/json" };
  const max = opts.max ?? 2000;
  let produced = 0;
  let next: string | null =
    `${base}/rest/api/content/search?cql=${encodeURIComponent(confluenceCql(cfg))}&limit=50&expand=body.storage,version,space`;
  while (next && produced < max) {
    const res = await fetchWithRetry(next, { headers });
    await ensureOk(res, "Confluence");
    const data = (await res.json()) as {
      results: {
        id: string;
        title: string;
        body?: { storage?: { value?: string } };
        version?: { when?: string; number?: number };
        space?: { key?: string; name?: string };
        _links?: { webui?: string };
      }[];
      _links?: { next?: string; base?: string };
    };
    for (const page of data.results ?? []) {
      if (produced >= max) break;
      const content = confluenceStorageToText(page.body?.storage?.value ?? "");
      if (!content.trim()) continue;
      produced++;
      yield {
        externalId: page.id,
        title: page.title,
        url: page._links?.webui ? `${data._links?.base ?? base}${page._links.webui}` : null,
        content,
        metadata: { space: page.space?.key, spaceName: page.space?.name, version: page.version?.number },
        updatedAt: page.version?.when ? new Date(page.version.when) : null,
      };
    }
    const n = data._links?.next;
    // _links.next is relative to _links.base (which includes the /wiki context path).
    next = n ? (n.startsWith("http") ? n : `${trimBase(data._links?.base ?? base)}${n}`) : null;
  }
}

// ---------------------------------------------------------------- Jira

interface JiraIssue {
  key: string;
  id: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string; statusCategory?: { name?: string } };
    resolution?: { name?: string } | null;
    issuetype?: { name?: string };
    priority?: { name?: string } | null;
    labels?: string[];
    updated?: string;
    comment?: { comments?: { author?: { displayName?: string }; body?: unknown; created?: string }[] };
  };
}

export async function* fetchJira(cfg: JiraSourceConfig, token: string, opts: { max?: number } = {}): ConnectorRun {
  const base = trimBase(cfg.baseUrl);
  if (!/^https?:\/\//.test(base)) throw new ConnectorError("Base URL must look like https://acme.atlassian.net");
  const headers = {
    authorization: authHeader(cfg.email, token),
    accept: "application/json",
    "content-type": "application/json",
  };
  const max = Math.min(opts.max ?? (cfg.maxIssues || 300), 5000);
  const jql = cfg.jql?.trim() || "updated >= -180d ORDER BY updated DESC";
  const fields = ["summary", "description", "status", "resolution", "issuetype", "priority", "labels", "updated"];
  if (cfg.includeComments) fields.push("comment");
  let produced = 0;
  let nextPageToken: string | undefined;
  do {
    const res = await fetchWithRetry(`${base}/rest/api/3/search/jql`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jql,
        fields,
        maxResults: Math.min(100, max - produced),
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
    });
    await ensureOk(res, "Jira");
    const data = (await res.json()) as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean };
    for (const issue of data.issues ?? []) {
      if (produced >= max) break;
      const f = issue.fields;
      const status = f.status?.name ?? "";
      const lines = [
        `Key: ${issue.key}`,
        `Type: ${f.issuetype?.name ?? ""} · Status: ${status}${f.resolution?.name ? ` · Resolution: ${f.resolution.name}` : ""}${f.priority?.name ? ` · Priority: ${f.priority.name}` : ""}`,
        f.labels?.length ? `Labels: ${f.labels.join(", ")}` : "",
        "",
        adfToText(f.description),
      ];
      const comments = f.comment?.comments ?? [];
      if (cfg.includeComments && comments.length) {
        lines.push("", "Comments:");
        for (const c of comments.slice(-10)) {
          lines.push(
            `- ${c.author?.displayName ?? "someone"} (${c.created?.slice(0, 10) ?? ""}): ${adfToText(c.body).replace(/\n+/g, " ")}`,
          );
        }
      }
      produced++;
      yield {
        externalId: issue.key,
        title: `${issue.key}: ${f.summary ?? "(no summary)"}`,
        url: `${base}/browse/${issue.key}`,
        content: lines
          .filter((l, i) => l || i > 2)
          .join("\n")
          .trim(),
        metadata: {
          key: issue.key,
          status,
          statusCategory: f.status?.statusCategory?.name,
          issuetype: f.issuetype?.name,
          priority: f.priority?.name,
          resolution: f.resolution?.name ?? null,
          labels: f.labels ?? [],
        },
        updatedAt: f.updated ? new Date(f.updated) : null,
      };
    }
    nextPageToken = data.isLast ? undefined : data.nextPageToken;
  } while (nextPageToken && produced < max);
}
