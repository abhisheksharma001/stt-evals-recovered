/**
 * One-off data backfill for register row T-52 (2026-08-29).
 *
 * The 22 original corpus calls were imported before `source_started_at`
 * existed and still say `source_provider = 'manual'` although every one has
 * a real Vapi `source_call_id` (account label "Default"). Any window logic
 * keyed on `source_started_at` silently skips them. This asks Vapi for each
 * call again (GET /call/{id} -- metadata survives past audio retention) and
 * stores `startedAt`; it also sets `source_provider = 'vapi'`, since that is
 * what they are. Nothing else on the row is touched.
 *
 * Idempotent: only rows with a null source_started_at and a source_call_id
 * are considered. Dry run by default; prints what it would write.
 *
 *   pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/backfill-t52-started-at.ts [--apply]
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { fetchVapiCall, listVapiAccounts } from "./lib/vapi";

const APPLY = process.argv.includes("--apply");
const { db, pool, benchmarkCallsTable } = await import("@workspace/db");

const rows = await db
  .select({ id: benchmarkCallsTable.id, sourceCallId: benchmarkCallsTable.sourceCallId, label: benchmarkCallsTable.sourceAccountLabel, provider: benchmarkCallsTable.sourceProvider })
  .from(benchmarkCallsTable)
  .where(and(isNull(benchmarkCallsTable.sourceStartedAt), isNotNull(benchmarkCallsTable.sourceCallId)));
console.log(`T-52: ${rows.length} calls with a Vapi call id but no source_started_at`);

const accounts = listVapiAccounts();
let resolved = 0;
let missing = 0;
let written = 0;
for (const row of rows) {
  const account = accounts.find((a) => a.label === (row.label ?? "Default"));
  if (!account) {
    console.log(`  ${row.id.slice(0, 8)}: no configured Vapi account labelled ${JSON.stringify(row.label)} -- skipped`);
    missing += 1;
    continue;
  }
  let startedAt: string | undefined;
  try {
    startedAt = (await fetchVapiCall(account.id, row.sourceCallId!)).startedAt;
  } catch (err) {
    console.log(`  ${row.id.slice(0, 8)}: Vapi lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    missing += 1;
    continue;
  }
  if (!startedAt) {
    console.log(`  ${row.id.slice(0, 8)}: Vapi has no startedAt for ${row.sourceCallId} -- left null`);
    missing += 1;
    continue;
  }
  resolved += 1;
  console.log(`  ${row.id.slice(0, 8)}: ${row.provider} -> vapi, started_at ${startedAt}`);
  if (APPLY) {
    await db
      .update(benchmarkCallsTable)
      .set({ sourceStartedAt: new Date(startedAt), sourceProvider: "vapi" })
      .where(and(eq(benchmarkCallsTable.id, row.id), isNull(benchmarkCallsTable.sourceStartedAt)));
    written += 1;
  }
}
console.log(`resolved ${resolved}, unresolved ${missing}, written ${written}${APPLY ? "" : " (dry run -- pass --apply to write)"}`);
await pool.end();
