// M-18 (PRD-v6 D4): the manual place counts.
//
// A person can write a gold transcript for a call in the gold editor, and
// until now nothing read what they produced. This is the one measurement on
// file that checks the cheap proxy against the expensive truth: on the calls
// somebody actually transcribed, does ranking by cross-provider disagreement
// put the providers in the same order as ranking by word error rate against
// that human transcript?
//
// Scope rules, all matching the ranking this is meant to be a check ON:
//   - a gold counts only when it is non-empty AND differs from the draft.
//     A draft copied into the gold field is not a person's work, and WER
//     against it measures agreement with Vapi, not with a human.
//   - "ok" cells only, and "batch" runs only. Agent-scan runs re-transcribe
//     a call to judge it and never feed a ranking, so counting them here
//     would compare against an ordering nobody is shown. Five such cells
//     exist on the two labelled calls today.
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import {
  db,
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkRunsTable,
  benchmarkScoresTable,
} from "@workspace/db";

import { aggregateProxyAgreement } from "./proxy-agreement-aggregate";

export type ProxyAgreement = {
  /** Calls a person wrote a gold for (gold non-empty and unlike the draft). */
  labelledCalls: number;
  /** Of those, the ones that could actually be ranked two ways. */
  n: number;
  top1Agreement: number | null;
  kendallTau: number | null;
};

const labelledCall = and(
  isNotNull(benchmarkCallsTable.goldTranscript),
  ne(benchmarkCallsTable.goldTranscript, ""),
  sql`${benchmarkCallsTable.goldTranscript} is distinct from ${benchmarkCallsTable.draftTranscript}`,
);

export async function proxyAgreement(): Promise<ProxyAgreement> {
  const [labelled] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(benchmarkCallsTable)
    .where(labelledCall);
  const labelledCalls = labelled?.count ?? 0;
  if (labelledCalls === 0) return { labelledCalls: 0, n: 0, top1Agreement: null, kendallTau: null };

  const rows = await db
    .select({
      callId: benchmarkProviderCallResultsTable.callId,
      providerId: benchmarkProviderCallResultsTable.providerId,
      wer: benchmarkScoresTable.wer,
      peerFlagCount: benchmarkScoresTable.peerFlagCount,
      peerFlagSeverity: benchmarkScoresTable.peerFlagSeverity,
    })
    .from(benchmarkProviderCallResultsTable)
    .innerJoin(benchmarkCallsTable, eq(benchmarkCallsTable.id, benchmarkProviderCallResultsTable.callId))
    .innerJoin(benchmarkRunsTable, eq(benchmarkRunsTable.id, benchmarkProviderCallResultsTable.runId))
    .innerJoin(benchmarkScoresTable, eq(benchmarkScoresTable.resultId, benchmarkProviderCallResultsTable.id))
    .where(
      and(
        labelledCall,
        eq(benchmarkProviderCallResultsTable.status, "ok"),
        eq(benchmarkRunsTable.purpose, "batch"),
      ),
    );

  return { labelledCalls, ...aggregateProxyAgreement(rows) };
}
