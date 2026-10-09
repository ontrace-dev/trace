import { sqlClient } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";

await runMigrations();
console.log("[migrate] database is up to date");
await sqlClient.end();
