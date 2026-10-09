import { createMiddleware } from "hono/factory";
import { auth } from "../auth.ts";
import { forbidden, unauthorized } from "../lib/http.ts";
import { ensureWorkspace, getMembership } from "../services/workspace.ts";

export interface AppUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

export type AppEnv = {
  Variables: {
    user: AppUser;
    orgId: string;
    role: string;
  };
};

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw unauthorized();
  c.set("user", session.user);
  await next();
});

/** Resolves :wid from the path and checks the user is a member of that workspace. */
export const requireWorkspace = createMiddleware<AppEnv>(async (c, next) => {
  const orgId = c.req.param("wid");
  if (!orgId) throw forbidden("Missing workspace");
  const user = c.get("user");
  const m = await getMembership(orgId, user.id);
  if (!m) throw forbidden("You are not a member of this workspace");
  await ensureWorkspace(orgId);
  c.set("orgId", orgId);
  c.set("role", m.role);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const role = c.get("role");
  if (!role.split(",").some((r) => r === "owner" || r === "admin")) throw forbidden("Admins only");
  await next();
});
