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
  // T-1 fix (2026-08-27, base-solidity review): a bulk shards its call set
  // into many runs (default 50 calls/shard), and rankings were previously
  // computed and stored PER RUN -- a 1,000-call bulk wrote 20 competing
  // ranking sets, and GET /benchmark/rankings picked whichever run happened
  // to have the newest createdAt (effectively arbitrary, since all 20 shards
  // fire within milliseconds of each other), showing 50 calls of evidence
  // out of 1,000. bulkId is populated (and runId left null) for rankings
  // computed at bulk scope by computeRankingsForBulk() in run-executor.ts;
  // runId stays populated for ad-hoc (non-bulk) run rankings, unchanged.
  bulkId: uuid("bulk_id"),
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
  // 2026-08-27, per Abhishek: gold-transcript-free hybrid flagging replaces
  // wer/entityAccuracy as the primary ranking signal (see
  // lib/scoring/src/hybrid.ts and run-executor.ts's computeRankingsForRun).
  // wer/entityAccuracy above go permanently null going forward; kept as
  // columns (not dropped) so a historical run computed before this change
  // stays inspectable. avgFlagSeverityScore is severityRank() averaged
  // across the provider's cells in this group (0=none .. 3=high) -- a
  // single number the composite can weight even though flagSeverity itself
  // is categorical per cell.
  avgFlagCount: real("avg_flag_count"),
  avgFlagSeverityScore: real("avg_flag_severity_score"),
  // T-2 fix: the composite ranking score must be built from PEER-only
  // badness (confidence spans excluded -- see benchmark-scores.ts's
  // peerFlagCount comment). avgFlagCount/avgFlagSeverityScore above stay as
  // the full picture for display; these two feed hybridCompositeScore.
  avgPeerFlagCount: real("avg_peer_flag_count"),
  avgPeerFlagSeverityScore: real("avg_peer_flag_severity_score"),
  // T-19: rates, so two providers (or two bulks) with different call
  // lengths compare. peerFlagsPer100Words = total peer flags / total words
  // this provider transcribed in the group x 100 (peer-only, same basis as
  // the composite). cleanCallRate = share of this provider's scored calls
  // with zero peer flags, 0..1. Null when nothing was scored -- never 0.
  peerFlagsPer100Words: real("peer_flags_per_100_words"),
  cleanCallRate: real("clean_call_rate"),
  // T-1: how many distinct calls actually scored ok and fed this row --
  // lets the UI show real evidence size instead of just a rank.
  callsScored: integer("calls_scored"),
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