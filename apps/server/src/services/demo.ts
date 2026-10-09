import { eq } from "drizzle-orm";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { auth } from "../auth.ts";
import { db } from "../db/index.ts";
import { organization } from "../db/schema.ts";
import { env } from "../env.ts";
import { DEMO_EMAIL, DEMO_PASSWORD, DEMO_SLUG, DEMO_TEAM, seedDemo } from "../scripts/seed.ts";

/**
 * Shared demo mode (DEMO_MODE=true) for a public test instance: the "northwind" workspace is seeded on
 * boot, the demo accounts can't be locked or deleted, and the workspace is rebuilt every DEMO_RESET_HOURS
 * so testers can click anything without breaking it for the next person.
 */

const DEMO_EMAILS = new Set(DEMO_TEAM.map((p) => p.email));
const stateFile = join(env.DATA_DIR, "demo-reset.json");

/** Auth endpoints a demo account may not use: they'd lock the next tester out or break the workspace. */
const BLOCKED = [
  "/change-password",
  "/change-email",
  "/delete-user",
  "/update-user",
  "/organization/delete",
  "/organization/update",
  "/organization/leave",
  "/organization/remove-member",
  "/organization/update-member-role",
  // A tester turning on 2FA or adding a passkey would lock the next tester out of the shared account.
  "/two-factor/enable",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
];

const DENIED = () =>
  Response.json(
    { message: "Disabled in the shared demo. Sign up with your own account to try this." },
    { status: 403 },
  );

/**
 * On a demo instance that delivers mail to the bundled, publicly readable Mailpit, sign-in and reset links
 * would let anyone read their way into anyone's account. Those flows are off there.
 */
export const publicMailbox = () => env.DEMO_MODE && /mailpit/i.test(env.SMTP_URL);
const MAIL_LINK_FLOWS = ["/sign-in/magic-link", "/request-password-reset", "/forget-password"];

/** Returns a 403 Response when a demo account calls a blocked auth endpoint; null otherwise. */
export async function demoAuthGuard(req: Request): Promise<Response | null> {
  if (!env.DEMO_MODE || req.method !== "POST") return null;
  const path = new URL(req.url).pathname.replace(/^\/api\/auth/, "");
  if (publicMailbox() && MAIL_LINK_FLOWS.includes(path))
    return Response.json(
      { message: "Email links are off on this demo server: its mailbox is public." },
      { status: 403 },
    );
  // Password-reset mail for a demo account would land in the public demo mailbox — refuse to send it.
  if (path === "/request-password-reset" || path === "/forget-password") {
    const body = (await req
      .clone()
      .json()
      .catch(() => ({}))) as { email?: string };
    return body.email && DEMO_EMAILS.has(body.email.trim().toLowerCase()) ? DENIED() : null;
  }
  if (!BLOCKED.some((b) => path === b || path.startsWith(`${b}/`))) return null;
  const session = await auth.api.getSession({ headers: req.headers }).catch(() => null);
  if (!session || !DEMO_EMAILS.has(session.user.email)) return null;
  return DENIED();
}

async function lastReset(): Promise<number | null> {
  try {
    return (JSON.parse(await readFile(stateFile, "utf8")) as { at: number }).at;
  } catch {
    return null;
  }
}

async function markReset() {
  await mkdir(env.DATA_DIR, { recursive: true });
  await writeFile(stateFile, JSON.stringify({ at: Date.now() }));
}

export async function nextResetAt() {
  if (!env.DEMO_MODE || !env.DEMO_RESET_HOURS) return null;
  const last = await lastReset();
  return last ? new Date(last + env.DEMO_RESET_HOURS * 3_600_000).toISOString() : null;
}

/** Drop the demo workspace (everything in it cascades) and seed it again. */
export async function resetDemo() {
  console.log("[demo] resetting the demo workspace…");
  await db.delete(organization).where(eq(organization.slug, DEMO_SLUG));
  await seedDemo();
  await markReset();
  console.log("[demo] reset done");
}

let resetting = false;

/** Seed on boot (in the background, after the server listens) and reset on schedule. */
export function startDemo() {
  if (!env.DEMO_MODE && process.env.SEED_DEMO !== "true") return;
  void (async () => {
    try {
      await seedDemo();
      if (!existsSync(stateFile)) await markReset();
    } catch (err) {
      console.error("[seed] failed", err);
    }
  })();
  if (!env.DEMO_MODE || !env.DEMO_RESET_HOURS) return;
  setInterval(
    async () => {
      if (resetting) return;
      const last = await lastReset();
      if (last && Date.now() - last < env.DEMO_RESET_HOURS * 3_600_000) return;
      resetting = true;
      try {
        await resetDemo();
      } catch (err) {
        console.error("[demo] reset failed", err);
      } finally {
        resetting = false;
      }
    },
    Math.min(5 * 60_000, Math.max(30_000, (env.DEMO_RESET_HOURS * 3_600_000) / 4)),
  ).unref();
}

export const demoInfo = async () =>
  env.DEMO_MODE
    ? {
        email: DEMO_EMAIL,
        password: DEMO_PASSWORD,
        slug: DEMO_SLUG,
        resetHours: env.DEMO_RESET_HOURS,
        nextResetAt: await nextResetAt(),
      }
    : null;
