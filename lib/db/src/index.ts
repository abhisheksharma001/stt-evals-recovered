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
// B-88 (verified wave-2): `pg.Pool` is an EventEmitter, and pg-pool's idle
// handler calls `pool.emit("error", err, client)` when a pooled connection
// dies while nobody is using it -- a database failover, a load balancer
// closing an idle socket, an RST. Node throws an emitted "error" that has no
// listener, and nothing in this process installs an `uncaughtException`
// handler, so one dropped idle socket took the whole API down with it: every
// in-flight run stranded at `running`, mid-spend, with no record of why.
//
// pg has already removed the dead client from the pool by the time this fires
// (pg-pool `makeIdleListener`), so there is nothing here to repair. The
// listener exists to stop the event being fatal and to say what happened.
//
// `console.error` rather than the api-server pino logger: the dependency runs
// the other way (api-server imports this package), and giving lib/db its own
// pino would stand up a second transport for one line.
//
// Only `message` and `code` are logged. The second argument pg passes is the
// dead client, whose `connectionParameters` carry the database password.
pool.on("error", (err: Error & { code?: string }) => {
  const code = err.code ? ` (${err.code})` : "";
  console.error(`pg pool: idle client errored and was removed: ${err.message}${code}`);
});

export const db = drizzle(pool, { schema });

// R-27: `pool.connect()` is overloaded (it also takes a callback and returns
// void), so `Awaited<ReturnType<typeof pool.connect>>` widens to `void |
// PoolClient` at the call site. `pg` is a dependency of this package and not
// of its consumers, so the type is re-exported from here rather than imported
// across the boundary.
export type DbPoolClient = pg.PoolClient;

export * from "./schema";
