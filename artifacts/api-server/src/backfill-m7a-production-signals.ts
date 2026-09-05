/**
 * One-off data backfill for register row M-7a (2026-09-06, PRD v6 Part A).
 *
 * Fills the four `prod_*` columns on `benchmark_calls` from the call
 * artifacts already saved on this server's disk by M-6's importer and by
 * scripts/rescue-customer-audio.mjs. Reads the SAME file the writer wrote
 * (artifactCachePathFor) through the SAME reader the importer uses
 * (readProductionSignals), so a rescued call and an imported one can never
 * be measured differently.
 *
 * Reads the disk and the database only. It never calls Vapi, never calls a
 * provider, and spends nothing -- every number it stores was already paid
 * for and saved months ago.
 *
 * Null is left as null on purpose. A call whose artifact reports a
 * transcriber latency of 0 (23 of the first 100) measured nothing, and a
 * call with no `numAssistantInterrupted` (53 of 100) was never asked; both
 * stay null so no screen can render them as fast or calm. Those calls are
 * counted as "nothing to store" below rather than being silently mixed in
 * with the ones that had no artifact at all.
 *
 * Idempotent: only rows where all four columns are still null are
 * considered, so a second --apply finds nothing to write.
 *
 *   pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/backfill-m7a-production-signals.ts [--apply]
 */
import { readFile } from "node:fs/promises";

import { and, eq, isNull } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");
const { db, pool, benchmarkCallsTable } = await import("@workspace/db");
const { artifactCachePathFor } = await import("./lib/audio-cache");
const { readProductionSignals } = await import("./lib/production-signals");
const { writeAudit } = await import("./lib/audit");

const unfilled = and(
  isNull(benchmarkCallsTable.prodTranscriberLatencyMs),
  isNull(benchmarkCallsTable.prodEndpointingLatencyMs),
  isNull(benchmarkCallsTable.prodAssistantInterruptions),
  isNull(benchmarkCallsTable.prodToolCalls),
);

const rows = await db
  .select({ id: benchmarkCallsTable.id })
  .from(benchmarkCallsTable)
  .where(unfilled);

const stats = { noArtifact: 0, unreadable: 0, nothingToStore: 0, toWrite: 0 };
const pending: { id: string; signals: Awaited<ReturnType<typeof readProductionSignals>> }[] = [];

for (const row of rows) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(artifactCachePathFor(row.id), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") stats.noArtifact += 1;
    else stats.unreadable += 1;
    continue;
  }
  const signals = readProductionSignals(parsed);
  if (Object.values(signals).every((value) => value === null)) {
    stats.nothingToStore += 1;
    continue;
  }
  stats.toWrite += 1;
  pending.push({ id: row.id, signals });
}

const measured = (key: keyof (typeof pending)[number]["signals"]) =>
  pending.filter((p) => p.signals[key] !== null).length;

console.log(
  `M-7a: ${rows.length} calls with no production signals stored; ` +
    `${stats.toWrite} have an artifact worth storing, ${stats.noArtifact} have no artifact file, ` +
    `${stats.nothingToStore} have one that measured nothing, ${stats.unreadable} unreadable`,
);
console.log(
  `  of the ${stats.toWrite}: transcriber latency ${measured("prodTranscriberLatencyMs")}, ` +
    `endpointing ${measured("prodEndpointingLatencyMs")}, ` +
    `interruptions ${measured("prodAssistantInterruptions")}, ` +
    `tool calls ${measured("prodToolCalls")}`,
);

if (!APPLY) {
  console.log("dry run -- pass --apply to write");
  await pool.end();
  process.exit(0);
}

let written = 0;
for (const { id, signals } of pending) {
  const updated = await db
    .update(benchmarkCallsTable)
    .set(signals)
    .where(and(eq(benchmarkCallsTable.id, id), unfilled))
    .returning({ id: benchmarkCallsTable.id });
  if (updated.length === 0) continue;
  await writeAudit({
    entityType: "call",
    entityId: id,
    actorLabel: "backfill-m7a-production-signals",
    action: "update",
    // Every one of these was null before -- that is the row filter.
    beforeState: {
      prodTranscriberLatencyMs: null,
      prodEndpointingLatencyMs: null,
      prodAssistantInterruptions: null,
      prodToolCalls: null,
    },
    afterState: signals,
  });
  written += 1;
}

const remaining = await db.select({ id: benchmarkCallsTable.id }).from(benchmarkCallsTable).where(unfilled);
console.log(`wrote ${written}; calls still carrying no production signals: ${remaining.length}`);
await pool.end();
