import { sqlClient } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { seedDemo } from "./seed.ts";

await runMigrations();
await seedDemo();
await sqlClient.end();
process.exit(0);
