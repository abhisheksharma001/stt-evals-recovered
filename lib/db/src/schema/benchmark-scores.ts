import { integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { benchmarkProviderCallResultsTable } from "./benchmark-results";

// Scores are derived data, kept separate from the immutable raw result so
// re-scoring (new scoring_version) never touches the provider evidence
// (NFR-6: re-scoring from stored raw outputs must reproduce identical scores).
export const benchmarkScoresTable = pgTable("benchmark_scores", {
  id: uuid("id").primaryKey().defaultRandom(),
  resultId: uuid("result_id")
    .notNull()
    .references(() => benchmarkProviderCallResultsTable.id, {
      onDelete: "cascade",
    }),
  scoringVersion: text("scoring_version").notNull(),
  wer: real("wer"),
  entityAccuracy: real("entity_accuracy"),
  alphanumericAccuracy: real("alphanumeric_accuracy"),
  latencyFirstPartialMs: integer("latency_first_partial_ms"),
  latencyFinalMs: integer("latency_final_ms"),
  costPerMinute: real("cost_per_minute"),
  diarizationScore: real("diarization_score"),
  // 2026-08-27, per Abhishek: gold-transcript-free hybrid flagging (see
  // lib/scoring/src/hybrid.ts). wer/entityAccuracy above go permanently null
  // going forward (nothing to diff against without a gold transcript) --
  // these two are what Rankings now sorts by instead. flagSeverity is the
  // coarse "none"|"low"|"medium"|"high" from combineHybridFlags(); the full
  // structured breakdown (which words, which entities, whose confidence)
  // lives in `detail.hybridFlags` below, same pattern as wordDiff already did.
  flagCount: integer("flag_count"),
  flagSeverity: text("flag_severity"),
  // T-2 fix (2026-08-27, base-solidity review): only 3 of 7 providers
  // report per-word confidence at all, so folding confidence spans into
  // flagCount/flagSeverity above punished the providers honest enough to
  // expose their own uncertainty. peerFlagCount/peerFlagSeverity are the
  // confidence-free subset (cross-provider disagreement + entity mismatch,
  // both available for every provider) -- the RANKING composite in
  // run-executor.ts's computeRankingsForRun must read these, not the
  // columns above. flagCount/flagSeverity stay the full picture for
  // per-cell human review (see lib/scoring/src/hybrid.ts combineHybridFlags).
  peerFlagCount: integer("peer_flag_count"),
  peerFlagSeverity: text("peer_flag_severity"),
  detail: jsonb("detail").$type<Record<string, unknown>>(),
  scoredAt: timestamp("scored_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertBenchmarkScoreSchema = createInsertSchema(
  benchmarkScoresTable,
).omit({ id: true, scoredAt: true });

export type InsertBenchmarkScore = z.infer<typeof insertBenchmarkScoreSchema>;
export type BenchmarkScoreRow = typeof benchmarkScoresTable.$inferSelect;
