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
