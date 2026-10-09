import { passkeyClient } from "@better-auth/passkey/client";
import { ssoClient } from "@better-auth/sso/client";
import {
  lastLoginMethodClient,
  magicLinkClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [
    organizationClient(),
    twoFactorClient(),
    passkeyClient(),
    magicLinkClient(),
    ssoClient({ domainVerification: { enabled: true } }),
    lastLoginMethodClient(),
  ],
});

export const { useSession, signIn, signUp, signOut } = authClient;
