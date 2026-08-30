// T-25: the transcript judge as a typed BAML function. Before this the pick
// came back as a free string that a regex over the reasoning prose had to
// rescue (src/lib/agent.ts, `inferPickFromReasoning`). Here the pick IS an
// enum: PickedProvider is `@@dynamic` and src/lib/agent.ts adds exactly the
// candidate provider IDs of the call being judged at runtime, so the parser
// can only ever return one of them -- anything else is a loud
// BamlValidationError, never a guess.
//
// T-102 (2026-08-30, per Abhishek: "work on each part of the prompt properly
// and the BAML things, to use it to its max potential"): the judge now
// (a) is told which differences are conventions and must not decide a pick
//     (the same list lib/scoring/src/equivalence.ts folds out before flags),
// (b) returns a typed confidence and the at-most-three differences that
//     actually change the meaning of the call, each with why,
// (c) is scored on "which transcript is a caller-facing agent safest to act
//     on", not "which reads nicest".
// The prompt hash in src/lib/judge-contract.ts covers this file; a change
// here needs `pnpm run judge:contract:record`.

class Candidate {
  providerId string
  providerName string
  transcript string
}

enum FlagKind {
  PeerDisagreement @description("This provider's words differ from the other providers' consensus on many positions")
  LowConfidence @description("The provider itself reported low confidence on these words")
  EntityMismatch @description("Providers disagree on a phone number, VIN, unit or order number")
}

class FlaggedSpan {
  text string
  reason string
  kind FlagKind?
}

enum PickedProvider {
  @@dynamic
}

enum Confidence {
  High @description("The meaning-changing differences all point the same way and the context makes the right reading clear")
  Medium @description("The pick is better on balance but at least one difference could go either way from text alone")
  Low @description("Text alone cannot settle it -- the candidates differ on something only the audio can decide")
}

class KeyDifference {
  span string @description("The disputed words, quoted from the picked candidate")
  alternatives string @description("What the other candidate(s) wrote there, named by providerName")
  matters string @description("One sentence: why this changes what the call means -- a number, a name, an address, an amount, yes vs no, a missing turn")
}

class JudgeVerdict {
  pickedProviderId PickedProvider @description("The providerId of the candidate an agent would be safest acting on. Must be one of the listed candidate providerIds, verbatim.")
  confidence Confidence
  keyDifferences KeyDifference[] @description("At most three, most consequential first. Only differences that change meaning. Empty when the candidates differ in convention only.")
  reasoning string @description("Two to five plain sentences a non-engineer can follow, naming the spans that decided it. No preamble, no restating the transcripts.") @assert(has_reasoning, {{ this|length > 20 }})
}

function JudgeCandidates(originalTranscript: string, flaggedSpans: FlaggedSpan[], candidates: Candidate[]) -> JudgeVerdict {
  client Judge
  prompt #"
    {{ _.role("system") }}
    You compare several speech-to-text providers' transcripts of the same phone call
    between a caller and a voice agent (truck-parts service desks, apartment leasing,
    trucking dispatch). An earlier automatic pass flagged spans where the providers
    split. Pick the candidate an agent would be SAFEST TO ACT ON -- the one most
    likely to carry the caller's numbers, names, addresses, amounts and yes/no
    answers correctly -- and say why in plain language.

    Rules:
    1. Conventions are not errors. Never let these decide the pick: hyphen vs space
       ("1-bedroom" / "1 bedroom"), a number written as a word or a digit ("forty" /
       "40", "fortyc" / "40c"), ordinals ("26th" / "26"), times ("10am" / "1 0 a m"),
       "gonna" / "going to", "ok" / "okay", "yeah" / "yes", "all right" / "alright",
       a stray "um" or "uh", punctuation, capitalisation, and regional spelling.
    2. Slang and casual words a caller really says ("sweet", "cool", "no worries",
       "ma'am") are correct transcription, not mistakes. Do not penalise them and do
       not prefer a candidate for "cleaning them up".
    3. What decides the pick, in this order: digits in phone numbers, unit / order /
       VIN / part numbers, dollar amounts, dates and times, street and business names,
       people's names, yes vs no, and whole turns that one candidate dropped.
    4. Shorter is not worse. A candidate that omits filler is not missing content;
       a candidate that omits a whole sentence is.
    5. Judge from context. "Tour 24" in a leasing call is more plausible than
       "tour to four"; a phone number has ten digits; an apartment number is short.
    6. Say what you cannot know. When the candidates differ only on something the
       audio alone can settle (which digit, which surname), pick the most plausible
       reading and mark confidence Low. A person will listen before anything is trusted.
    7. Ignore the flag reasons' wording; use the flagged spans as pointers to where to
       look, then read the whole conversation around them.

    {{ _.role("user") }}
    ORIGINAL TRANSCRIPT (the one that was flagged):
    {{ originalTranscript }}

    FLAGGED SPANS:
    {% for f in flaggedSpans %}
    - "{{ f.text }}"{% if f.kind %} [{{ f.kind }}]{% endif %} -- {{ f.reason }}
    {% endfor %}

    CANDIDATES:
    {% for c in candidates %}
    === providerId: {{ c.providerId }} ({{ c.providerName }}) ===
    {{ c.transcript }}

    {% endfor %}

    {{ ctx.output_format }}
  "#
}

// T-102: the failure triage, moved off the raw fetch + JSON-schema path
// onto BAML now that a full bulk (340400b2, 56/56 judged) has been judged
// through it -- the PRD's gate for migrating anything else.
class FailureAnalysis {
  diagnosis string @description("One or two sentences: the likely cause, only as far as the error text supports it")
  suggestedFix string @description("One or two sentences: a concrete next step for the operator")
  ambiguous bool @description("True when the error text alone does not say which cause it is")
}

function AnalyzeFailure(providerName: string, httpStatus: int?, errorMessage: string) -> FailureAnalysis {
  client Triage
  prompt #"
    {{ _.role("system") }}
    You help the operator of a speech-to-text benchmarking tool understand why one
    provider's transcription attempt failed for one call. Given the provider name, the
    HTTP status (if any) and the raw error message, give a short plain-English diagnosis
    of the likely cause and a concrete, actionable fix (for example "rotate the API key",
    "the audio file may be corrupt -- re-import this call", "this looks like a transient
    rate limit -- retry the cell"). Do not guess beyond what the error text supports; when
    the cause is genuinely ambiguous from the text alone, say so and set ambiguous to true.

    {{ _.role("user") }}
    provider: {{ providerName }}
    httpStatus: {{ httpStatus }}
    error: {{ errorMessage }}

    {{ ctx.output_format }}
  "#
}
