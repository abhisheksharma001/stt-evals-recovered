import {
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
// The failure taxonomy lives beside the code that produces it
// (lib/stt-providers/src/failure-class.ts) so there is exactly one list.
// That package has no runtime dependencies and is consumed as source, so
// importing its type here costs nothing at run time.
import type { FailureClass } from "@workspace/stt-providers";
import { z } from "zod/v4";
import { benchmarkCallsTable } from "./benchmark-calls";
import { benchmarkProvidersTable } from "./benchmark-providers";
import { benchmarkRunsTable } from "./benchmark-runs";

// One row per (run, provider, call) cell. Raw provider output is stored
// verbatim and immutably -- scoring can always be recomputed from here
// without re-calling the provider (FR-REP2, FR-E1).
export const benchmarkProviderCallResultsTable = pgTable(
  "benchmark_provider_call_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => benchmarkRunsTable.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => benchmarkProvidersTable.id),
    callId: uuid("call_id")
      .notNull()
      .references(() => benchmarkCallsTable.id),
    status: text("status").notNull().default("pending"), // pending | ok | failed
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    firstPartialAt: timestamp("first_partial_at", { withTimezone: true }),
    finalAt: timestamp("final_at", { withTimezone: true }),
    httpStatus: integer("http_status"),
    hypothesisTranscript: text("hypothesis_transcript"),
    rawOutput: text("raw_output"), // provider JSON verbatim, stringified
    rawOutputHash: text("raw_output_hash"),
    errorMessage: text("error_message"),
    // T-06: WHY this cell failed, as decided by the code that saw the
    // failure happen -- never inferred afterwards from errorMessage. Null
    // on success, and also null on rows written before this column existed
    // (those predate classification and must not be back-guessed).
    //
    // Stored as text rather than a Postgres enum on purpose: adding a class
    // is then a code change and a deploy, not a migration that has to land
    // in lockstep with it. The value set is enforced by the TypeScript
    // union here and by the enum in openapi.yaml at the API boundary.
    failureClass: text("failure_class").$type<FailureClass>(),
    // 2026-08-26, per Abhishek: a lot of cells were failing and the raw
    // errorMessage alone (an HTTP status, a vendor error string) wasn't
    // enough to act on. On-demand only (POST .../analyze-failure) -- an
    // OpenAI call per click, not run automatically on every failure.
    // Persisted so it survives a page refresh and isn't recomputed (and
    // re-billed) every time the row is viewed.
    failureDiagnosis: text("failure_diagnosis"),
    failureSuggestedFix: text("failure_suggested_fix"),
    // M-5 (2026-09-05): WHICH audio channel this cell was transcribed from
    // -- "customer" = the caller-only track rescued from Vapi's artifact,
    // "mono" = the mixed track, 71% of whose words are the assistant's own
    // TTS voice. Recorded by the executor at read time from the file it
    // actually opened, never inferred later from what happens to be on disk
    // now (a customer file can be added after a run).
    //
    // Null on every row written before this column existed. Null is NOT
    // "unknown pending investigation": those rows are all mono, because the
    // customer channel did not exist as a concept when they ran -- readers
    // treat null as "mono" and say so where they do it.
    //
    // Text, not a Postgres enum, for the same reason failureClass is (see
    // above): adding a channel is a code change, not a lockstep migration.
    audioSource: text("audio_source").$type<"customer" | "mono">(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // T-27: one row per cell, enforced by the database rather than by the
    // executor remembering to clean up. Every writer goes through
    // upsertResult() in run-executor.ts, so a second attempt at the same
    // (run, call, provider) replaces the first row in place instead of
    // stacking a duplicate next to it -- the failure mode found live on
    // 2026-08-25, and the one a concurrent double-execution of a run
    // (documented gap, no durable job queue) would otherwise reintroduce.
    uniqueIndex("benchmark_provider_call_results_cell_key").on(
      table.runId,
      table.callId,
      table.providerId,
    ),
  ],
);

export const insertBenchmarkProviderCallResultSchema = createInsertSchema(
  benchmarkProviderCallResultsTable,
).omit({ id: true, createdAt: true });

export type InsertBenchmarkProviderCallResult = z.infer<
  typeof insertBenchmarkProviderCallResultSchema
>;
export type BenchmarkProviderCallResultRow =
  typeof benchmarkProviderCallResultsTable.$inferSelect;
