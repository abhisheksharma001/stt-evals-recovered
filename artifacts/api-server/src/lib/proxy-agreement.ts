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
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import {
  db,
  benchmarkAgentScansTable,
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkRunsTable,
  benchmarkScoresTable,
} from "@workspace/db";

import {
  aggregateJudgeAccuracy,
  aggregateProxyAgreement,
  type JudgePickRow,
} from "./proxy-agreement-aggregate";

export type ProxyAgreement = {
  /** Calls a person wrote a gold for (gold non-empty and unlike the draft). */
  labelledCalls: number;
  /** Of those, the ones that could actually be ranked two ways. */
  n: number;
  top1Agreement: number | null;
  kendallTau: number | null;
  /** M-20: of the labelled calls, the ones where the judge made a pick that
   *  could be measured against the human transcript. */
  judgePicks: number;
  /** Share of those where the judge picked a lowest-WER provider. Null at 0. */
  judgeTop1Agreement: number | null;
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
  if (labelledCalls === 0) {
    return { labelledCalls: 0, n: 0, top1Agreement: null, kendallTau: null, judgePicks: 0, judgeTop1Agreement: null };
  }

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

  return { labelledCalls, ...aggregateProxyAgreement(rows), ...(await judgeAccuracy()) };
}

/**
 * M-20: the judge's pick against the human transcript, on the labelled calls.
 *
 * The latest picking scan per call, not the latest scan: a call rescanned
 * after a re-run can end on a scan that found nothing to judge, and reading
 * that one would drop a measurement a person's work paid for. "Latest" is
 * still by created_at, so a re-judgement replaces an older one.
 */
async function judgeAccuracy(): Promise<{ judgePicks: number; judgeTop1Agreement: number | null }> {
  const scans = await db
    .select({
      callId: benchmarkAgentScansTable.callId,
      createdAt: benchmarkAgentScansTable.createdAt,
      pickResultId: benchmarkAgentScansTable.agentPickResultId,
    })
    .from(benchmarkAgentScansTable)
    .innerJoin(benchmarkCallsTable, eq(benchmarkCallsTable.id, benchmarkAgentScansTable.callId))
    .where(and(labelledCall, isNotNull(benchmarkAgentScansTable.agentPickResultId)));

  const latest = new Map<string, { pickResultId: string; at: Date }>();
  for (const scan of scans) {
    const held = latest.get(scan.callId);
    if (!held || held.at < scan.createdAt) {
      latest.set(scan.callId, { pickResultId: scan.pickResultId!, at: scan.createdAt });
    }
  }
  if (latest.size === 0) return { judgePicks: 0, judgeTop1Agreement: null };

  // The picked cell names both the provider the judge chose and the run whose
  // cells were the candidates it chose among.
  const picks = await db
    .select({
      resultId: benchmarkProviderCallResultsTable.id,
      runId: benchmarkProviderCallResultsTable.runId,
      providerId: benchmarkProviderCallResultsTable.providerId,
    })
    .from(benchmarkProviderCallResultsTable)
    .where(inArray(benchmarkProviderCallResultsTable.id, [...latest.values()].map((v) => v.pickResultId)));
  const pickByResultId = new Map(picks.map((p) => [p.resultId, p]));

  const rows: JudgePickRow[] = [];
  for (const [callId, { pickResultId }] of latest) {
    const pick = pickByResultId.get(pickResultId);
    if (!pick) continue;
    const candidates = await db
      .select({
        providerId: benchmarkProviderCallResultsTable.providerId,
        wer: benchmarkScoresTable.wer,
      })
      .from(benchmarkProviderCallResultsTable)
      .innerJoin(benchmarkScoresTable, eq(benchmarkScoresTable.resultId, benchmarkProviderCallResultsTable.id))
      .where(
        and(
          eq(benchmarkProviderCallResultsTable.runId, pick.runId),
          eq(benchmarkProviderCallResultsTable.callId, callId),
          eq(benchmarkProviderCallResultsTable.status, "ok"),
        ),
      );
    for (const candidate of candidates) {
      rows.push({ callId, pickedProviderId: pick.providerId, ...candidate });
    }
  }

  const figures = aggregateJudgeAccuracy(rows);
  return { judgePicks: figures.n, judgeTop1Agreement: figures.top1Agreement };
}
