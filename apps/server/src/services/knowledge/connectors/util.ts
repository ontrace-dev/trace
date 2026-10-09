/** Shared helpers for knowledge connectors: HTTP with retries, HTML → text, Atlassian ADF → text. */

export interface ConnectorDoc {
  externalId: string;
  title: string;
  url?: string | null;
  /** Plain text / light markdown. */
  content: string;
  metadata?: Record<string, unknown>;
  updatedAt?: Date | null;
}

/** A connector yields documents; sync.ts stores and indexes them. */
export type ConnectorRun = AsyncGenerator<ConnectorDoc, void, unknown>;

/** An error whose message is safe and useful to show to an admin. */
export class ConnectorError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with a timeout, retries on 429/5xx/network errors (honoring Retry-After) and readable errors.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number; retries?: number } = {},
): Promise<Response> {
  const { timeoutMs = 20_000, retries = 3, ...rest } = init;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers = new Headers(rest.headers);
      if (!headers.has("user-agent")) headers.set("user-agent", "trace-knowledge/1");
      const res = await fetch(url, {
        ...rest,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 800 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(600 * 2 ** attempt);
    }
  }
  const msg =
    lastErr instanceof Error ? (lastErr.name === "TimeoutError" ? "timed out" : lastErr.message) : String(lastErr);
  throw new ConnectorError(`Could not reach ${safeHost(url)}: ${msg}`);
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Throw a friendly error for non-2xx responses (401/403/404 get specific hints). */
export async function ensureOk(res: Response, what: string) {
  if (res.ok) return;
  let detail = "";
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const candidates = [
        j.message,
        Array.isArray(j.errorMessages) ? (j.errorMessages as string[]).join("; ") : null,
        typeof j.error === "string" ? j.error : (j.error as { message?: string } | undefined)?.message,
        j.description,
      ];
      detail = String(candidates.find((c) => typeof c === "string" && c.trim()) ?? "");
      if (!detail && j.errors) detail = JSON.stringify(j.errors);
    } catch {
      detail = text
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
    }
  } catch {
    /* ignore */
  }
  const hint =
    res.status === 401
      ? "authentication failed — check the credentials / API token"
      : res.status === 403
        ? "access denied — the token lacks permission"
        : res.status === 404
          ? "not found — check the URL"
          : `HTTP ${res.status}`;
  throw new ConnectorError(`${what}: ${hint}${detail ? ` (${detail.slice(0, 200)})` : ""}`);
}

export function basicAuth(email: string, token: string) {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

// ---------------------------------------------------------------- HTML → text

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  middot: "·",
};

const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;

export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return ENTITIES[lower] ?? m;
  });
}

/** Pick the main content region of a web page (main/article/role=main), dropping chrome. */
export function extractMainHtml(html: string) {
  let h = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|form|button)\b[\s\S]*?<\/\1>/gi, "");
  const pick = (re: RegExp) => {
    const m = h.match(re);
    return m && m[1] && m[1].replace(/<[^>]+>/g, "").trim().length > 200 ? m[1] : null;
  };
  const main =
    pick(/<main\b[^>]*>([\s\S]*?)<\/main>/i) ??
    pick(/<article\b[^>]*>([\s\S]*)<\/article>/i) ??
    pick(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/(?:div|section)>\s*(?:<footer|<\/body)/i);
  if (main) h = main;
  else {
    const body = h.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
    if (body) h = body[1]!;
  }
  return h.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, "");
}

export function htmlTitle(html: string) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const raw = (h1 ? h1.replace(/<[^>]+>/g, "") : null) || og || t || "";
  return decodeEntities(raw).replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim();
}

