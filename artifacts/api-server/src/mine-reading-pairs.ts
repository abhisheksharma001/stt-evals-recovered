/**
 * T-133: mine the corpus's disagreement-span reading pairs, committed this
 * time. Batch 7 (T-101) built the equivalence rules from a one-session
 * script (src/_mine-pairs.ts) that was deleted before it was ever
 * committed; the backlog says to re-run the mining "after the next few
 * bulks to see what rises next" -- impossible without the tool. This is
 * that tool, permanent.
 *
 * Read-only: builds spans (a pure function of stored result rows) for the
 * latest batch run of every call in every finished bulk -- the exact scope
 * words-to-watch uses -- and counts (reference reading ||| other reading)
 * pairs. Since T-101 spans are built on canonicalTranscript(), so every
 * pair printed here is a disagreement the current equivalence rules do NOT
 * fold: the top of this list is the candidate list for the next rule --
 * or for a real provider difference that must stay.
 *
 *   pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/mine-reading-pairs.ts [--top N]
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  benchmarkBulksTable,
  benchmarkProviderCallResultsTable,
  benchmarkRunsTable,
  db,
} from "@workspace/db";
import { buildSpansForCallRun } from "./lib/disagreement-spans";

const FINISHED_BULK_STATUSES = ["complete", "partial"] as const;

async function main(): Promise<void> {
  const topArg = process.argv.indexOf("--top");
  const top = topArg >= 0 ? Number(process.argv[topArg + 1]) || 60 : 60;

  const runs = await db
    .select({ id: benchmarkRunsTable.id, createdAt: benchmarkRunsTable.createdAt })
    .from(benchmarkRunsTable)
    .innerJoin(benchmarkBulksTable, eq(benchmarkBulksTable.id, benchmarkRunsTable.bulkId))
    .where(and(eq(benchmarkRunsTable.purpose, "batch"), inArray(benchmarkBulksTable.status, [...FINISHED_BULK_STATUSES])))
    .orderBy(desc(benchmarkRunsTable.createdAt));
  const runIds = runs.map((r) => r.id);
  const runOrder = new Map(runs.map((r) => [r.id, r.createdAt.getTime()]));

  const cells = await db
    .selectDistinct({ callId: benchmarkProviderCallResultsTable.callId, runId: benchmarkProviderCallResultsTable.runId })
    .from(benchmarkProviderCallResultsTable)
    .where(and(inArray(benchmarkProviderCallResultsTable.runId, runIds), eq(benchmarkProviderCallResultsTable.status, "ok")));
  const latestByCall = new Map<string, { callId: string; runId: string }>();
  for (const c of cells) {
    const cur = latestByCall.get(c.callId);
    if (!cur || (runOrder.get(c.runId) ?? 0) > (runOrder.get(cur.runId) ?? 0)) latestByCall.set(c.callId, c);
  }

  let spanCount = 0;
  const pairCounts = new Map<string, number>();
  for (const cell of latestByCall.values()) {
    const built = await buildSpansForCallRun(cell.callId, cell.runId);
    for (const span of built.spans) {
      spanCount += 1;
      const ref = span.readings.find((r) => r.providerId === built.referenceProviderId)?.text ?? "";
      for (const reading of span.readings) {
        if (reading.providerId === built.referenceProviderId) continue;
        if (reading.text === ref) continue;
        const key = `${ref} ||| ${reading.text}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const sorted = [...pairCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  console.log(`calls: ${latestByCall.size} (latest batch run each) · spans: ${spanCount} · distinct pairs: ${sorted.length}`);
  console.log(`top ${Math.min(top, sorted.length)} (count  reference ||| other):`);
  for (const [pair, count] of sorted.slice(0, top)) {
    console.log(String(count).padStart(4, " ") + "  " + pair);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
