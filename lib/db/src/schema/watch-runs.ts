import {
  date,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { benchmarkBulksTable } from "./benchmark-bulks";
import { watchSchedulesTable } from "./watch-schedules";

// W-5a (PRD v8 Part B): the ledger. One row per (schedule, day) the tick
// decided about -- including the days it decided NOT to spend on.
//
// This table is the idempotency. The tick inserts the row FIRST and only then
// does any work: a second tick for the same day hits the unique index below,
// gets a unique violation, and stops. Nothing else -- no in-memory "already
// running" flag, no advisory lock -- is load-bearing, because a flag dies with
// the process and the whole point is a scheduler that survives a restart
// without re-spending the day it already ran.
//
// It writes nothing on its own. W-5b adds the pure decision function and W-5c
// the tick that inserts these rows; until then this is an empty table, which
// is deliberate: a schema step that could start spending the moment it merged
// would not be a schema step.
//
// **The ledger is the history, the bulk is the workbench.** FR-BLK-10 evicts
// the oldest bulk once `MAX_LIVE_BULKS` (10 since W-13) is reached, taking its
// runs, results, scores and rankings with it. The 30-day line on Layer 1 must
// not go with them, so a settled row carries `totals` -- the day's four T-19
// numbers per (agent, provider) -- copied off the bulk before the bulk can
// age out. `bulkId` is the pointer to the workbench; `totals` is the history.
export type WatchRunDetail = {
  /** How many calls the W-4 import wrote for this account's last 24 h. */
  imported?: number;
  /** How many of them the schedule's criteria matched. */
  matched?: number;
  /** How many the W-3 sampler picked. */
  sampled?: number;
  /** matched - sampled when the day had fewer calls than `sampleSize`. */
  shortfall?: number;
  /** W-5f: calls the window matched but that have no `<id>.customer.audio`
   *  on file, so they could not go into a caller-track bulk. Counted before
   *  the draw, so `matched` is the eligible number and a short day says why. */
  noCustomerAudio?: number;
  /** What the preview priced the bulk at, in cents, before any cap decision. */
  estimatedCents?: number;
  /** One message, for a `failed` or `refused:` row. Counts and messages only:
   *  never a transcript, a caller name, or a phone number -- this column is
   *  read by the UI and dumped in logs, and the corpus's PII rules do not
   *  stop at the corpus. */
  error?: string;
};

/** One (agent, provider) pair's day, summed exactly as `GET /benchmark/trend`
 *  sums it (T-19). Absent is not zero: a pair with no scored call has no
 *  entry here rather than a row of zeros. */
export type WatchRunTotals = {
  /** null = the calls carried no assistant id at import. */
  assistantId: string | null;
  providerId: string;
  peerFlags: number;
  words: number;
  callsScored: number;
  cleanCalls: number;
};

/** W-5e: production's own day, per agent, summed exactly as M-8a sums it
 *  (`productionDisagreementSums` in the API's verdict module): the Vapi
 *  draft's caller turns held against the candidates' consensus, and the
 *  best-agreeing candidate measured over the same calls. Kept as SUMS, not
 *  rates, so W-6b can pool days. An agent with no measurable call has no
 *  entry; a mono bulk settles `[]` -- the measurement is null by design off
 *  the customer channel. */
export type WatchRunProduction = {
  /** null = the calls carried no assistant id at import. */
  assistantId: string | null;
  /** Calls the measurement could be computed on (a draft with caller turns
   *  and at least three candidates), out of `totalCalls` for the agent. */
  calls: number;
  totalCalls: number;
  mismatchWords: number;
  comparedWords: number;
  /** The candidate that agreed most with the consensus over the same calls;
   *  null when no candidate had a comparable word. */
  leaderProviderId: string | null;
  leaderMismatchWords: number;
  leaderComparedWords: number;
};

export const watchRunsTable = pgTable(
  "watch_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // No ON DELETE, on purpose. W-2 ships GET, POST and PATCH for schedules
    // and no DELETE -- a schedule is switched off with `enabled`, never
    // removed -- so nothing in production can hit this constraint. What it
    // does do is refuse the day someone adds a DELETE route without having
    // decided what happens to that policy's spend history. That decision
    // should cost a migration, not a silent cascade.
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => watchSchedulesTable.id),
    // A calendar day in server-local time, as "YYYY-MM-DD". A date, not a
    // timestamp: "did this schedule run on the 14th" is a question about a
    // day, and a timestamp would make two ticks 100ms apart two different
    // days as far as the unique index is concerned.
    day: date("day", { mode: "string" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Plain text with the enum enforced at the API boundary, exactly as
    // `benchmark_calls.vertical` and `benchmark_bulks.status` do it. One of:
    // started, imported, sampled, refused:no_calls, refused:no_estimate,
    // refused:daily_cap, refused:monthly_cap, refused:no_key, held:cost_gate,
    // launched, settled, failed.
    //
    // `started` is what the row is inserted with (W-5c2), before any work:
    // the row IS the claim on the day, so its first value has to mean
    // "claimed, nothing done yet" rather than borrow the name of a step that
    // has not run. Every other value replaces it in the same tick, so a row
    // left reading `started` means the process died mid-tick -- which is
    // worth being able to see. `refused:` and `held:` are prefixes the UI matches on (W-6
    // paints a red tick for anything starting `refused:`), so a new reason is
    // a new suffix, never a new shape.
    outcome: text("outcome").notNull(),
    detail: jsonb("detail").$type<WatchRunDetail>(),
    // set null, NOT the plain reference above -- and this asymmetry is the
    // whole reason this column has a comment. Bulks are deleted routinely:
    // FR-BLK-10 evicts the oldest inside the same transaction that creates
    // the eleventh. A plain reference here would make that transaction fail
    // on a foreign-key violation, and every bulk launch at the cap would
    // answer 500 -- which is exactly the bug M-3c cost a live launch to find
    // on `benchmark_agent_scans.run_id`. The ledger row outlives its bulk,
    // detached, carrying the day's totals; the bulk was only ever the place
    // you could click into the calls.
    bulkId: uuid("bulk_id").references(() => benchmarkBulksTable.id, {
      onDelete: "set null",
    }),
    /** Filled when the bulk settles (W-5d). Null means "not settled yet",
     *  and must stay distinguishable from an empty array, which would mean
     *  "settled, and nothing scored". */
    totals: jsonb("totals").$type<WatchRunTotals[]>(),
    /** W-5e: production's measurement per agent, filled at the same settle as
     *  `totals`. Null = not settled; `[]` = settled on a mono bulk (or no
     *  agent had a measurable call). Its own column rather than an entry in
     *  `totals`, because a totals entry is a provider that RAN and production
     *  never runs here (Flux is streaming-only). */
    production: jsonb("production").$type<WatchRunProduction[]>(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // The index IS the idempotency -- see the header. Named so a failure in a
  // log says which rule was hit.
  (table) => [
    uniqueIndex("watch_runs_schedule_day_unique").on(table.scheduleId, table.day),
  ],
);

export const insertWatchRunSchema = createInsertSchema(watchRunsTable).omit({
  id: true,
  startedAt: true,
  updatedAt: true,
});

export type InsertWatchRun = z.infer<typeof insertWatchRunSchema>;
export type WatchRunRow = typeof watchRunsTable.$inferSelect;
