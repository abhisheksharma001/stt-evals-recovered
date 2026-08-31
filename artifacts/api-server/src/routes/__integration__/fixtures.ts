// T-157: shared seed builders for the read-route integration suites. Every
// row a builder inserts is tagged with the fixture's random suffix and
// remembered by id; cleanup() deletes them in FK order and nothing else --
// the test database is shared across suite files (fileParallelism: false,
// but leftovers from a crashed earlier run are possible), so suites assert
// deltas or containment on their own rows, never exact global counts.
//
// The riskiest-endpoints suite predates this file and keeps its own inline
// seeding on purpose: it is green and its rows are shaped around the write
// paths it exercises. New read-route suites start here instead.
import { inArray } from "drizzle-orm";
import {
  benchmarkAgentScansTable,
  benchmarkBulksTable,
  benchmarkCallsTable,
  benchmarkProvidersTable,
  benchmarkProviderCallResultsTable,
  benchmarkRankingsTable,
  benchmarkRunsTable,
  benchmarkScoresTable,
  db,
} from "@workspace/db";

type ProviderRow = typeof benchmarkProvidersTable.$inferSelect;
type CallRow = typeof benchmarkCallsTable.$inferSelect;
type RunRow = typeof benchmarkRunsTable.$inferSelect;
type BulkRow = typeof benchmarkBulksTable.$inferSelect;
type ResultRow = typeof benchmarkProviderCallResultsTable.$inferSelect;
type ScoreRow = typeof benchmarkScoresTable.$inferSelect;
type RankingRow = typeof benchmarkRankingsTable.$inferSelect;
type ScanRow = typeof benchmarkAgentScansTable.$inferSelect;

export class Fixtures {
  readonly suffix = Math.random().toString(16).slice(2, 10);

  private providerIds: string[] = [];
  private callIds: string[] = [];
  private runIds: string[] = [];
  private bulkIds: string[] = [];
  private rankingIds: string[] = [];

  /** Providers get ids no adapter matches, so syncProviderReadiness derives
   *  them straight to "not_configured" and no provider API can ever be hit. */
  async provider(overrides: Partial<typeof benchmarkProvidersTable.$inferInsert> = {}): Promise<ProviderRow> {
    const [row] = await db
      .insert(benchmarkProvidersTable)
      .values({
        id: `fx-${this.suffix}-${this.providerIds.length}`,
        name: `fixture provider ${this.suffix}`,
        model: "none",
        status: "not_configured",
        ...overrides,
      })
      .returning();
    this.providerIds.push(row.id);
    return row;
  }

  async call(overrides: Partial<typeof benchmarkCallsTable.$inferInsert> = {}): Promise<CallRow> {
    const [row] = await db
      .insert(benchmarkCallsTable)
      .values({
        label: `fx-call-${this.suffix}-${this.callIds.length}`,
        vertical: "property_management",
        durationSeconds: 30,
        status: "ready_to_run",
        ...overrides,
      })
      .returning();
    this.callIds.push(row.id);
    return row;
  }

  async run(overrides: Partial<typeof benchmarkRunsTable.$inferInsert> = {}): Promise<RunRow> {
    const [row] = await db
      .insert(benchmarkRunsTable)
      .values({
        status: "complete",
        purpose: "batch",
        providerIds: [],
        callIds: [],
        callCount: 0,
        ...overrides,
      })
      .returning();
    this.runIds.push(row.id);
    return row;
  }

  async bulk(overrides: Partial<typeof benchmarkBulksTable.$inferInsert> = {}): Promise<BulkRow> {
    const [row] = await db
      .insert(benchmarkBulksTable)
      .values({
        name: `fx-bulk-${this.suffix}-${this.bulkIds.length}`,
        status: "complete",
        selectionCriteria: { resolvedCallIds: [] },
        providerIds: [],
        shardSize: 50,
        minDurationSeconds: 0,
        ...overrides,
      })
      .returning();
    this.bulkIds.push(row.id);
    return row;
  }

  /** A result cell. Deleting the run cascades the cell; deleting the cell
   *  cascades its score -- so neither is tracked separately. */
  async result(
    runId: string,
    callId: string,
    providerId: string,
    overrides: Partial<typeof benchmarkProviderCallResultsTable.$inferInsert> = {},
  ): Promise<ResultRow> {
    const [row] = await db
      .insert(benchmarkProviderCallResultsTable)
      .values({ runId, callId, providerId, status: "ok", ...overrides })
      .returning();
    return row;
  }

  async score(
    resultId: string,
    overrides: Partial<typeof benchmarkScoresTable.$inferInsert> = {},
  ): Promise<ScoreRow> {
    const [row] = await db
      .insert(benchmarkScoresTable)
      .values({ resultId, scoringVersion: "v1", ...overrides })
      .returning();
    return row;
  }

  async ranking(
    overrides: Partial<typeof benchmarkRankingsTable.$inferInsert> = {},
  ): Promise<RankingRow> {
    const [row] = await db
      .insert(benchmarkRankingsTable)
      .values({
        vertical: "property_management",
        providerId: `fx-${this.suffix}-rank`,
        providerName: `fixture provider ${this.suffix}`,
        rank: 1,
        recommendation: "fixture",
        ...overrides,
      })
      .returning();
    this.rankingIds.push(row.id);
    return row;
  }

  /** Scans cascade from their call, so only untracked here. requestedByLabel
   *  carries the suffix -- greppable if a crashed run ever leaves one behind. */
  async scan(
    callId: string,
    overrides: Partial<typeof benchmarkAgentScansTable.$inferInsert> = {},
  ): Promise<ScanRow> {
    const [row] = await db
      .insert(benchmarkAgentScansTable)
      .values({ callId, status: "clean", requestedByLabel: `fixture-${this.suffix}`, ...overrides })
      .returning();
    return row;
  }

  /** FK order: runs first (cascades results, then scores), then bulks,
   *  calls (cascades scans), providers, rankings (no FK either way). */
  async cleanup(): Promise<void> {
    if (this.runIds.length) await db.delete(benchmarkRunsTable).where(inArray(benchmarkRunsTable.id, this.runIds));
    if (this.bulkIds.length) await db.delete(benchmarkBulksTable).where(inArray(benchmarkBulksTable.id, this.bulkIds));
    if (this.callIds.length) await db.delete(benchmarkCallsTable).where(inArray(benchmarkCallsTable.id, this.callIds));
    if (this.providerIds.length)
      await db.delete(benchmarkProvidersTable).where(inArray(benchmarkProvidersTable.id, this.providerIds));
    if (this.rankingIds.length)
      await db.delete(benchmarkRankingsTable).where(inArray(benchmarkRankingsTable.id, this.rankingIds));
  }
}
