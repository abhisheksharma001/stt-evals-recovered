# Scoring policy — what is compared, and what is deliberately ignored

**Written 2026-08-31 (T-144).** Every rule below was read out of the code and
then checked by running it, not recalled. Where the code and this page ever
disagree, the code is right and this page is the bug.

Why this exists: WER is supposed to measure **recognition** — did the provider
hear the words — not **formatting taste**. Two providers can write the same
speech as `1-bedroom` and `one bedroom` and be equally correct. So text is put
into a common form on both sides before anything is counted. That common form
is a policy, and until now it lived only in code (backlog item 6).

The person correcting a gold transcript needs to know this policy, because gold
goes through exactly the same treatment as a provider's output — the same
function, in the same call (`score()` in `lib/scoring/src/index.ts` normalizes
`goldTranscript` and `hypothesisTranscript` on the same line). Nothing a
reviewer types can advantage one provider over another through formatting. What
a reviewer types can still matter in the two places named under "Known gaps".

## Two different comparison forms, on purpose

| Form | Function | Used by | Folds conventions? |
|---|---|---|---|
| **Scoring form** | `normalizeTranscript()` (`lib/scoring/src/index.ts`) | WER, the word-level diff, entity checks | No — only case, punctuation and digits |
| **Comparison form** | `canonicalTranscript()` (`lib/scoring/src/equivalence.ts`) | hybrid flags, disagreement spans, words to watch | Yes — the conventions listed below |

The split is deliberate (T-101). The word diff still *shows* you that one
provider wrote `gonna` and another wrote `going to`, because that is a real
difference you may want to see. It just never **raises a flag** or fills a
"words to watch" row, because it is not a mistake.

## The rate's denominator — the call's words, not the provider's

**R-1, 2026-09-08.** The headline number is *peer flags per 100 words*. Its
numerator comes off the **comparison form**, which folds fillers and
conventions away; its denominator used to be that provider's own
**scoring-form** word count, which keeps them. So a provider that wrote more
filler divided the same flags by a bigger number and read cleaner for words
nobody scored it on. Live on bulk `42769f26`: ElevenLabs and AssemblyAI carried
identical peer flags on all 17 calls, and ElevenLabs was named winner by 4 %
for writing 1,047 words to 1,003 — 61 filler tokens to 37.

The rule now: **one word basis per call, shared by every provider measured on
it** — the median of the scoring-form word counts of that call's `ok` cells in
the scope being ranked, rounded to a whole word (`callWordBasis` in
`lib/scoring/src/verdict.ts`). The median, not the mean, so one runaway cell
cannot move it. Every surface that divides by words reads it: the org verdict
(`artifacts/api-server/src/lib/verdict.ts`), the stored ranking rate
(`artifacts/api-server/src/lib/run-executor.ts`) and the cross-bulk trend
(`artifacts/api-server/src/lib/trend.ts`). This is the same rule WER has always
followed — FR-S1 divides by the reference length, not by what the provider
wrote. Ranking rows written before this date carry the old basis; there is no
recompute route, so a bulk's stored rate changes on its next execution. The
verdict is computed on read and changed immediately.

## Two rates on one page, and how to tell them apart

**R-3, 2026-09-09.** The Results page, the Overview and the shareable artefact
all print two "per 100 words" numbers, and they are **not the same
measurement**. The same provider on bulk `42769f26` reads **2.6** in one and
**0.40** in the other. Both are right; reading them as one number is not.

