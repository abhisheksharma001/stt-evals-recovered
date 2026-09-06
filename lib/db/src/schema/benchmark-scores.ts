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
  // M-10b (2026-09-07): the gap between the audio running out and the last
  // final transcript segment arriving. Streaming adapters only -- Cartesia
  // is the sole one today, so this is null on the other six by design, and
  // null (never 0) on a streaming cell where the anchors were not observed.
  //
  // Kept beside latencyFinalMs rather than folded into it on purpose.
  // latencyFinalMs is `finalAt - submittedAt`: file turnaround for a batch
  // adapter, the length of the call for a streaming one. M-10a took it out
  // of the ranking composite for exactly that ambiguity; giving it a third
  // meaning would repeat the mistake. This column means one thing.
  //
  // Not end-of-SPEECH latency: the anchor is the end of the recording, so
  // trailing silence counts against it. See lib/stt-providers/src/types.ts.
  latencyEndOfAudioMs: integer("latency_end_of_audio_ms"),
  // T-11 fix (2026-08-27, base-solidity review): costPerMinute above is
  // mislabeled -- it has always held the cost of THIS ONE CELL (provider
  // rate * this call's duration), not a per-minute rate, and that leaked
  // into the Rankings UI and CSV export under a "Cost/Min" header.
  // costMicrocents is the same underlying number, correctly named, and
  // denominated so it cannot round away. Added alongside rather than
  // replacing costPerMinute so nothing reading it today breaks -- full UI
  // rename tracked in docs/PRD-v3-uiux.md U-8.
  //
  // T-01 (2026-08-28): this was `cost_cents integer`, written as
  // Math.round(costForThisCell * 100). A typical cell costs ~0.92 cents, so
  // every cell was rounded to 1 -- an ~8% error compounding across every
  // cell in a bulk, in the number the whole cost comparison rests on. Now
  // micro-cents (1 cent = 10,000 microcents), the same unit the judge cost
  // uses, so the two are addable without a conversion in between.
  costPerMinute: real("cost_per_minute"),
  costMicrocents: integer("cost_microcents"),
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
