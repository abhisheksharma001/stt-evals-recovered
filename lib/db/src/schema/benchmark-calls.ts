import {
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type BenchmarkEntityType =
  | "ro_number"
  | "unit_number"
  | "vin"
  | "phone_number"
  | "name"
  | "address"
  | "load_number"
  | "city";

export type BenchmarkEntityReference = {
  type: BenchmarkEntityType;
  value: string;
};

export const benchmarkCallsTable = pgTable("benchmark_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label").notNull(),
  vertical: text("vertical").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  status: text("status").notNull().default("needs_review"),
  hardCases: jsonb("hard_cases").$type<string[]>().notNull().default([]),
  goldTranscript: text("gold_transcript"),
  // The source provider's own transcript, kept verbatim as the reviewer's
  // starting point and as the left-hand side of the review diff. It is NEVER
  // the reference a run is scored against -- that is goldTranscript, and only
  // a human writes it (GOLD-01). Stored in its own column rather than folded
  // into entityNotes so the review UI can diff it without parsing prose.
  draftTranscript: text("draft_transcript"),
  entityNotes: text("entity_notes"),
  // Structured entity spans (FR-S2) used as scoring input -- distinct from
  // entityNotes, which stays free-text curator commentary.
  entityReferences: jsonb("entity_references")
    .$type<BenchmarkEntityReference[]>()
    .notNull()
    .default([]),
  audioObjectPath: text("audio_object_path"),
  // Provenance of the recording (COR-01). `sourceProvider` is "vapi" for
  // anything pulled by the importer and "manual" for hand-registered calls.
  // `sourceCallId` is the upstream provider's own call id -- unique per
  // (sourceProvider, sourceCallId) so re-running an import over an
  // overlapping date range can't create duplicate corpus entries.
  // `sourceAccountLabel` records WHICH Vapi account the call came from
  // (the team runs several); it is the account's label, never its API key.
  sourceProvider: text("source_provider").notNull().default("manual"),
  sourceCallId: text("source_call_id"),
  sourceAccountLabel: text("source_account_label"),
  sourceAssistantId: text("source_assistant_id"),
  sourceStartedAt: timestamp("source_started_at", { withTimezone: true }),
  // Which STT model actually produced draftTranscript, read from Vapi's own
  // assistant config at import time (best-effort -- Vapi's public schema
  // does not guarantee this is populated on every call; null just means we
  // don't know). This exists to catch a specific bias risk: if the provider
  // that generated the draft is also one of the providers being benchmarked,
  // a reviewer who starts from that draft is unconsciously anchored toward
  // that provider's own error patterns before scoring even begins. Nothing
  // reads this to change behavior yet -- it's forensic, surfaced in Review so
  // a human can judge it themselves (see docs/backlog/good-to-have.md).
  sourceTranscriberProvider: text("source_transcriber_provider"),
  sourceTranscriberModel: text("source_transcriber_model"),
  // T-11: Vapi's `endedReason` and `analysis.successEvaluation`, verbatim.
  // Null means "not captured" (imported before T-11, or Vapi omitted it) --
  // it must never be read as "normal call". successEvaluation is stored as
  // the raw string ("true"/"false" today) so a wider vocabulary later
  // loses nothing.
  sourceEndedReason: text("source_ended_reason"),
  sourceSuccessEvaluation: text("source_success_evaluation"),
  // De-identification attestation (FR-C3/G6): two distinct approvers are
  // required before a call may reach ready_to_run. No auth system exists
  // yet, so approvers are recorded as free-text labels via the x-actor
  // header rather than a users.id FK.
  deIdAttestedByLabel: text("de_id_attested_by_label"),
  deIdAttestedAt: timestamp("de_id_attested_at", { withTimezone: true }),
  deIdSecondApproverLabel: text("de_id_second_approver_label"),
  deIdSecondApprovedAt: timestamp("de_id_second_approved_at", {
    withTimezone: true,
  }),
  // T-131: the last audio-cache ATTEMPT's outcome (rescue or import-time
  // caching -- lib/audio-attempt.ts). Distinct from "is the audio cached"
  // (a disk fact, never stored here): this exists so an uncached call whose
  // source has permanently refused the recording ("source_refused") stops
  // counting as a chore a person could still clear. Null = never attempted
  // by a recorder (or predates T-131).
  audioCacheLastOutcome: text("audio_cache_last_outcome").$type<
    "saved" | "failed" | "source_refused"
  >(),
  audioCacheLastError: text("audio_cache_last_error"),
  audioCacheLastAttemptAt: timestamp("audio_cache_last_attempt_at", {
    withTimezone: true,
  }),
  // M-7a: what PRODUCTION's own pipeline measured on this call, read from
  // Vapi's `artifact.performanceMetrics` at import and from the saved
  // `<callId>.artifact.json` by the backfill -- lib/production-signals.ts is
  // the only writer of all four. Null means "not measured", and it is not the
  // same thing as zero: 23 of the first 100 saved artifacts report a
  // transcriber latency of 0 with an empty `turnLatencies` array (nothing was
  // timed), and `numAssistantInterrupted` is absent altogether on 53 of them.
  // A 0 stored here would be read as a fast call and a calm call. Tool calls
  // are the exception: `messages` is present on every artifact, so an empty
  // one is a real zero and is stored as 0.
  prodTranscriberLatencyMs: real("prod_transcriber_latency_ms"),
  prodEndpointingLatencyMs: real("prod_endpointing_latency_ms"),
  prodAssistantInterruptions: integer("prod_assistant_interruptions"),
  prodToolCalls: integer("prod_tool_calls"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  // Postgres treats NULLs as distinct in a unique index, so manually
  // registered calls (sourceCallId IS NULL) are unaffected by this.
  uniqueIndex("benchmark_calls_source_unique").on(
    table.sourceProvider,
    table.sourceCallId,
  ),
]);

export const insertBenchmarkCallSchema = createInsertSchema(
  benchmarkCallsTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertBenchmarkCall = z.infer<typeof insertBenchmarkCallSchema>;
export type BenchmarkCallRow = typeof benchmarkCallsTable.$inferSelect;