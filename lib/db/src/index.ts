import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Untuned pg default is 10 clients, which starves the run executor once
  // cell writes go concurrent (see ox-alpha/scalability-design.md). Keep the
  // default modest so pooled connection strings (Neon/Supabase/pgbouncer)
  // stay within their per-branch budgets.
  // B-92 (verified wave-2): a floor of 2 — the executor's advisory-lock
  // client pins one connection for the whole run, so max=1 circular-waits
  // forever with zero logs.
  max: Math.max(2, process.env.PGPOOL_MAX ? Number.parseInt(process.env.PGPOOL_MAX, 10) || 0 : 20),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
