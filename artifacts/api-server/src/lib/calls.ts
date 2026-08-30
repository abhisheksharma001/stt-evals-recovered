// T-79 (J.1): route handlers move their queries into lib/ as they are
// touched for another reason -- this one moved with T-124, which touched
// the calls-list handler to decorate rows with audio-cache state.
import { and, desc, eq } from "drizzle-orm";
import { benchmarkCallsTable, db } from "@workspace/db";

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
