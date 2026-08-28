import {
  integer,
  pgTable,
  text,
  timestamp,
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const insertBenchmarkProviderCallResultSchema = createInsertSchema(
  benchmarkProviderCallResultsTable,
).omit({ id: true, createdAt: true });

export type InsertBenchmarkProviderCallResult = z.infer<
  typeof insertBenchmarkProviderCallResultSchema
>;
export type BenchmarkProviderCallResultRow =
  typeof benchmarkProviderCallResultsTable.$inferSelect;
