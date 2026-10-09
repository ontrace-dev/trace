import type { WebsiteSourceConfig } from "../../../lib/types.ts";
import {
  ConnectorError,
  type ConnectorRun,
  decodeEntities,
  extractMainHtml,
  fetchWithRetry,
  htmlTitle,
  htmlToText,
} from "./util.ts";

const CONCURRENCY = 3;
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|tgz|mp4|mp3|webm|woff2?|ttf|css|js|json|xml|rss|atom|txt)$/i;

function normalize(raw: string, base?: string): URL | null {
  try {
    const u = new URL(decodeEntities(raw), base);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.hash = "";
    // Common tracking params never change content.
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u;
  } catch {
    return null;
  }
}

function makeFilter(cfg: WebsiteSourceConfig, start: URL) {
  const basePath = start.pathname.replace(/\/[^/]*\.[a-z0-9]+$/i, "").replace(/\/+$/, "") || "/";
  const include = cfg.include?.filter(Boolean).length ? cfg.include.filter(Boolean) : [basePath];
  const exclude = cfg.exclude?.filter(Boolean) ?? [];
  return (u: URL) =>
    u.origin === start.origin &&
    !SKIP_EXT.test(u.pathname) &&
    include.some((p) => u.pathname === p || u.pathname.startsWith(p.endsWith("/") ? p : `${p}/`) || p === "/") &&
    !exclude.some((p) => u.pathname.startsWith(p));
}

/** Try /sitemap.xml (and sitemap indexes) for an authoritative URL list. */
async function sitemapUrls(start: URL, allowed: (u: URL) => boolean, max: number): Promise<URL[]> {
  const seen = new Set<string>();
  const out: URL[] = [];
  const queue = [
    new URL("/sitemap.xml", start.origin).toString(),
    new URL("/sitemap-index.xml", start.origin).toString(),
  ];
  let fetched = 0;
  while (queue.length && out.length < max && fetched < 10) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    fetched++;
    try {
      const res = await fetchWithRetry(sm, { timeoutMs: 10_000, retries: 1 });
      if (!res.ok) continue;
      const xml = await res.text();
      if (!/<(urlset|sitemapindex)/i.test(xml)) continue;
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!);
      if (/<sitemapindex/i.test(xml)) queue.push(...locs);
      else
        for (const l of locs) {
          const u = normalize(l);
          if (u && allowed(u) && !out.some((x) => x.href === u.href)) out.push(u);
          if (out.length >= max) break;
        }
    } catch {
      /* no sitemap */
    }
  }
  return out;
}

/** Crawl a docs/help site: sitemap first, then breadth-first link following within the path prefix. */
export async function* crawlWebsite(cfg: WebsiteSourceConfig): ConnectorRun {
  const start = normalize(cfg.url);
  if (!start) throw new ConnectorError("Enter a valid http(s) URL");
  const maxPages = Math.min(Math.max(cfg.maxPages || 50, 1), 500);
  const allowed = makeFilter(cfg, start);

  const fromSitemap = await sitemapUrls(start, allowed, maxPages);
  const queue: URL[] = [start, ...fromSitemap];
  const queued = new Set(queue.map((u) => u.href));
  const follow = fromSitemap.length < 3; // a good sitemap is the source of truth
  let produced = 0;
  let firstError: string | null = null;

  const fetchPage = async (u: URL) => {
    try {
      const res = await fetchWithRetry(u.href, { timeoutMs: 15_000, retries: 1, headers: { accept: "text/html" } });
      if (!res.ok) {
        firstError ??= `${u.href}: HTTP ${res.status}`;
        return null;
      }
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("html")) return null;
      const finalUrl = normalize(res.url || u.href) ?? u;
      if (!allowed(finalUrl) && finalUrl.href !== u.href) return null;
      return { url: finalUrl, html: await res.text() };
    } catch (err) {
      firstError ??= err instanceof Error ? err.message : String(err);
      return null;
    }
  };

  while (queue.length && produced < maxPages) {
    const batch = queue.splice(0, CONCURRENCY);
    const pages = await Promise.all(batch.map(fetchPage));
    for (const page of pages) {
      if (!page || produced >= maxPages) continue;
      if (/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(page.html)) continue;
      if (follow) {
        for (const m of page.html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
          const link = normalize(m[1]!, page.url.href);
          if (link && allowed(link) && !queued.has(link.href) && queued.size < maxPages * 4) {
            queued.add(link.href);
            queue.push(link);
          }
        }
      }
      const content = htmlToText(extractMainHtml(page.html));
      if (content.length < 80) continue;
      produced++;
      yield {
        externalId: page.url.href,
        title: htmlTitle(page.html) || page.url.pathname,
        url: page.url.href,
        content,
        metadata: { path: page.url.pathname },
      };
    }
    if (queue.length) await new Promise((r) => setTimeout(r, 150));
  }
  if (!produced)
    throw new ConnectorError(
      firstError ? `No pages could be read (${firstError})` : "No readable pages found at that URL",
    );
}
