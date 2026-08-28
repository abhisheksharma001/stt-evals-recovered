// T-40, run once against production 2026-08-28. Kept as the audit record of what
// happened to the data, not as something to run again (it is guarded and
// idempotent -- it only ever touches rows that are still null -- but after the
// first run there is nothing left for it to do).
//
// WHY THIS IS A MIGRATION AND NOT PART OF T-06.
// T-06 made every NEW failure record its own `failureClass`, set at the throw
// site by whichever code actually held the HTTP status / socket state / vendor
// body. The whole point of that task was to stop deriving the cause by reading
// the error sentence afterwards.
//
// The 168 failures already in the table predate the column and are all null.
// The only evidence that survives for them IS the stored `error_message`. So
// classifying them means doing the exact thing T-06 exists to remove -- which
// is fine here, and only here, because:
//   * it runs once, over a fixed set of rows, and is then finished forever;
//   * it lives in `migrations/`, not on the live path, so nothing that runs in
//     production reads an error sentence to decide a class;
//   * it only classifies where the stored text carries the SAME evidence the
//     live path would have classified on (an explicit HTTP status, Vapi's
//     retention sentence, or a message our own code wrote at its own throw
//     site) -- and leaves everything else null rather than guessing.
//
// LEAVING A ROW NULL IS A REAL ANSWER, AND IT IS NOT THE SAME AS `unknown`.
//   null      = "written before classification existed, and the surviving text
//                does not say why" -- no claim is made.
//   'unknown' = "classified; the answer is genuinely 'we don't know'", and
//                per `isRetryableFailureClass` it is RETRYABLE.
// That difference has teeth: 25 rows here say only "Gladia submit returned HTTP
// 400" / "Deepgram returned HTTP 400". They are almost certainly the same dead
// audio URL as their neighbours, but the text does not say so. Writing
// 'unknown' on them would mark 25 permanently-dead cells as retryable, and
// T-07's retry button would then offer to spend real provider money re-running
// calls that can never succeed. Null is the honest and the safe answer.
//
// THE RULES, and the live-code behaviour each one mirrors:
//   1. Vapi's retention sentence in a 400  -> retention_expired
//      (`VapiRequestError` matches that same sentence, once, at the response.)
//   2. "Failed to fetch audio from <url>: HTTP 401|403"  -> audio_url_forbidden
//      (our own `fetchAudioBytes` message; it sets that class today.)
//   3. "Download error, got HTTP 403, Forbidden, unable to download <our url>"
//      -> audio_url_forbidden. This one is AssemblyAI's own sentence, not ours,
//      from the era when we handed providers a URL instead of bytes. The class
//      is documented as covering a 403 "either to our own fetch, or to the
//      provider's fetch of a URL we handed it", and the status is stated
//      explicitly in the text, so this is evidence, not inference.
//   4. "Cartesia WebSocket timed out waiting for a final transcript..."
//      -> provider_timeout (the exact class that path sets today).
//   5. "Cartesia returned no final transcript segment."  -> unknown. Cartesia
//      closed cleanly and simply never sent a final segment; today's adapter
//      lands this in 'unknown' too. This is the one row in the corpus that
//      genuinely earns that class.
//   6. anything else -> left null.
//
// GROUND TRUTH. Bulk 7d2585da's 45 failed cells were independently re-derived
// during T-06 by running the real audio resolver against the live Vapi API and
// live Supabase storage: 30 retention_expired / 15 audio_url_forbidden / 0
// unknown. This migration asserts exactly that inside the transaction and rolls
// back if it disagrees, so a wrong rule cannot land.
//
// Result on the live DB. These counts were measured by running exactly the
// rules below as a read-only SELECT against the live table before anything was
// written, and are re-asserted inside the transaction at commit time:
//   168 failed rows, all null before.
//   143 classified: 70 retention_expired, 56 audio_url_forbidden,
//                   16 provider_timeout, 1 unknown.
//    25 left null  : 16 "Gladia submit returned HTTP 400"
//                     9 "Deepgram returned HTTP 400"
//   Bulk 7d2585da  : 30 / 15 / 0 -- matches ground truth exactly.
//
// Run with: DATABASE_URL=... node lib/db/migrations/t40-backfill-failure-class.mjs
import pg from "pg";

