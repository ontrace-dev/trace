import { isPublicRoutableHost } from "@better-auth/core/utils/host";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { ssoProvider, user, workspaceSettings } from "../db/schema.ts";
import { env } from "../env.ts";
import { badRequest } from "../lib/http.ts";

/**
 * Workspace SSO helpers: which provider handles an email domain (for the login hint), and whether a
 * user's domain requires SSO (enforced by the session hook in auth.ts).
 */

const domainOf = (email: string) => email.trim().toLowerCase().split("@")[1] ?? "";

/** Verified providers whose (comma-separated) domain list contains `domain`. */
async function providersFor(domain: string) {
  if (!domain) return [];
  return db
    .select()
    .from(ssoProvider)
    .where(
      and(
        eq(ssoProvider.domainVerified, true),
        sql`${domain} = any(string_to_array(replace(lower(${ssoProvider.domain}), ' ', ''), ','))`,
      ),
    );
}

/** For the login page: does this email's domain sign in with SSO, and with what? */
export async function ssoLookup(email: string) {
  const domain = domainOf(email);
  const [p] = await providersFor(domain);
  if (!p) return null;
  let via = "your identity provider";
  try {
    via = new URL(p.issuer).hostname;
  } catch {
    /* issuer isn't a URL (some SAML IdPs) */
  }
  return { domain, providerId: p.providerId, via, protocol: p.samlConfig ? "saml" : "oidc" };
}

/** The email domain if this user's workspace requires SSO for it; null otherwise. */
export async function ssoEnforcedFor(userId: string): Promise<string | null> {
  const [u] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  const domain = u ? domainOf(u.email) : "";
  if (!domain) return null;
  for (const p of await providersFor(domain)) {
    if (!p.organizationId) continue;
    const [s] = await db
      .select({ sso: workspaceSettings.sso })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.orgId, p.organizationId));
    if (s?.sso?.enforcedDomains?.map((d) => d.toLowerCase()).includes(domain)) return domain;
  }
  return null;
}

/**
 * Fetch an OIDC issuer's discovery document for a workspace admin. Better Auth only discovers from
 * `trustedOrigins`, which would need a server config change per customer IdP; instead trace fetches it here
 * (public https hosts only, no redirects, unless the origin is in SSO_TRUSTED_ORIGINS) and registers the
 * provider with explicit endpoints. Better Auth still checks those endpoints are publicly routable.
 */
export async function discoverOidc(issuer: string) {
  let url: URL;
  try {
    url = new URL(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  } catch {
    throw badRequest("That issuer isn't a URL");
  }
  const trusted = env.SSO_TRUSTED_ORIGINS.includes(url.origin);
  if (!trusted && (url.protocol !== "https:" || !isPublicRoutableHost(url.hostname)))
    throw badRequest(
      "The issuer must be a public https URL. For an internal IdP, add its origin to SSO_TRUSTED_ORIGINS.",
    );
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) throw badRequest(`Couldn't load ${url.href}`);
  const doc = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (k: string) => (typeof doc?.[k] === "string" ? (doc[k] as string) : undefined);
  const endpoints = {
    issuer: str("issuer"),
    authorizationEndpoint: str("authorization_endpoint"),
    tokenEndpoint: str("token_endpoint"),
    jwksEndpoint: str("jwks_uri"),
    userInfoEndpoint: str("userinfo_endpoint"),
  };
  if (!endpoints.issuer || !endpoints.authorizationEndpoint || !endpoints.tokenEndpoint || !endpoints.jwksEndpoint)
    throw badRequest("That doesn't look like an OpenID Connect issuer (discovery document incomplete)");
  const methods = Array.isArray(doc?.token_endpoint_auth_methods_supported)
    ? (doc.token_endpoint_auth_methods_supported as string[])
    : [];
  return {
    ...endpoints,
    discoveryEndpoint: url.href,
    tokenEndpointAuthentication:
      methods.length && !methods.includes("client_secret_basic") ? "client_secret_post" : "client_secret_basic",
  } as const;
}