| | The ranking's rate | Production's rate |
|---|---|---|
| Where | every table row, the verdict sentence | the production lead sentence |
| Numerator | **peer flags** — disagreements that survived the hybrid rules (a provider's own low-confidence spans excluded, entity checks applied) | **mismatched words** — every aligned position where the transcript differed from the plurality |
| Denominator | the call's word basis, whole call (`callWordBasis`) | the aligned words a plurality existed at, **caller turns only** |
| Computed in | `lib/scoring/src/verdict.ts` | `computeCrossProviderDisagreement`, `lib/scoring/src/hybrid.ts` |

Production's is the coarser of the two by construction: it counts raw word
mismatches rather than flags, and it is measured on the caller's turns because
that is all production's draft contains. It cannot be put in the ranking table
without becoming a different number, and production takes no part in the
consensus it is measured against (`nonVoting`, M-8a) so that the providers'
stored flag counts stay comparable.

**The rule: whichever surface prints production's rate says, in the same
breath, that it is a word-by-word count on the caller's turns and not the flag
count the ranking uses.** The words are written once, in `productionLead`
(`lib/scoring/src/verdict.ts`), and the three surfaces call it rather than
writing their own — the banner, the Overview's sentence and the HTML artefact.

## The scoring form, rule by rule

Applied in this order by `normalizeTranscript()`:

0. **A line-leading speaker label is removed.** Vapi writes a transcript as
   `AI: …` / `User: …` lines, and those two labels are not words anybody said.
   Only `^AI:` and `^User:` at the start of a line match, before lower-casing,
   so a spoken `the user said no` keeps its word. Left in, they cost a provider
   one deletion per line of the reference — which is what every call scored
   before 2026-09-04 was charged (M-2, `SCORING_VERSION` `v3`).
1. **Unicode is folded** (NFKC), then curly quotes (`’`) become `'` and the
   dash family (`–` `—` `−`) becomes `-`. Found the hard way: without this,
   `it’s` and `it's` were two different words and WER could double on an
   affected transcript.
2. **Everything is lower-cased.** Casing is never an error.
3. **Punctuation is dropped**, except the apostrophe and the hyphen, which are
   kept as part of the word. `.` `,` `?` `!` `:` `"` `(` `)` all become spaces —
   so a provider that punctuates well is not rewarded and one that returns a
   flat stream is not punished.
4. **Spoken single digits become digits.** `five` → `5`, and `oh` → `0`, one
   word at a time. This is narrow on purpose: it is how phone and reference
   numbers are read aloud. Quantities are *not* parsed — `nine hundred` becomes
   `9 hundred`, never `900`.
5. **Digit runs are split into single digits.** `555-1212` becomes
   `5 5 5 1 2 1 2`, and so does `five five five one two one two`. Both readings
   of the same number now match instead of scoring as seven substitutions of
   pure formatting noise.

Measured, on the real functions:

| Input | Scoring form |
|---|---|
| `call 555-1212 now` | `call 5 5 5 1 2 1 2 now` |
| `call five five five one two` | `call 5 5 5 1 2` |
| `it’s here` | `it's here` |
| `nine hundred dollars` | `9 hundred dollars` |

**Not folded here, on purpose:** contractions (`gonna` stays `gonna`), fillers
(`um` is a word), synonyms (`yeah` is not `yes`), hyphen-vs-space
(`1-bedroom` is one word, `1 bedroom` is two). All of those are folded in the
*comparison* form instead, so they can never raise a false flag while still
being visible in the diff.

## The comparison form, rule by rule

`canonicalTranscript()` runs the scoring form first, turns every hyphen into a
space, and then folds:

- **Fillers are dropped**: `um`, `uh`, `umm`, `uhh`, `hmm`, `mm`, `mhm`, `ah`,
  `er`, `erm`. Deliberately narrow — `yeah`, `okay` and `right` are answers to a
  question, not noise, so they are folded to a common word rather than deleted.
- **Same meaning, different spelling** is folded to one spelling:
  `gonna`→`going to`, `wanna`→`want to`, `gotta`→`got to`, `kinda`→`kind of`,
  `sorta`→`sort of`, `lemme`→`let me`, `gimme`→`give me`,
  `cause`/`'cause`/`cuz`/`cos`→`because`, `ok`→`okay`, `alright`→`all right`,
  `yeah`/`yep`/`yup`→`yes`, `nope`/`nah`→`no`, `ya`→`you`, `saint`→`st`,
  `ma'am`→`maam`.
- **Number words become digits**, including tens: `forty`→`4 0`,
  `twenty two`→`2 2`, and a number word glued to a letter (`fortyc`→`40c`,
  then split).
- **A time read out letter by letter is rejoined**: `1 0 a m` and `10am` both
  end as `1 0 am`. The rejoin only happens when a digit comes immediately
  before, so a sentence that merely ends in `a` followed by `m` is untouched.

Measured:

| Two readings | Comparison form | Same? |
|---|---|---|
| `a 1-bedroom unit` / `a one bedroom unit` | `a 1 bedroom unit` | yes |
| `gonna call um yeah` / `going to call yes` | `going to call yes` | yes |
| `at 10am` / `at 1 0 a m` | `at 1 0 am` | yes |
| `forty` / `4` | `4 0` / `4` | **no** |
| `villaroma` / `villa roma` | unchanged | **no** |

The last two are not oversights. `forty` vs `4` is a genuine difference in what
was said, and the corpus contains real cases of it (three, at last mining). The
`villaroma` pair is a real property name that providers split differently; ~15
occurrences; folding it (and the wider `am`/`a m` family) shifts every affected
provider's score, so it is **Abhishek's decision, still open** — see T-133 in
`docs/backlog/good-to-have.md`, mined by `src/mine-reading-pairs.ts`.

## Entities

Entity checks use a third form, `normalizeEntity()`: upper-case, and every
character that is not a letter or a digit removed. `RO-4471` becomes `RO4471`.
A provider is credited when that string appears **anywhere** inside its
normalized transcript.

## Known gaps — stated, not hidden

1. **`[inaudible]` has no policy.** A reviewer who writes `[inaudible]` in gold
   leaves the literal word `inaudible` in the reference: brackets are
   punctuation, so they become spaces, and the word survives. Measured: gold
   `the unit is [inaudible] four` against a provider's `the unit is 4` scores
   **WER 0.2 with one deletion** — the provider is charged for not transcribing
   a marker no human said. Until a policy exists, **do not type `[inaudible]`
   into a gold transcript**; leave the stretch out, or flag the call as hard.
2. **Entity matching is a substring match**, so a provider that heard `44712`
   is credited with the entity `4471`. Measured: `entityAccuracy` 1.0 on a
   transcript whose WER is 0.2 for that very word. It over-credits; it never
   under-credits.
3. **`normalizationVersion` on a stored score is hard-coded `"v1"`** and has
   never moved, even though normalization itself changed when `SCORING_VERSION`
   went to `v2` (spoken digits) and again at `v3` (speaker labels).
   `scoringVersion` is the field that actually tells you which rules produced a
   row; treat `normalizationVersion` as decoration until it is either
   maintained or removed.
4. **Speaker labels counted as words — closed 2026-09-04 by M-2 (`v3`).** Vapi's
   draft is written as `AI: …` / `User: …` lines; colons are punctuation, so `ai` and
   `user` used to survive as words — `AI: Hey. Thanks…` normalised to
   `ai hey thanks…`, one deletion per line for every provider. Rule 0 above now
   strips them, so a gold pasted from a draft no longer needs its labels removed by
   hand. Scores stored before `v3` still carry the charge; `scoringVersion` on the
   row says which rules produced it.
5. **The audio was the mixed recording (found 2026-09-04, fixed by M-5).** 71 % of
   scored words were the assistant's TTS voice. Nothing in scoring changes for this —
   the fix is which bytes the run sends — but any number produced before M-5 is a
   number on mixed audio, and the result row's `audioSource` says which.

## When any of this changes

Bump `SCORING_VERSION` in `lib/scoring/src/index.ts` in the same commit. Every
stored score row carries the version that produced it, which is the only way a
later re-score can tell "I reproduced the original" from "the rules moved under
me". Then update this page — and say what moved, so a number that changed has a
reason on file.
