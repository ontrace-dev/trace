import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { eq } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "../../db/index.ts";
import { mcpServers } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { decrypt, encrypt } from "../../lib/crypto.ts";

interface OAuthState {
  tokens?: OAuthTokens;
  client?: OAuthClientInformationMixed;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
}

export const OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

/** The latest authorization URL per server, handed to the UI to open the provider's sign-in page. */
export const pendingAuthorization = new Map<string, string>();

const sign = (serverId: string) =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(`mcp-oauth:${serverId}`).digest("base64url");

export function verifyState(state: string): string | null {
  const [serverId, mac] = state.split(".");
  if (!serverId || !mac) return null;
  const expected = Buffer.from(sign(serverId));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given) ? serverId : null;
}

/**
 * MCP authorization (OAuth 2.1 + PKCE, dynamic client registration) for one server, persisted
 * encrypted on the server row so tokens survive restarts and refresh automatically.
 */
export class DbOAuthProvider implements OAuthClientProvider {
  private constructor(
    private readonly serverId: string,
    private stored: OAuthState,
  ) {}

  static async load(serverId: string) {
    const [row] = await db.select({ oauth: mcpServers.oauth }).from(mcpServers).where(eq(mcpServers.id, serverId));
    let state: OAuthState = {};
    try {
      state = row?.oauth ? (JSON.parse(decrypt(row.oauth)) as OAuthState) : {};
    } catch {
      state = {};
    }
    return new DbOAuthProvider(serverId, state);
  }

  private async persist() {
    await db
      .update(mcpServers)
      .set({ oauth: encrypt(JSON.stringify(this.stored)) })
      .where(eq(mcpServers.id, this.serverId));
  }

  get redirectUrl() {
    return `${env.PUBLIC_URL}${OAUTH_CALLBACK_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "trace",
      client_uri: env.APP_URL,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state() {
    return `${this.serverId}.${sign(this.serverId)}`;
  }

  clientInformation() {
    return this.stored.client;
  }

  async saveClientInformation(client: OAuthClientInformationMixed) {
    this.stored.client = client;
    await this.persist();
  }

  tokens() {
    return this.stored.tokens;
  }

  async saveTokens(tokens: OAuthTokens) {
    this.stored.tokens = tokens;
    await this.persist();
  }

  redirectToAuthorization(url: URL) {
    pendingAuthorization.set(this.serverId, url.toString());
  }

  async saveCodeVerifier(verifier: string) {
    this.stored.verifier = verifier;
    await this.persist();
  }

  codeVerifier() {
    if (!this.stored.verifier) throw new Error("No PKCE verifier saved — start the sign-in again");
    return this.stored.verifier;
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState) {
    this.stored.discovery = discovery;
    await this.persist();
  }

  discoveryState() {
    return this.stored.discovery;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all") this.stored = {};
    if (scope === "client") delete this.stored.client;
    if (scope === "tokens") delete this.stored.tokens;
    if (scope === "verifier") delete this.stored.verifier;
    if (scope === "discovery") delete this.stored.discovery;
    await this.persist();
  }

  hasTokens() {
    return !!this.stored.tokens?.access_token;
  }
}
