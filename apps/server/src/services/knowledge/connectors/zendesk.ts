import type { ZendeskSourceConfig } from "../../../lib/types.ts";
import { basicAuth, ConnectorError, type ConnectorRun, ensureOk, fetchWithRetry, htmlToText } from "./util.ts";

interface ZdArticle {
  id: number;
  title: string;
  body: string | null;
  html_url: string;
  draft: boolean;
  updated_at: string;
  section_id?: number;
  label_names?: string[];
  locale?: string;
}

/** Zendesk Help Center articles — public ones need no credentials. The easiest way to migrate off Zendesk. */
export async function* fetchZendesk(
  cfg: ZendeskSourceConfig,
  token: string,
  opts: { max?: number } = {},
): ConnectorRun {
  const sub = cfg.subdomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\.zendesk\.com.*$/, "")
    .replace(/\/.*$/, "");
  if (!/^[a-z0-9-]+$/i.test(sub))
    throw new ConnectorError('Enter the Zendesk subdomain, e.g. "acme" for acme.zendesk.com');
  const headers: Record<string, string> = { accept: "application/json" };
  if (cfg.email?.trim() && token) headers.authorization = basicAuth(`${cfg.email.trim()}/token`, token);
  const locale = cfg.locale?.trim() ? `/${cfg.locale.trim().toLowerCase()}` : "";
  const max = opts.max ?? 5000;
  let produced = 0;
  let next: string | null =
    `https://${sub}.zendesk.com/api/v2/help_center${locale}/articles.json?per_page=100&sort_by=updated_at&sort_order=desc`;
  while (next && produced < max) {
    const res = await fetchWithRetry(next, { headers });
    await ensureOk(res, "Zendesk Help Center");
    const data = (await res.json()) as { articles?: ZdArticle[]; next_page?: string | null };
    for (const a of data.articles ?? []) {
      if (produced >= max) break;
      if (a.draft) continue;
      const content = htmlToText(a.body ?? "");
      if (!content.trim()) continue;
      produced++;
      yield {
        externalId: String(a.id),
        title: a.title,
        url: a.html_url,
        content,
        metadata: { labels: a.label_names ?? [], sectionId: a.section_id, locale: a.locale },
        updatedAt: a.updated_at ? new Date(a.updated_at) : null,
      };
    }
    next = data.next_page ?? null;
  }
}
