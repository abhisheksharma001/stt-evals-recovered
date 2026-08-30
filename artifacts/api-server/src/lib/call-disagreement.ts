// T-85: worst-first ordering. One number per call -- how much the
// providers disagreed on it -- so a reviewer opens the ugliest call first
// (Hamel & Shreya, "sort by score, look at the best and worst").
//
// Definition: sum of peerFlagCount over every ok, scored cell for the call
// (cross-provider disagreement + entity mismatches; a provider's own
// low-confidence spans excluded, same basis as Rank and the verdict). Scope
// is one bulk's runs when bulkId is given, otherwise every real (purpose "batch") run; agent scans never count.
// A call with no scored cell is absent from the list -- "no data" must not
// read as "zero disagreement", so the client sorts absent calls last.
import { and, eq, inArray } from "drizzle-orm";
import { db, benchmarkProviderCallResultsTable, benchmarkRunsTable, benchmarkScoresTable } from "@workspace/db";
import { aggregateDisagreement, type CallDisagreement } from "./call-disagreement-aggregate";

export type { CallDisagreement, CallDisagreementRow } from "./call-disagreement-aggregate";

export async function callDisagreement(bulkId: string | null): Promise<{ bulkId: string | null; calls: CallDisagreement[] }> {
  const runs = await db
    .select({ id: benchmarkRunsTable.id })
    .from(benchmarkRunsTable)
    .where(
      bulkId
        ? and(eq(benchmarkRunsTable.bulkId, bulkId), eq(benchmarkRunsTable.purpose, "batch"))
        : eq(benchmarkRunsTable.purpose, "batch"),
    );
  if (runs.length === 0) return { bulkId, calls: [] };
  const rows = await db
    .select({
      callId: benchmarkProviderCallResultsTable.callId,
      providerId: benchmarkProviderCallResultsTable.providerId,
      peerFlagCount: benchmarkScoresTable.peerFlagCount,
    })
    .from(benchmarkProviderCallResultsTable)
    .innerJoin(benchmarkScoresTable, eq(benchmarkScoresTable.resultId, benchmarkProviderCallResultsTable.id))
    .where(
      and(
        inArray(benchmarkProviderCallResultsTable.runId, runs.map((r) => r.id)),
        eq(benchmarkProviderCallResultsTable.status, "ok"),
      ),
    );
  return { bulkId, calls: aggregateDisagreement(rows) };
}