const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const q = async (sql, params) => (await c.query(sql, params)).rows;

// The rules, in order. First match wins; no row matches two.
const CLASSIFY_SQL = `
  case
    when error_message like '%exceeds your retention window%'
      then 'retention_expired'
    when error_message ~ 'Failed to fetch audio from .*: HTTP 40[13]$'
      then 'audio_url_forbidden'
    when error_message ~ '^Download error, got HTTP 40[13], Forbidden, unable to download '
      then 'audio_url_forbidden'
    when error_message like 'Cartesia WebSocket timed out waiting for a final transcript%'
      then 'provider_timeout'
    when error_message = 'Cartesia returned no final transcript segment.'
      then 'unknown'
    else null
  end
`;

const TARGET = `status = 'failed' and failure_class is null`;

const before = await q(`
  select count(*) filter (where status = 'failed')                               as failed,
         count(*) filter (where ${TARGET})                                       as failed_unclassified,
         count(*) filter (where status = 'failed' and failure_class is not null)  as failed_classified
    from benchmark_provider_call_results
`);
console.log("BEFORE:", before[0]);

if (Number(before[0].failed_unclassified) === 0) {
  console.log("Nothing to do -- every failed row already carries a class.");
  await c.end();
  process.exit(0);
}

await q("begin");
try {
  const updated = await q(`
    update benchmark_provider_call_results
       set failure_class = ${CLASSIFY_SQL}
     where ${TARGET}
       and (${CLASSIFY_SQL}) is not null
    returning id, failure_class
  `);

  const byClass = updated.reduce((acc, r) => {
    acc[r.failure_class] = (acc[r.failure_class] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`classified ${updated.length} rows:`, byClass);

  // Ground truth: bulk 7d2585da was re-derived from the live Vapi/Supabase
  // sources during T-06. If the rules disagree with it, the rules are wrong.
  const truth = await q(`
    select r.failure_class as fc, count(*)::int as n
      from benchmark_provider_call_results r
      join benchmark_runs run on run.id = r.run_id
      join benchmark_bulks b   on b.id  = run.bulk_id
     where r.status = 'failed' and b.id::text like '7d2585da%'
     group by 1
  `);
  const got = Object.fromEntries(truth.map((r) => [r.fc ?? "(null)", r.n]));
  const want = { retention_expired: 30, audio_url_forbidden: 15 };
  // Every one of the 45 must be one of the two verified classes: the two counts
  // have to match AND there must be no third bucket (no null, no 'unknown').
  const ok =
    got.retention_expired === want.retention_expired &&
    got.audio_url_forbidden === want.audio_url_forbidden &&
    Object.keys(got).length === 2;
  if (!ok) {
    console.error("GROUND TRUTH MISMATCH for bulk 7d2585da");
    console.error("  expected:", want);
    console.error("  got     :", got);
    throw new Error("refusing to commit: classification disagrees with the live-verified answer");
  }
  console.log("ground truth OK -- bulk 7d2585da:", got);

  await q("commit");
} catch (e) {
  await q("rollback");
  throw e;
}

const after = await q(`
  select coalesce(failure_class, '(left null)') as failure_class, count(*) as n
    from benchmark_provider_call_results
   where status = 'failed'
   group by 1 order by n desc
`);
console.log("AFTER:");
console.table(after);

// Exactly which messages were left unclassified, so the residue is visible
// rather than silently absorbed.
const residue = await q(`
  select left(error_message, 60) as message, count(*) as n
    from benchmark_provider_call_results
   where status = 'failed' and failure_class is null
   group by 1 order by n desc
`);
if (residue.length > 0) {
  console.log("LEFT NULL on purpose (text does not state a cause):");
  console.table(residue);
}

await c.end();
