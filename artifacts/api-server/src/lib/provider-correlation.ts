// T-18: per-bulk provider correlation. Reads every ok cell of the bulk's
// runs and hands the transcripts to the pure scorer in @workspace/scoring.
import { and, eq, inArray } from "drizzle-orm";
import {
  benchmarkProviderCallResultsTable,
  benchmarkProvidersTable,
  benchmarkRunsTable,
  db,
} from "@workspace/db";
import {
  computeProviderCorrelation,
  CORRELATED_EXCESS_AGREEMENT,
  type CorrelationCall,
} from "@workspace/scoring";

export type BulkProviderCorrelation = {
  bulkId: string;
  callCount: number;
  providers: { id: string; name: string }[];
  pairs: { providerAId: string; providerBId: string; sharedCalls: number; agreement: number | null; excessAgreement: number | null }[];
  correlatedExcessAgreement: number;
};

export async function bulkProviderCorrelation(bulkId: string): Promise<BulkProviderCorrelation> {
  const runs = await db
    .select({ id: benchmarkRunsTable.id })
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.bulkId, bulkId));
  const runIds = runs.map((r) => r.id);

  const rows = runIds.length
    ? await db
        .select({
          callId: benchmarkProviderCallResultsTable.callId,
          providerId: benchmarkProviderCallResultsTable.providerId,
          transcript: benchmarkProviderCallResultsTable.hypothesisTranscript,
        })
        .from(benchmarkProviderCallResultsTable)
        .where(
          and(
            inArray(benchmarkProviderCallResultsTable.runId, runIds),
            eq(benchmarkProviderCallResultsTable.status, "ok"),
          ),
        )
    : [];

  const byCall = new Map<string, CorrelationCall>();
  for (const row of rows) {
    if (!row.transcript) continue;
    const call = byCall.get(row.callId) ?? { callId: row.callId, transcripts: [] };
    call.transcripts.push({ providerId: row.providerId, transcript: row.transcript });
    byCall.set(row.callId, call);
  }

  const correlation = computeProviderCorrelation([...byCall.values()]);
  const providerRows = correlation.providerIds.length
    ? await db
        .select({ id: benchmarkProvidersTable.id, name: benchmarkProvidersTable.name })
        .from(benchmarkProvidersTable)
        .where(inArray(benchmarkProvidersTable.id, correlation.providerIds))
    : [];
  const nameById = new Map(providerRows.map((p) => [p.id, p.name]));

  return {
    bulkId,
    callCount: correlation.callCount,
    providers: correlation.providerIds.map((id) => ({ id, name: nameById.get(id) ?? id })),
    pairs: correlation.pairs,
    correlatedExcessAgreement: CORRELATED_EXCESS_AGREEMENT,
  };
}
