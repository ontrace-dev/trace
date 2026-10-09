import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env.ts";
import * as schema from "./schema.ts";

export const sqlClient = postgres(env.DATABASE_URL, { max: 10, onnotice: () => {} });
export const db = drizzle(sqlClient, { schema, casing: "snake_case" });
export type DB = typeof db;
export { schema };
