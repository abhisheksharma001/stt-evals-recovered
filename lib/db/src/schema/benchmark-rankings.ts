import {
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const benchmarkRankingsTable = pgTable("benchmark_rankings", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id"),
  vertical: text("vertical").notNull(),
  // 2026-08-27, per Abhishek: rankings now group by real Vapi assistant
  // instead of vertical (same reasoning as the Bulks picker -- vertical was
  // too coarse a bucket). Null = "Other" (a manually-added call with no
  // Vapi assistant). `vertical` is kept as a display tag on each row, not
  // the grouping key anymore -- see computeRankingsForRun in run-executor.ts.
  assistantId: text("assistant_id"),
  providerId: text("provider_id").notNull(),
  providerName: text("provider_name").notNull(),
  rank: integer("rank").notNull(),
  // Nullable: "no scored cell had this metric" is a real, distinct state
  // from "measured and scored zero" -- was previously coalesced to 0 at
  // write time, which made e.g. alphanumericAccuracy look like a real 0%
  // score when in fact no entity in the run was ever alphanumeric enough
  // to be scored at all (found 2026-08-24).
  wer: real("wer"),
  entityAccuracy: real("entity_accuracy"),
  alphanumericAccuracy: real("alphanumeric_accuracy"),
  latencyFirstPartialMs: real("latency_first_partial_ms"),
  latencyFinalMs: real("latency_final_ms"),
  costPerMinute: real("cost_per_minute"),
  diarizationScore: real("diarization_score"),
  recommendation: text("recommendation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertBenchmarkRankingSchema = createInsertSchema(
  benchmarkRankingsTable,
).omit({ id: true, createdAt: true });

export type InsertBenchmarkRanking = z.infer<
  typeof insertBenchmarkRankingSchema
>;
export type BenchmarkRankingRow =
  typeof benchmarkRankingsTable.$inferSelect;