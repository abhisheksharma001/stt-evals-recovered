# Vision — what "great" looks like for this tool

## The business problem, plainly

Ellavox.ai puts AI voice agents in front of real customers for real client companies.
Every one of those agents has an STT engine listening underneath it, silently deciding
what the customer actually said before anything downstream — the LLM, the CRM update,
the dispatch record — happens. Pick the wrong STT provider for a client's specific
call patterns (accents, background noise, domain vocabulary like VINs and RO numbers,
call length) and the agent looks broken even when everything else is right. Pick well,
backed by evidence specific to that client's real calls, and it's a genuine
differentiator when Ellavox pitches or renews a client.

This tool is the thing that turns "which STT should we use" from a guess or a vendor's
marketing claim into an answer built from that client's own audio.

## Why "top 1%" and not "it works"

A demo-quality version of this tool is easy: run three providers against a handful of
calls, eyeball the transcripts, pick a winner. That's roughly where the MVP sits today,
deliberately — get something real working end-to-end before polishing it. But a tool
Ellavox actually trusts to make a client-facing vendor decision needs to survive
questions a demo doesn't: *How do you know that result wasn't luck? Can you reproduce
it in six months when a client asks why we picked this vendor? Does "accurate" mean
the words matched, or that the one VIN number that actually mattered matched?*

Those are exactly the questions the research pass (Perplexity, ChatGPT, Gemini,
DeepSeek — logged during this project) came back with, independently, from looking at
how serious STT evaluation is actually done at scale (Scale AI, Labelbox-style
benchmarking rigor; academic ASR evaluation practice). The gap between "it works" and
"top 1%" is concrete, not vague:

| Dimension | "It works" | Top 1% |
|---|---|---|
| **Accuracy metric** | Raw WER only | WER + Entity Error Rate (the numbers/names that actually break automation) + optionally semantic WER, so "yep" vs "yes" doesn't count the same as a wrong load number |
| **Sample size** | However many calls got imported | Explicit confidence caveat below a real threshold, paired statistical comparison (same calls, not two averages), decided before looking at results |
| **Reproducibility** | Re-run it and hope | Every run's inputs (audio hash, gold transcript version, provider config, raw output) are content-hashed and stored, so a result from 6 months ago can be proven, not just remembered |
| **Bias control** | Whatever transcript looked convenient became gold | Draft (the provider Vapi already used live) is tracked and never silently becomes gold; the reviewer corrects from audio, not from trusting one vendor's guess |
| **Decision output** | A number on a dashboard | A structured, per-vertical recommendation a non-technical stakeholder (a client, a PM) can read and act on, with the caveats attached, not stripped out |
| **Failure handling** | Silent partial data counted as success | A truncated or corrupted result is caught and marked failed/retryable, never silently scored as if it were real (this exact bug existed and was fixed this project — see the Cartesia findings in the backlog doc) |

None of the right-hand column is exotic — it's what any team doing this seriously
already does. The gap is discipline, not cleverness: catching the corner cases,
refusing to let "close enough" data pass as real data, and being honest in the UI about
what's actually known versus what's still a small sample.

## What "beyond current standards" looks like from here

The research also surfaced things most public STT benchmarks (including vendor-run
ones) don't bother with, because they're optimizing for a marketing chart, not a real
buying decision:

- **Entity-level accuracy as a first-class metric, not an afterthought.** Most public
  leaderboards report only WER. A wrong VIN digit or transposed unit number breaks a
  downstream system even when overall WER looks great — this tool already tags and
  scores entities separately (`docs/PRD.md` G2), ahead of most public benchmarks.
- **Per-vertical, not one global winner.** A provider that's best for short rush-parts
  calls may not be best for long trucking negotiation calls. Treating "the best STT
  provider" as one answer instead of three (per vertical) is the honest version of
  this question, and it's the version the tool already computes rankings for.
- **Confidence-aware quality flags, not just post-hoc scoring.** Three of four live
  providers already return a per-word confidence score the tool isn't using yet
  (`docs/backlog/good-to-have.md`) — using it to flag likely-distorted audio
  automatically, instead of a human noticing by ear, is the kind of thing a serious
  production STT evaluation pipeline does and most quick benchmarks skip.
- **A decision artifact, not a dashboard.** The end product of a run should be
  something a non-technical stakeholder can read start to finish and act on — a
  per-vertical winner, the evidence, the caveats, in one place — not a table someone
  has to interpret. Scoped in the backlog as the per-run decision export.

## The guardrail: none of this is scope creep to chase for its own sake

Every item above earns its place because it changes what decision the tool can safely
support — not because it's impressive. The standing project rule (see
`.claude/CLAUDE.md`) is "what's actually necessary now, everything else in the backlog"
— this vision doc is the north star for what "necessary" grows into as the tool
matures and gets used for real client decisions, not a license to over-build the MVP.
When in doubt about whether something belongs in the next slice of work or the
backlog, the test is: *does skipping this make a real recommendation the tool
produces less trustworthy, or is it polish?* Trustworthiness first.
