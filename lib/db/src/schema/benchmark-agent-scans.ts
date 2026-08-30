import {
  integer,
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
  /** T-102: which hybrid signal raised it, so the judge can weigh it. Absent on rows written before 2026-08-30. */
  kind?: "peer_disagreement" | "low_confidence" | "entity_mismatch";
};

// 2026-08-27, per Abhishek ("we don't need a gold transcript any more ...
// make agent system better ... use a hybrid system"): a scan no longer
// requires (or produces) a gold transcript. It now runs the gold-free
// hybrid pipeline (lib/scoring/src/hybrid.ts: cross-provider disagreement +
// provider-native confidence + domain-entity cross-check) across whatever
// candidate transcripts already exist for the call, and only calls an LLM
// to explain the flags the hybrid pass actually found -- see routes/agent.ts.
export type BenchmarkHybridFlagSummary = {
  flagCount: number;
  flagSeverity: "none" | "low" | "medium" | "high";
  crossProviderDisagreements: Array<{ providerId: string; disagreementRate: number }>;
  lowConfidenceSpans: Record<string, Array<{ words: string[]; avgConfidence: number; severity: string }>>;
  // T-3 (base-solidity fix): missingProviderIds carries which candidates
  // said NOTHING of this entity type while the others agreed on a value --
  // a distinct failure mode from valuesByProvider's conflicting values.
  entityMismatches: Array<{ type: string; valuesByProvider: Record<string, string[]>; missingProviderIds: string[] }>;
};

// An "agent scan" is a per-call quality check -- requested by Abhishek
// 2026-08-25, reworked 2026-08-27 to be gold-free. Deliberately on-demand (a
// human picks the call and triggers it), not automatic on every import: the
// LLM-explanation step (fired only when the free hybrid pass already found
// something) still has a real cost, and the flow should prove out before it
// runs unattended on every call.
//
// `agentPickResultId`/`agentPickReasoning` are the LLM's opinion on which
// candidate looks most correct given the flags -- still only ever a
// SUGGESTION (matches the standing draft != gold rule, .claude/CLAUDE.md).
// It no longer writes anywhere on approval (there is no gold field left to
// write) -- approve/reject are now purely an audit trail of whether a human
// looked at the flag and agreed with it.
export const benchmarkAgentScansTable = pgTable("benchmark_agent_scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  callId: uuid("call_id")
    .notNull()
    .references(() => benchmarkCallsTable.id, { onDelete: "cascade" }),
  // Vapi's own draft transcript at scan time, kept for context in the UI
  // only -- no longer required to trigger a scan (the hybrid pass compares
  // candidates to each other, not to this). Null when the call has no draft
  // on file at all.
  sourceLabel: text("source_label"), // "draft" | null
  sourceTranscript: text("source_transcript"),
  // scanning | clean | flagged | error
  status: text("status").notNull().default("scanning"),
  // Legacy LLM-only flag shape (pre-2026-08-27 scans) -- still populated
  // going forward as the LLM's plain-English restatement of the hybrid
  // flags, so the UI has one consistent {text, reason} list to render
  // regardless of which pass produced it.
  flags: jsonb("flags").$type<BenchmarkAgentFlag[]>().notNull().default([]),
  // The structured, gold-free hybrid result (always populated once a scan
  // finishes, whether or not an LLM explanation was warranted).
  hybridFlags: jsonb("hybrid_flags").$type<BenchmarkHybridFlagSummary | null>(),
  // The scoped, single-call benchmark run spawned to re-transcribe when
  // flags are found (null when clean -- no re-transcription needed). Reuses
  // the exact same run-executor/provider-adapter/scoring pipeline the Runs
  // page uses; this table never talks to a provider directly.
  runId: uuid("run_id").references(() => benchmarkRunsTable.id),
  agentPickResultId: uuid("agent_pick_result_id").references(
    () => benchmarkProviderCallResultsTable.id,
  ),
  agentPickReasoning: text("agent_pick_reasoning"),
  // 2026-08-27, per Abhishek: track the real OpenAI cost of the judge call
  // (null on "clean" scans, which never call the LLM at all) so bulk/results
  // cost breakdowns can show real agent spend, not just STT spend. Captured
  // from the OpenAI response's own `usage` block in lib/agent.ts -- not
  // estimated after the fact.
  //
  // T-01 (2026-08-28): this column was `judge_cost_cents integer` and it
  // destroyed every judgement the system ever made. A real judge call costs
  // a FRACTION of a cent (0.4905 observed live), Postgres rejected the
  // insert, and the catch in agent-verify.ts read that write failure as a
  // JUDGE failure -- so the model's actual answer was discarded and an
  // "error" row written instead. 63/63 scans in bulk 7d2585da, ~31c of real
  // OpenAI spend, reported to the user as $0.00. Denominated in MICRO-CENTS
  // now (1 cent = 10,000 microcents): an integer unit small enough that no
  // real judge call ever rounds to zero, and no float ever reaches the DB.
  // Format at the edge, never here.
  judgePromptTokens: integer("judge_prompt_tokens"),
  judgeCompletionTokens: integer("judge_completion_tokens"),
  judgeCostMicrocents: integer("judge_cost_microcents"),
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
