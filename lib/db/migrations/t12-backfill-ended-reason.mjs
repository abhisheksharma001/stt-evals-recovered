// T-12, run once against production 2026-08-28. Kept as the audit record of
// what happened to the data. It is idempotent -- it only touches rows whose
// `source_ended_reason` is still null -- but after the first run there is
// nothing left inside the window for it to do.
//
// WHAT IT DOES. T-11 made every NEW import capture Vapi's `endedReason` and
// `analysis.successEvaluation` verbatim. Every call imported before T-11 has
// both columns null. This script re-asks Vapi for each such call and copies
// the two fields across -- the same source, the same verbatim rule as T-11.
//
// THE 14-DAY WINDOW. The register row says "still inside the 14-day window;
// older ones stay null". The window is judged on Vapi's OWN `startedAt` from
// the live response (falling back to its `createdAt`), never on our local
// `source_started_at` -- 22 of the corpus rows predate that column and have
// nothing there. A call older than the window is reported and left alone,
// even if Vapi still returned it, because that is what the task specifies.
//
// NULL MUST NEVER SILENTLY MEAN "NORMAL CALL". A row is left null in exactly
// these cases, and each is counted separately in the report:
//   * outside the window (per the task);
//   * Vapi refused the call as past its retention window -- seen live: this
//     arrives as HTTP 400 with "This call exceeds your retention window.",
//     the same sentence `VapiRequestError` matches on the live path, NOT a
//     404 (a 404 is counted too, in case Vapi ever changes that);
//   * Vapi returned the call but with no `endedReason` on it;
//   * the request failed for any other reason (reported, not swallowed).
// Nothing here ever writes a placeholder like "unknown" or "normal".
//
// ACCOUNTS. The key for each row comes from `source_account_label`, mapped
// back to the env var the same way `listVapiAccounts` derives the label
// ("Default" -> VAPI_API_KEY, "Land And Apartment" ->
// VAPI_API_KEY_LAND_AND_APARTMENT). Keys are read from the environment only
// and never printed.
//
// Result on the live DB, 2026-08-28 (dry-run first, then the real run,
// identical counts):
//   121 candidates (every corpus call has a Vapi call id).
//   107 written: 52 assistant-forwarded-call, 45 customer-ended-call,
//                 7 assistant-ended-call,
//                 2 customer-ended-call-after-warm-transfer-attempt,
//                 1 silence-timed-out.
//    14 left null: all past Vapi's retention window (HTTP 400), all on the
//                  Default account. 0 outside-window-by-date, 0 404, 0 with a
//                  call but no endedReason, 0 request failures.
//
// Run with:
//   DATABASE_URL=... VAPI_API_KEY=... VAPI_API_KEY_...=... \
//     node lib/db/migrations/t12-backfill-ended-reason.mjs [--dry-run]
import pg from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const VAPI_BASE_URL = process.env.VAPI_BASE_URL ?? "https://api.vapi.ai";

const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, params) => (await c.query(sql, params)).rows;

// Inverse of vapi.ts `labelFromSuffix`: "Land And Apartment" -> LAND_AND_APARTMENT.
function keyForLabel(label) {
  if (label === "Default") return process.env.VAPI_API_KEY?.trim() || null;
  const suffix = String(label).trim().split(/\s+/).join("_").toUpperCase();
  return process.env[`VAPI_API_KEY_${suffix}`]?.trim() || null;
}

// Same rule as vapi.ts `successEvaluationOf`: verbatim string, null if absent.
function successEvaluationOf(call) {
  const v = call.analysis?.successEvaluation;
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : String(v);
}

const rows = await q(`
  select id, source_call_id, source_account_label
    from benchmark_calls
   where source_ended_reason is null
     and source_call_id is not null
   order by created_at
`);
const noCallId = await q(`
  select count(*)::int as n from benchmark_calls
   where source_ended_reason is null and source_call_id is null
`);
console.log(`candidates (null endedReason, has Vapi call id): ${rows.length}`);
console.log(`left null, no Vapi call id on file: ${noCallId[0].n}`);

const now = Date.now();
const report = {
  written: 0,
  outsideWindow: 0,
  vapiRetentionExpired: 0,
  vapi404: 0,
  vapiNoEndedReason: 0,
  requestFailed: 0,
  noKeyForAccount: 0,
};
const updates = [];
const endedReasonCounts = {};

for (const row of rows) {
  const key = keyForLabel(row.source_account_label);
  if (!key) {
    report.noKeyForAccount += 1;
    continue;
  }
  const res = await fetch(`${VAPI_BASE_URL}/call/${encodeURIComponent(row.source_call_id)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.status === 404) {
    report.vapi404 += 1;
    continue;
  }
  if (res.status === 400) {
    const body = await res.text();
    if (body.includes("exceeds your retention window")) {
      report.vapiRetentionExpired += 1;
      continue;
    }
    report.requestFailed += 1;
    console.error(`  ${row.id}: Vapi HTTP 400: ${body.slice(0, 200)}`);
    continue;
  }
  if (!res.ok) {
    report.requestFailed += 1;
    console.error(`  ${row.id}: Vapi HTTP ${res.status}`);
    continue;
  }
  const call = await res.json();
  const startedAt = Date.parse(call.startedAt ?? call.createdAt ?? "");
  if (!Number.isFinite(startedAt) || now - startedAt > WINDOW_MS) {
    report.outsideWindow += 1;
    continue;
  }
  if (typeof call.endedReason !== "string" || call.endedReason === "") {
    report.vapiNoEndedReason += 1;
    continue;
  }
  updates.push({
    id: row.id,
    endedReason: call.endedReason,
    successEvaluation: successEvaluationOf(call),
  });
  endedReasonCounts[call.endedReason] = (endedReasonCounts[call.endedReason] ?? 0) + 1;
}

console.log(DRY_RUN ? "DRY RUN -- nothing written. Would write:" : "Writing:", updates.length);
console.table(endedReasonCounts);

if (!DRY_RUN && updates.length > 0) {
  await q("begin");
  try {
    for (const u of updates) {
      const r = await q(
        `update benchmark_calls
            set source_ended_reason = $2,
                source_success_evaluation = coalesce(source_success_evaluation, $3),
                updated_at = now()
          where id = $1 and source_ended_reason is null
          returning id`,
        [u.id, u.endedReason, u.successEvaluation],
      );
      report.written += r.length;
    }
    if (report.written !== updates.length) {
      throw new Error(`expected ${updates.length} writes, got ${report.written}`);
    }
    await q(
      `insert into audit_log (actor_label, action, entity_type, entity_id, after_state)
       values ('t12-backfill', 'call.backfill_ended_reason', 'call', 'corpus', $1)`,
      [JSON.stringify({ ...report, endedReasonCounts })],
    ).catch((e) => {
      // Audit table shape is verified before the real run; a mismatch here
      // must abort the whole transaction, not silently skip the log.
      throw new Error(`audit_log insert failed: ${e.message}`);
    });
    await q("commit");
  } catch (e) {
    await q("rollback");
    console.error("ROLLED BACK:", e.message);
    await c.end();
    process.exit(1);
  }
}

console.log("REPORT:", report);
await c.end();
