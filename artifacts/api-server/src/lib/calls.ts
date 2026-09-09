// T-79 (J.1): route handlers move their queries into lib/ as they are
// touched for another reason -- this one moved with T-124, which touched
// the calls-list handler to decorate rows with audio-cache state.
import { and, desc, eq, inArray } from "drizzle-orm";
import { benchmarkCallsTable, benchmarkProviderCallResultsTable, db } from "@workspace/db";

export type ListBenchmarkCallsFilter = {
  vertical?: string;
  status?: string;
};

/** Every corpus call, newest first, optionally narrowed by vertical and/or
 * status -- exactly the read GET /benchmark/calls has always done. */
export async function listBenchmarkCallRows(filter: ListBenchmarkCallsFilter = {}) {
  const conditions = [
    filter.vertical ? eq(benchmarkCallsTable.vertical, filter.vertical) : undefined,
    filter.status ? eq(benchmarkCallsTable.status, filter.status) : undefined,
  ].filter((condition) => condition !== undefined);

  return conditions.length > 0
    ? db
        .select()
        .from(benchmarkCallsTable)
        .where(and(...conditions))
        .orderBy(desc(benchmarkCallsTable.createdAt))
    : db.select().from(benchmarkCallsTable).orderBy(desc(benchmarkCallsTable.createdAt));
}

/**
 * The ids of every call at least one provider has transcribed -- one
 * `select distinct` for the whole response, in the same shape as T-124's
 * readdir of the audio cache, not one query per row.
 *
 * "Has a provider result row" is the honest reading of *benchmarked*, and it
 * is deliberately not "has an agent scan": 131 calls carry a result and 124
 * carry a scan (read live 2026-09-09), so the scan misses 7 that were run.
 * A failed cell still counts -- the call went through a run, and what came
 * back is the run's answer, not a reason to call the call untouched.
 */
export async function listBenchmarkedCallIds(callIds: string[]): Promise<Set<string>> {
  // No empty-list guard: `inArray(col, [])` returns no rows rather than
  // throwing, checked against the driver 2026-09-09 after the break test
  // removed the guard and nothing failed.
  const rows = await db
    .selectDistinct({ callId: benchmarkProviderCallResultsTable.callId })
    .from(benchmarkProviderCallResultsTable)
    .where(inArray(benchmarkProviderCallResultsTable.callId, callIds));
  return new Set(rows.map((row) => row.callId));
}
