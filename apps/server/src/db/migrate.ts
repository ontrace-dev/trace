import { migrate } from "drizzle-orm/postgres-js/migrator";
import { existsSync } from "node:fs";
import { db, sqlClient } from "./index.ts";

/** Wait for Postgres to accept connections (hosts like Railway start services without ordering). */
async function waitForDatabase(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await sqlClient`select 1`;
      return;
    } catch (err) {
      const { code, message } = err as { code?: string; message: string };
      // Wrong credentials won't fix themselves, and retrying them gets poolers like Supabase's to block us.
      const badLogin = code === "28P01" || code === "28000" || /password|authentication|tenant or user/i.test(message);
      if (badLogin) throw new Error(`[db] could not log in to the database, check DATABASE_URL: ${message}`);
      if (Date.now() > deadline) throw err;
      console.log(`[db] waiting for database (attempt ${attempt}): ${code ? `${code} ` : ""}${message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** Applies pending SQL migrations from apps/server/drizzle (generated with `db:generate`). */
export async function runMigrations() {
  const candidates = [
    new URL("../../drizzle", import.meta.url).pathname, // src/db → apps/server/drizzle
    new URL("../drizzle", import.meta.url).pathname, // dist → apps/server/drizzle
  ];
  const folder = candidates.find((p) => existsSync(p));
  if (!folder) throw new Error("migrations folder not found");
  await waitForDatabase();
  await migrate(db, { migrationsFolder: folder });
}
