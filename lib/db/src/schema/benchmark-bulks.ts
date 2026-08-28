import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// What a bulk (or a reusable template) selects from the corpus. For a TEMPLATE
// this stays unfrozen -- a relative window like `lastNDays: 7` is stored as-is
// and re-resolved at every launch (FR-BLK-9). For a BULK it is frozen at
// creation: `lastNDays` is resolved to concrete startedAtFrom/startedAtTo and
// `resolvedCallIds` pins the exact corpus rows, so the bulk can be replayed
// bit-exactly later (FR-BLK-1, FR-BLK-8) even as new calls arrive.
export type BulkSelectionCriteria = {
  vertical?: string;
  assistantIds?: string[];
  accountLabel?: string;
  // Absolute window (frozen at bulk creation; absent on raw templates).
  startedAtFrom?: string;
  startedAtTo?: string;
  // Rolling window, templates only -- resolved against launch time.
  lastNDays?: number;
  minDurationSeconds?: number;
  // T-10: upper bound of the duration band. Absent/null = no cap.
  maxDurationSeconds?: number | null;
  // T-13: outcome filters on Vapi's verbatim `endedReason` /
  // `successEvaluation` (captured by T-11/T-12). Absent = no filter.
  // A call whose outcome is NULL (not captured) never satisfies an include
  // list and is ALSO dropped by an exclude list: "unknown outcome" cannot be
  // shown to be outside the excluded set, and null must never silently pass
  // as a normal call.
  includeEndedReasons?: string[];
  excludeEndedReasons?: string[];
  // Exact match on the stored string ("true" / "false" today).
  successEvaluation?: string;
  // Explicit corpus picks; merged with filter matches.
  callIds?: string[];
  // Frozen resolution, set on bulks only, at creation time.
  resolvedCallIds?: string[];
  resolvedAt?: string;
};

// T-13 "worth benchmarking" preset: the endedReason values that mean a real
// conversation happened. Everything else (voicemail, silence timeouts,
// misdials, errors, and calls whose outcome was never captured) is out.
export const WORTH_BENCHMARKING_ENDED_REASONS = [
  "customer-ended-call",
  "assistant-forwarded-call",
  "assistant-ended-call",
  "assistant-said-end-call-phrase",
] as const;

// A Bulk (FR-BLK-1) is a named evaluation batch over a frozen slice of the
// corpus. It owns no cells itself: launch fans the frozen call set into
// shards of `shardSize`, and each shard x providerIds becomes an ordinary
// benchmark_runs row (bulkId + shardIndex set) that reuses the entire
// existing run/result/score machinery unchanged (FR-BLK-3).
//
// Status machine (FR-BLK-4):
//   draft -> estimating -> awaiting_confirmation -> running
//     -> complete | partial | failed | cancelled
// `partial` = at least one cell failed after retries; `cancelled` via
// POST /bulks/:id/cancel stops un-started cells (in-flight provider calls
// complete and are recorded, FR-BLK-7).
export const benchmarkBulksTable = pgTable(
  "benchmark_bulks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // FR-BLK-2: defaults to the launch date (YYYY-MM-DD, server local time)
    // when the caller does not supply one; unique because there is exactly
    // one org today (OD-11: no auth, single operator).
    name: text("name").notNull(),
    status: text("status").notNull().default("draft"),
    selectionCriteria: jsonb("selection_criteria")
      .$type<BulkSelectionCriteria>()
      .notNull(),
    providerIds: text("provider_ids").array().notNull(),
    shardSize: integer("shard_size").notNull().default(50),
    minDurationSeconds: integer("min_duration_seconds").notNull().default(60),
    // T-10: nullable, no DB default -- bulks created before the band existed
    // stay honest as "no cap" rather than being backfilled with 120.
    maxDurationSeconds: integer("max_duration_seconds"),
    // 2026-08-27, per Abhishek ("show cost of each run and the openai agent
    // cost and stt cost separately, estimated"): estimatedCostCents kept as
    // the historical STT-only total (nothing reading it today breaks) --
    // estimatedSttCostCents is the same number, correctly named, alongside
    // the genuinely new estimatedAgentCostCents (the OpenAI judge-call cost
    // this bulk is expected to incur once flagged calls are known). Actual
    // (post-run) cost is computed on demand from real benchmark_scores /
    // benchmark_agent_scans rows rather than stored here -- storing it would
    // just go stale the moment a cell is retried.
    estimatedCostCents: integer("estimated_cost_cents"),
    estimatedSttCostCents: integer("estimated_stt_cost_cents"),
    estimatedAgentCostCents: integer("estimated_agent_cost_cents"),
    launchedByLabel: text("launched_by_label"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("benchmark_bulks_name_unique").on(table.name)],
);

export const insertBenchmarkBulkSchema = createInsertSchema(
  benchmarkBulksTable,
).omit({ id: true, createdAt: true, updatedAt: true, completedAt: true });

export type InsertBenchmarkBulk = z.infer<typeof insertBenchmarkBulkSchema>;
export type BenchmarkBulkRow = typeof benchmarkBulksTable.$inferSelect;
