# Pending data backfills — one command, dry run by default

Several register rows shipped a *script* but the write itself was left for
Abhishek to run (the auto-mode classifier blocks direct database writes from
the agent, and that is the right default).

**Applied 2026-08-30 (T-111, batch 9) with Abhishek's go.** The dry run
afterwards reads: `T-65 cross-run pick links: 0; ... legacy ...: 0; T-62 flux
$/min: 0.0077` and `T-52: 14 calls ... resolved 0, unresolved 14, written 0`
(those 14 are past Vapi's retention and stay null for good); the recompute
covered all 22 finished runs. The table below is what the database showed
**before** that, kept as the record of what changed:

| Row | What is still wrong live | Script |
|---|---|---|
| T-65 | 106 flagged scans link `agent_pick_result_id` to a result row from a *different* run than the scan's own | `backfill-t65-t66.ts` |
| T-63 / T-66 | 5 legacy "flagged" scans with no pick and no ok cell (nothing was ever transcribed) still count as real findings | same script |
| T-62 | `deepgram-flux-general-en` list price is still $0.0043/min, should be $0.0077 (Deepgram pay-as-you-go streaming, verified 2026-08-29) | same script |
| T-101 | Stored hybrid flags on the 22 finished runs predate the equivalence rules (hyphen vs space, "gonna" / "going to", a stray "um" still count as disagreement there) | `recompute-hybrid-flags.ts` — free, no provider or LLM call; `pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/recompute-hybrid-flags.ts --apply` |
| T-52 | 22 original calls have `source_started_at = null` and `source_provider = 'manual'`; 8 are recoverable from Vapi, 14 are past retention and stay null | `backfill-t52-started-at.ts` |

How they were found again: dry-running both scripts on 2026-08-30 printed
`T-65 cross-run pick links: 106; ... legacy ...: 5; T-62 flux $/min: 0.0043`
and `resolved 8, unresolved 14, written 0`.

## M-1 (2026-09-04) — clear the 19 draft-copied gold transcripts

Added to the same door by register row M-1 (PRD v6 Part A) and **applied
2026-09-04**: `cleared 19; draft copies now 0; calls still carrying gold: 2`.
A second `--apply` right after printed `M-1: 0 to clear` and wrote no further
audit row. The table below is what the database showed **before** that.

| Row | What is wrong live | Script |
|---|---|---|
| M-1 | 19 of the 21 calls carrying a `gold_transcript` hold a byte-identical copy of their own `draft_transcript` — Vapi's own live output, `AI:` / `User:` labels and all, written by actor `claude-pipeline-test` on 2026-08-24 | `backfill-m1-clear-draft-gold.ts` |

A draft is not a reference. Scored against it, a provider is measured on how
closely it agrees with whichever transcriber Vapi ran that day, not on how
right it is — so every WER ever shown for those calls is wrong by
construction (the rush set reads 0.62–0.71). Clearing the copies puts those
calls on the gold-free consensus path, which is the recommended one.

The dry run prints `M-1: <n> to clear` and lists each call's id prefix and
length; it reads 0 now that the write has been applied.

What it does **not** touch: the two calls a person really edited
(`3559ea45…`, `64d8f463…`) differ from their draft and are never selected;
call `status` stays as it is (gold is optional, so `ready_to_run` is still
true); existing `benchmark_scores` rows stay as history — each run's manifest
records the gold it saw.

Verified live after the write: `GET /benchmark/calls` returns 2 calls with a
non-empty `goldTranscript` (`3559ea45…`, `64d8f463…`), both differing from
their draft; `audit_log` holds 19 rows with actor `backfill-m1-clear-draft-gold`;
all 121 calls still read `ready_to_run` and all 994 `benchmark_scores` rows are
still there.

What changes afterwards: WER and the word diff fall back to the draft as a
*reference for reading* on those 19 calls (call comparison already does this
when gold is absent), and no new score is computed against a fake gold. One
audit row per call is written with actor `backfill-m1-clear-draft-gold`,
carrying both transcripts before and after — a restore is a copy of the draft
back into gold.

## Run it

```bash
bash scripts/apply-backfills.sh            # counts only, writes nothing
bash scripts/apply-backfills.sh --apply    # writes; safe to re-run
```

Then re-run the dry run: every count should read 0 and the flux price 0.0077.
No API restart needed (database-only writes).

## What changes afterwards, and what does not

- **Results / Bulks**: "checked / flagged" coverage on the two 2026-08-24
  manual runs drops by 5 (they become `error`, which is what they were).
- **Call comparison**: the judge's pick now points at a transcript from the
  same run the scan was made on. Nothing visible changes for scans made after
  PR #34 — the code has been doing this since.
- **T-62 price**: `benchmark_providers.cost_per_minute` changes. Ranking rows
  store `costPerMinute` at compute time (T-61: spend ÷ minutes), so bulks
  ranked *before* the fix keep the old number until re-ranked. The monthly
  cost line and the switch-money sentence read list price live, so they update
  immediately.
- **T-52**: the eight recovered calls join the retention warning / volume
  window logic; the 14 unrecoverable ones stay exactly as they are.

## Rollback

There is none and none is needed: every write is a correction toward what the
source system (Vapi, Deepgram's price page, the run's own result rows) says.
If a count is *not* 0 after `--apply`, stop and read the script's output —
it prints each row it could not resolve.
