# Research log

One entry per open question (mystandard section 9). Find the code markers with
`grep -rn "RESEARCH R-" .`

### R-1 — What Spearman ρ counts as "the no-gold rank agrees with gold WER" for 7 providers?

**Where:** W-12b · `docs/step-register.md` W-12b row, `docs/PRD-v8-watch.md` Part F · the verdict word on the Results "Method check" line.
**Find out:** the cutoff between "agrees" and "weak". A fixed number vs a computed p-value changes the code.
**Confidence:** high -- computed here and matches a published table.
**Review:** none.
**Status:** answered 2026-09-26.
**Answer:** for n = 7 with no ties, exactly 222 of the 5,040 orderings give ρ ≥ 5/7 (0.714), one-sided p = 0.0440; ρ ≥ 11/14 (0.786) gives p = 0.024 (python enumeration over itertools.permutations, 2026-09-26). Published critical values agree: n = 7, one-tailed α 0.05 = 0.714, two-tailed α 0.05 = 0.786 (Zar 2010, via https://statisticsfundamentals.com/tables/spearman-correlation-table, read 2026-09-26; https://metricgate.com/docs/spearman-critical-values gives 0.7857 two-sided, read 2026-09-26). Direction is predicted in advance (fewer flags should mean lower WER), so one-sided is correct. Ties are the normal case in this corpus and shift the distribution, so W-12b computes the exact permutation p on the real mid-ranks instead of comparing to 0.714.

### R-2 — Does a failed cell count against a provider's reliability?

**Where:** R-2b follow-up · `lib/scoring/src/verdict.ts` `VerdictCell` and `artifacts/api-server/src/lib/run-executor.ts` ranking loop · the flagged-call rate.
**Find out:** whether a provider that times out or errors on a call is penalised anywhere in the verdict or the card rank. Abhishek's goal (2026-09-28) is "the most reliable STT"; if a failed cell is simply left out, a provider that fails often can read cleaner than one that always answers. Yes = nothing to build; no = a step that folds failures into the ranking quantity.
**Confidence:** high -- traced in the code and counted in the local DB, 2026-09-28.
**Review:** none.
**Status:** answered 2026-09-28.
**Answer:** No -- a failed cell is left out everywhere, so it costs a provider nothing.
- Card rank: `computeRankingsForBulk` and `computeRankingsForRun` read only `status = 'ok'` results inner-joined to a score row (`artifacts/api-server/src/lib/run-executor.ts:1744`, `:1679`). A failed cell has no score row and no ok status, so it never reaches `aggregateRankingRows`; the flagged-call rate's denominator is the provider's ok calls only.
- Verdict: the bulk verdict's cell query has the same filter and join (`artifacts/api-server/src/lib/verdict.ts:408`), and `computeVerdict` further drops cells with no peer flag count (`lib/scoring/src/verdict.ts:352`).
- A retry erases the failure: `upsertResult` overwrites a non-ok row when the retry succeeds (`artifacts/api-server/src/lib/run-executor.ts:1370`), so "needed a retry" leaves no trace and cannot be counted after the fact.

Does it matter today? Not in any finished bulk. Local DB, 2026-09-28, all `benchmark_provider_call_results` with `status = 'failed'`:
- 3,850 "Call has no audioObjectPath to send to a provider", 40 Vapi recording-URL HTTP 400, 25 audio fetch from our storage -- our side, and spread across every provider on the call, so they change no provider's standing.
- The rest look provider-side but none sits in a finished bulk: Cartesia 16 "closed without flush_done" + 1 "no final transcript segment", Deepgram nova-3 9 HTTP 400, Gladia solaria 16 HTTP 400, AssemblyAI 16 "Download error, got HTTP 403" (AssemblyAI could not fetch OUR signed URL -- our side) -- all ad-hoc runs 2026-08-24..26; plus 1 Cartesia "no final transcript segment" in cancelled bulk 4fee349b.
- Bulk 42769f26 (the live one): 17 ok cells for each of its 5 providers, 0 failed.
- `failure_class` cannot yet say whose fault a failure was: 3,868 of 3,974 failed rows read `unknown`.

What gets built differently: nothing to the rank today -- there are no provider-side failures in finished data to fold in, and counting every failure would punish all providers equally for our missing audio. Two gaps stay real for "the most reliable STT" and are Abhishek's call, not queued: (a) a provider-fault failure could count as a flagged call, which needs a fault-attributing failure class first; (b) keep a per-cell failed-attempt count so a failure a retry later cleared still shows.

