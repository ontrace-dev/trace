import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { env } from "../env.ts";

/** Guards shared by the public, browser-facing APIs (the widget and the customer portal). */

const buckets = new Map<string, { n: number; reset: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref();

export function clientIp(c: Context) {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ||
    "unknown"
  );
}

/** Fixed-window limiter per IP + key. */
export function rateLimit(c: Context, key: string, limit: number, scope: string, windowMs = 60_000) {
  hit(`${scope}:${key}:${clientIp(c)}`, limit, windowMs);
}

/** Fixed-window limiter on an arbitrary key (e.g. an email address), independent of the caller's IP. */
export function hit(id: string, limit: number, windowMs = 60_000) {
  const now = Date.now();
  const b = buckets.get(id);
  if (!b || b.reset < now) {
    buckets.set(id, { n: 1, reset: now + windowMs });
    return;
  }
  if (++b.n > limit) throw new HTTPException(429, { message: "Too many requests — slow down a little" });
}

/** Whether `origin` matches one of `allowed` (acme.com, *.acme.com, https://app.acme.com or *). */
export function originMatches(origin: string, allowed: string[], opts: { wildcard?: boolean } = {}) {
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return allowed.some((raw) => {
    const a = raw.trim().replace(/\/+$/, "");
    if (!a) return false;
    if (a === "*") return opts.wildcard !== false;
    if (a.startsWith("*.")) return host.endsWith(a.slice(1)) || host === a.slice(2);
    if (a.includes("://")) return a === origin;
    return a === host;
  });
}

/** Browser requests from other sites: allowed when no list is set, from trace itself, or from a listed site. */
export function originAllowed(origin: string | undefined, allowed: string[]) {
  if (!allowed.length || !origin) return true;
  const own = [env.PUBLIC_URL, env.APP_URL].map((u) => new URL(u).origin);
  if (own.includes(origin)) return true;
  return originMatches(origin, allowed);
}
