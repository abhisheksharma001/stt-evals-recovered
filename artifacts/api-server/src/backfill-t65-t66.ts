/**
 * One-off data backfill for register rows T-65 and T-66 (2026-08-29).
 *
 *   T-65: 106 flagged scans link agent_pick_result_id to a result row in a
 *         DIFFERENT run than the scan's own (agent-verify.ts resolved the
 *         latest ok row for (call, provider) across all runs). Re-point each
 *         to the same provider's ok row inside the scan's own run. Every
 *         one of the 106 has such a row (checked before writing this).
 *   T-66: two 2026-08-24 manual agent_scan runs had 5/5 failed cells yet
 *         their scans are "flagged". No candidates ever existed, so the
 *         flags were an LLM-only guess. Reclassify as "error" with a note.
 *   T-63: widened T-66 to the call-level rule it really is -- a "flagged"
 *         scan with no pick AND no ok cell for its (run, call). The 3 other
 *         2026-08-24 null-pick scans match too (checked 2026-08-29: 0 ok
 *         cells each); they cannot be re-judged because nothing was ever
 *         transcribed. The agent-verify change in the same PR re-judges any
 *         FUTURE flagged+null-pick scan on re-execute.
 *   T-62: deepgram-flux-general-en list price 0.0043 -> 0.0077 (Deepgram
 *         pay-as-you-go streaming, verified 2026-08-29). The catalog default
 *         is insert-only (onConflictDoNothing), so the live row needs this.
 *
 * Idempotent: an --apply with nothing left to do prints three zero counts and
 * writes no audit row. The T-62 guard compares on a tolerance because
 * cost_per_minute is a float4 -- the stored value reads back as
 * 0.007699999958276749, so `<> 0.0077` matched on every apply (M-1a,
 * 2026-09-04). Prints before/after.
 *
 *   pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/backfill-t65-t66.ts [--apply]
 *
 * Without --apply it only counts.
 */
import { sql } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");

const { db, pool } = await import("@workspace/db");
const crossRun = sql`select count(*)::int as n from benchmark_agent_scans s join benchmark_provider_call_results r on r.id = s.agent_pick_result_id where s.run_id is not null and r.run_id <> s.run_id`;
const legacyWhere = sql`status = 'flagged' and agent_pick_result_id is null and run_id is not null
    and not exists (select 1 from benchmark_provider_call_results r where r.run_id = benchmark_agent_scans.run_id and r.call_id = benchmark_agent_scans.call_id and r.status = 'ok')`;
const legacy = sql`select count(*)::int as n from benchmark_agent_scans where ${legacyWhere}`;
const fluxPrice = sql`select cost_per_minute::float as c from benchmark_providers where id = 'deepgram-flux-general-en'`;

const before65 = (await db.execute(crossRun)).rows[0]!.n;
const before66 = (await db.execute(legacy)).rows[0]!.n;
const beforePrice = (await db.execute(fluxPrice)).rows[0]?.c;
console.log(`T-65 cross-run pick links: ${before65}; T-63/T-66 legacy flagged scans with no pick and no ok cell: ${before66}; T-62 flux $/min: ${beforePrice}`);
if (!APPLY) {
  console.log("dry run -- pass --apply to write");
  await pool.end();
  process.exit(0);
}

const relinked = await db.execute(sql`
  update benchmark_agent_scans s set agent_pick_result_id = x.id
  from benchmark_provider_call_results r, benchmark_provider_call_results x
  where r.id = s.agent_pick_result_id and s.run_id is not null and r.run_id <> s.run_id
    and x.run_id = s.run_id and x.call_id = s.call_id and x.provider_id = r.provider_id and x.status = 'ok'`);
const reclassified = await db.execute(sql`
  update benchmark_agent_scans
  set status = 'error',
      error_message = 'legacy (2026-08-24 agent_scan): every re-transcription cell for this call failed, so no candidates existed and the flags were an LLM-only guess with nothing behind them. Reclassified by T-63/T-66.'
  where ${legacyWhere}`);
const repriced = await db.execute(sql`update benchmark_providers set cost_per_minute = 0.0077 where id = 'deepgram-flux-general-en' and abs(cost_per_minute - 0.0077) > 1e-9`);
const written = (relinked.rowCount ?? 0) + (reclassified.rowCount ?? 0) + (repriced.rowCount ?? 0);
if (written > 0) {
  await db.execute(sql`
    insert into audit_log (entity_type, entity_id, actor_label, action, after_state)
    values ('agent_scan', 'backfill', 'backfill-t65-t66', 'backfill_pick_links_and_legacy_flagged',
            ${JSON.stringify({ relinked: relinked.rowCount, reclassified: reclassified.rowCount, fluxRepriced: repriced.rowCount })}::jsonb)`);
}

const after65 = (await db.execute(crossRun)).rows[0]!.n;
const after66 = (await db.execute(legacy)).rows[0]!.n;
const afterPrice = (await db.execute(fluxPrice)).rows[0]?.c;
console.log(`relinked ${relinked.rowCount} (cross-run now ${after65}); reclassified ${reclassified.rowCount} (legacy flagged now ${after66}); flux repriced ${repriced.rowCount} (now ${afterPrice})`);
await pool.end();
