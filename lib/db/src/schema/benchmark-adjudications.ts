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
import { benchmarkCallsTable } from "./benchmark-calls";
import { benchmarkProvidersTable } from "./benchmark-providers";
import { benchmarkRunsTable } from "./benchmark-runs";

// T-08: a human's verdict on one disagreement span -- "I listened to these
// three seconds; THIS provider heard it right (or none of them did)."
//
// This is the only place in the system where a person, not a model and
// not a diff, says which transcript was correct. It is deliberately tiny
// in scope (one span, a few words) so that a verdict is a two-second
// listen rather than a full-transcript review, and so that twenty of them
// fit in one sitting. T-09 replays these through the judge to measure how
// often the judge agrees with a human; that is what `readings` is for --
// it snapshots exactly what each provider said for the span at the moment
// the human decided, so the replay is against the same evidence.
//
// A span is identified by (call, run, startMs, endMs): the same audio
// stretch, in the same run, is one decision. Re-adjudicating it replaces
// the earlier verdict (upsert on that key) rather than stacking a second
// one -- the audit log keeps the history.
export type AdjudicationReading = { providerId: string; text: string };

export const benchmarkAdjudicationsTable = pgTable(
  "benchmark_adjudications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id")
      .notNull()
      .references(() => benchmarkCallsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => benchmarkRunsTable.id, { onDelete: "cascade" }),
    // Milliseconds, integers: floats in a unique key are a footgun.
    spanStartMs: integer("span_start_ms").notNull(),
    spanEndMs: integer("span_end_ms").notNull(),
    // Null means "none of them heard it right" -- a real verdict, distinct
    // from "not adjudicated yet" (which is the absence of a row).
    correctProviderId: text("correct_provider_id").references(() => benchmarkProvidersTable.id),
    readings: jsonb("readings").$type<AdjudicationReading[]>().notNull().default([]),
    adjudicatedByLabel: text("adjudicated_by_label").notNull(),
    adjudicatedAt: timestamp("adjudicated_at", { withTimezone: true }).notNull().defaultNow(),
    // T-09: the judge's answer to the SAME question the human answered --
    // "given only these readings and a few words of context, which one is
    // right?" -- recorded once per verdict so the accuracy report never
    // re-spends OpenAI money on a span it has already replayed. All null
    // until the replay runs. `judgePickedProviderId` null after a replay
    // means the judge could not name any of the readings.
    judgePickedProviderId: text("judge_picked_provider_id").references(() => benchmarkProvidersTable.id),
    judgeReasoning: text("judge_reasoning"),
    judgeModel: text("judge_model"),
    judgePromptTokens: integer("judge_prompt_tokens"),
    judgeCompletionTokens: integer("judge_completion_tokens"),
    // Micro-cents (1 cent = 10,000), same unit and reason as
    // benchmark-agent-scans.ts (T-01: fractional cents in an integer column
    // silently destroyed rows). Null = not recorded, never "free".
    judgeCostMicrocents: integer("judge_cost_microcents"),
    judgeReplayedAt: timestamp("judge_replayed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("benchmark_adjudications_span_unique").on(
      table.callId,
      table.runId,
      table.spanStartMs,
      table.spanEndMs,
    ),
  ],
);

export const insertBenchmarkAdjudicationSchema = createInsertSchema(benchmarkAdjudicationsTable).omit({
  id: true,
  adjudicatedAt: true,
});

export type InsertBenchmarkAdjudication = z.infer<typeof insertBenchmarkAdjudicationSchema>;
export type BenchmarkAdjudicationRow = typeof benchmarkAdjudicationsTable.$inferSelect;