/** HTML → readable text with markdown-ish headings, lists, code blocks and tables. */
export function htmlToText(html: string) {
  let h = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, "");
  // Preserve code blocks verbatim.
  const codes: string[] = [];
  h = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => {
    codes.push(decodeEntities(inner.replace(/<[^>]+>/g, "")));
    return `\n\n\u0000CODE${codes.length - 1}\u0000\n\n`;
  });
  h = h
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`,
    )
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(li)>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|ul|ol|table|blockquote|dl|figure)>/gi, "\n\n")
    .replace(/<(p|div|section|ul|ol|table|blockquote|dl|figure)\b[^>]*>/gi, "\n\n")
    .replace(/<\/(tr)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, c: string) => `\`${c.replace(/<[^>]+>/g, "")}\``)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<[^>]+>/g, "");
  h = decodeEntities(h).replace(ZERO_WIDTH, "");
  h = h.replace(/\u0000CODE(\d+)\u0000/g, (_, i: string) => `\`\`\`\n${codes[Number(i)]!.trim()}\n\`\`\``);
  return h
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n[ ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\*\*\s*\*\*/g, "")
    .trim();
}

// ---------------------------------------------------------------- Atlassian Document Format → text

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/** Convert Jira/Confluence ADF JSON into readable text. Accepts strings (legacy wiki markup) too. */
export function adfToText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  const walk = (n: AdfNode, depth: number, ordered?: { i: number }): string => {
    const kids = (sep = "") => (n.content ?? []).map((c) => walk(c, depth)).join(sep);
    switch (n.type) {
      case "doc":
        return (n.content ?? []).map((c) => walk(c, depth)).join("\n\n");
      case "text": {
        let t = n.text ?? "";
        const link = n.marks?.find((m) => m.type === "link")?.attrs?.href;
        if (n.marks?.some((m) => m.type === "code")) t = `\`${t}\``;
        if (link && link !== t) t = `${t} (${String(link)})`;
        return t;
      }
      case "hardBreak":
        return "\n";
      case "paragraph":
        return kids();
      case "heading":
        return `${"#".repeat(Number(n.attrs?.level ?? 2))} ${kids()}`;
      case "bulletList":
        return (n.content ?? []).map((c) => `${"  ".repeat(depth)}- ${walk(c, depth + 1).trim()}`).join("\n");
      case "orderedList": {
        const counter = { i: Number(n.attrs?.order ?? 1) };
        return (n.content ?? [])
          .map((c) => `${"  ".repeat(depth)}${counter.i++}. ${walk(c, depth + 1, counter).trim()}`)
          .join("\n");
      }
      case "listItem":
        return (n.content ?? []).map((c) => walk(c, depth, ordered)).join("\n");
      case "taskList":
        return (n.content ?? []).map((c) => walk(c, depth)).join("\n");
      case "taskItem":
        return `- [${n.attrs?.state === "DONE" ? "x" : " "}] ${kids()}`;
      case "codeBlock":
        return `\`\`\`\n${kids()}\n\`\`\``;
      case "blockquote":
        return kids("\n")
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n");
      case "panel":
      case "expand":
      case "nestedExpand":
        return `${n.attrs?.title ? `${String(n.attrs.title)}\n` : ""}${kids("\n\n")}`;
      case "rule":
        return "---";
      case "mention":
        return `@${String(n.attrs?.text ?? n.attrs?.id ?? "").replace(/^@/, "")}`;
      case "emoji":
        return String(n.attrs?.text ?? n.attrs?.shortName ?? "");
      case "inlineCard":
      case "blockCard":
      case "embedCard":
        return String(n.attrs?.url ?? "");
      case "status":
        return `[${String(n.attrs?.text ?? "")}]`;
      case "date":
        return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : "";
      case "table":
        return (n.content ?? []).map((row) => walk(row, depth)).join("\n");
      case "tableRow":
        return (n.content ?? []).map((cell) => walk(cell, depth).replace(/\n+/g, " ").trim()).join(" | ");
      case "tableCell":
      case "tableHeader":
        return kids(" ");
      case "mediaSingle":
      case "mediaGroup":
      case "media":
        return "";
      default:
        return kids();
    }
  };
  return walk(node as AdfNode, 0)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
