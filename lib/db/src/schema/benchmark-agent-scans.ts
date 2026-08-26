import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { benchmarkCallsTable } from "./benchmark-calls";
import { benchmarkProviderCallResultsTable } from "./benchmark-results";
import { benchmarkRunsTable } from "./benchmark-runs";

export type BenchmarkAgentFlag = {
  text: string;
  reason: string;
};

// An "agent scan" is an LLM read of a call's current best transcript, looking
// for spans that read as wrong (garbled, out of context, doesn't fit) --
// requested by Abhishek 2026-08-25. Deliberately on-demand (a human picks the
// call and triggers it), not automatic on every import: real OpenAI + real
// STT-provider cost per scan, and the flow should prove out before it runs
// unattended on every call.
//
// CRITICAL, matches the standing draft != gold rule (see .claude/CLAUDE.md):
// this table's `agentPickResultId` is a SUGGESTION, never a write to
// benchmarkCallsTable.goldTranscript on its own. Only a human, via the
// approve route (which drives the exact same PATCH /benchmark/calls logic
// and de-id gate as manual review), can turn a pick into gold. An LLM
// picking "the most sensible transcript" is exactly the same bias risk as
// trusting one vendor's draft -- it doesn't get a silent pass just because
// the picker is an LLM instead of a person.
export const benchmarkAgentScansTable = pgTable("benchmark_agent_scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  callId: uuid("call_id")
    .notNull()
    .references(() => benchmarkCallsTable.id, { onDelete: "cascade" }),
  // Which transcript field was read, and a verbatim copy of it at scan time
  // -- so the scan record stays reproducible even if goldTranscript or
  // draftTranscript changes later (FR-REP2-style: don't rely on a mutable
  // FK for what was actually judged).
  sourceLabel: text("source_label").notNull(), // "gold" | "draft"
  sourceTranscript: text("source_transcript").notNull(),
  // scanning | clean | flagged | error
  status: text("status").notNull().default("scanning"),
  flags: jsonb("flags").$type<BenchmarkAgentFlag[]>().notNull().default([]),
  // The scoped, single-call benchmark run spawned to re-transcribe when
  // flags are found (null when clean -- no re-transcription needed). Reuses
  // the exact same run-executor/provider-adapter/scoring pipeline the Runs
  // page uses; this table never talks to a provider directly.
  runId: uuid("run_id").references(() => benchmarkRunsTable.id),
  agentPickResultId: uuid("agent_pick_result_id").references(
    () => benchmarkProviderCallResultsTable.id,
  ),
  agentPickReasoning: text("agent_pick_reasoning"),
  errorMessage: text("error_message"),
  requestedByLabel: text("requested_by_label").notNull(),
  // Set only via the approve/reject routes -- never by the scan itself.
  decidedByLabel: text("decided_by_label"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertBenchmarkAgentScanSchema = createInsertSchema(
  benchmarkAgentScansTable,
).omit({ id: true, createdAt: true });

export type InsertBenchmarkAgentScan = z.infer<
  typeof insertBenchmarkAgentScanSchema
>;
export type BenchmarkAgentScanRow =
  typeof benchmarkAgentScansTable.$inferSelect;
