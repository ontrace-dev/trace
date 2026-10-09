import { passkey } from "@better-auth/passkey";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { lastLoginMethod, magicLink, organization, twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { db, schema } from "./db/index.ts";
import { workspaceSettings } from "./db/schema.ts";
import { env } from "./env.ts";
import { sendSystemMail } from "./lib/mailer.ts";
import { ssoEnforcedFor } from "./services/sso.ts";

type Social = { clientId: string; clientSecret: string; tenantId?: string; issuer?: string };
const socialProviders: Record<string, Social> = {};
if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
  socialProviders.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
}
if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  socialProviders.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}
if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
  // "common" lets work and personal Microsoft accounts in; set a tenant id to allow one Entra tenant only.
  socialProviders.microsoft = {
    clientId: env.MICROSOFT_CLIENT_ID,
    clientSecret: env.MICROSOFT_CLIENT_SECRET,
    tenantId: env.MICROSOFT_TENANT_ID,
  };
}
if (env.GITLAB_CLIENT_ID && env.GITLAB_CLIENT_SECRET) {
  socialProviders.gitlab = {
    clientId: env.GITLAB_CLIENT_ID,
    clientSecret: env.GITLAB_CLIENT_SECRET,
    ...(env.GITLAB_ISSUER ? { issuer: env.GITLAB_ISSUER } : {}),
  };
}
export const socialProviderIds = Object.keys(socialProviders);

const appHost = new URL(env.APP_URL).hostname;

export const auth = betterAuth({
  appName: "trace",
  baseURL: env.APP_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.APP_URL, env.PUBLIC_URL, ...env.SSO_TRUSTED_ORIGINS],
  // Behind a reverse proxy (Coolify/Traefik, Caddy, Railway) the client IP is in X-Forwarded-For; without
  // it every visitor shares one rate-limit bucket and a few sign-ins lock everyone out.
  ...(env.TRUST_PROXY ? { advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] } } } : {}),
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    sendResetPassword: async ({ user, url }) => {
      await sendSystemMail({
        to: user.email,
        subject: "Reset your trace password",
        text: `Reset your password: ${url}`,
      });
    },
  },
  socialProviders,
  account: {
    // Sign in with Google or Microsoft as the same person as an existing email account (both verify emails).
    accountLinking: { enabled: true, trustedProviders: ["google", "microsoft"] },
  },
  databaseHooks: {
    session: {
      create: {
        // "Require SSO for this domain": every other way in (password, link, passkey, social) is refused.
        before: async (session, ctx) => {
          if (ctx?.path?.startsWith("/sso/")) return;
          const enforced = await ssoEnforcedFor(session.userId);
          if (enforced)
            throw new APIError("FORBIDDEN", {
              message: `${enforced} signs in with single sign-on. Use “Continue with SSO”.`,
            });
        },
      },
    },
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: true,
      sendInvitationEmail: async ({ id, email, organization: org, inviter }) => {
        const url = `${env.APP_URL}/invite/${id}`;
        await sendSystemMail({
          to: email,
          subject: `${inviter.user.name} invited you to ${org.name} on trace`,
          text: `${inviter.user.name} invited you to join the ${org.name} workspace on trace.\n\nAccept the invitation: ${url}`,
        });
      },
    }),
    twoFactor({ issuer: "trace" }),
    passkey({ rpID: appHost, rpName: "trace", origin: env.APP_URL }),
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await sendSystemMail({
          to: email,
          subject: "Your trace sign-in link",
          text: `Sign in to trace: ${url}\n\nThe link works once and expires in 5 minutes. If you didn't ask for it, ignore this email.`,
        });
      },
    }),
    sso({
      // A provider only works after its owner proves the domain with a DNS TXT record; otherwise anyone could
      // register an IdP for someone else's domain and sign in as those people.
      domainVerification: { enabled: true, tokenPrefix: "trace-verify" },
      organizationProvisioning: {
        defaultRole: "member",
        getRole: async ({ provider }) => {
          if (!provider.organizationId) return "member";
          const [s] = await db
            .select({ sso: workspaceSettings.sso })
            .from(workspaceSettings)
            .where(eq(workspaceSettings.orgId, provider.organizationId));
          return s?.sso?.defaultRole ?? "member";
        },
      },
    }),
    lastLoginMethod(),
  ],
});

export type Session = typeof auth.$Infer.Session;
