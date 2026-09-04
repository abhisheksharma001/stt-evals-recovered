# Standards — the bar this tool is judged against

A checklist, not prose. ✅ = shipped and verified live. ⬜ = scoped, not built (real
plan exists, usually in `docs/backlog/good-to-have.md`). Update this file's checkboxes
as things actually ship — it should always reflect reality, not intent.

## Table stakes (any credible STT evaluation tool needs these)

- ✅ Same audio bytes to every provider in a comparison (no re-encoding differences
  sneaking in as "accuracy")
- ⬜ The customer's audio, not the mixed recording — 71 % of scored words were the assistant's TTS voice until PRD v6 M-5
- ⬜ The product the client runs (streaming), not the batch endpoint — PRD v6 M-11 … M-14
- ⬜ Word Error Rate against a human-corrected gold transcript — **corrected 2026-09-04:** the 21 gold texts were Vapi's draft copied by a test script; no person has produced one. Gold is optional now (PRD v6); the bulk path is consensus-based and says so
- ✅ Multiple verticals, not one blended number
- ✅ Cost and latency captured alongside accuracy, not accuracy alone
- ✅ Raw provider output stored, not just the parsed transcript (so a scoring bug
  doesn't mean re-paying to re-transcribe)
- ✅ A failed or corrupted transcription is marked failed, never silently scored as if
  it succeeded (this was a real, found-and-fixed bug — see backlog doc)
- ✅ Runs are resumable — retrying only touches what actually failed

## Current market standard (what a serious internal benchmarking team does)

- ✅ Entity-level accuracy scored separately from raw WER (RO numbers, VINs, unit
  numbers, names, phone numbers) — most public leaderboards skip this entirely
- ✅ Word-level diff view — see exactly which word a provider got wrong, not just a
  percentage
- ✅ Draft-transcript bias tracked (which provider Vapi itself used live on a call is
  recorded, so it can be excluded/flagged when that same provider is a candidate)
- ✅ Sample-size confidence caveat surfaced automatically on any ranking below a
  real threshold, not hidden in fine print
- ⬜ Two-person de-identification attestation before a call is usable (compliance,
  not just accuracy) — **corrected 2026-09-04:** the mechanism exists; the 21 attestations on file are by `claude-pipeline-test-pass-1` / `-pass-2`, and 99 imported calls carry none
- ⬜ Statistical rigor on rankings: paired per-call comparison (same calls, not two
  independent averages), decided-in-advance primary metric — `docs/backlog/good-to-have.md` #3
- ⬜ Confidence-score-based low-quality-audio flagging (3 of 4 live providers already
  return this, unused) — scoped in the backlog doc with the real per-provider data
- ⬜ Run-level reproducibility manifest — content-hash the audio, gold version, config,
  and raw output so a result can be proven bit-identical months later —
  `docs/backlog/good-to-have.md` #1, design already sketched in `docs/reproducibility.md`

## Beyond standard (the differentiator, not the baseline)

- ⬜ Per-run decision export: one structured artifact (not a dashboard someone has to
  interpret) — per-vertical winner, evidence, caveats, readable by a non-technical
  stakeholder — `docs/backlog/good-to-have.md` #4
- ⬜ Semantic WER (LLM-as-judge, calibrated against human agreement) so a disfluency or
  contraction doesn't count the same as a genuinely wrong word
- ⬜ Gold-transcript integrity audits — occasional blind transcription with no seeded
  draft at all, as a check against the seeded-review workflow itself drifting
- ⬜ cpWER for diarization instead of strict DER, given reference transcripts aren't
  professionally diarized

## Explicitly not the bar (deliberately out of scope)

Chasing these would be over-engineering for a 2-3-person internal tool, not rigor —
listed so they don't get silently added later without a real reason:

- Workflow builder / consensus annotation engine / annotator leaderboards / real-time
  collaborative editing — sensible at Labelbox/Scale's scale, pure overhead here
- Live voice-agent latency-budget optimization, TOPSIS-style composite scoring,
  MLOps drift detection — all real, all aimed at *production* STT selection for a
  live agent; this tool does offline backtesting against recorded calls, a different
  problem

## How to use this file

Before calling a piece of work "done" for something that touches scoring, ranking, or
provider comparison, check it against this list — did it move something from ⬜ to ✅,
or is it a new gap that belongs added here? Before adding scope beyond what's asked,
check the "explicitly not the bar" section first.
