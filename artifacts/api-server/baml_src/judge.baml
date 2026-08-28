// T-25: the transcript judge as a typed BAML function. Before this the pick
// came back as a free string that a regex over the reasoning prose had to
// rescue (src/lib/agent.ts, `inferPickFromReasoning`). Here the pick IS an
// enum: PickedProvider is `@@dynamic` and src/lib/agent.ts adds exactly the
// candidate provider IDs of the call being judged at runtime, so the parser
// can only ever return one of them -- anything else is a loud
// BamlValidationError, never a guess.

class Candidate {
  providerId string
  providerName string
  transcript string
}

class FlaggedSpan {
  text string
  reason string
}

enum PickedProvider {
  @@dynamic
}

class JudgeVerdict {
  pickedProviderId PickedProvider @description("The providerId of the candidate that reads most sensibly. Must be one of the listed candidate providerIds, verbatim.")
  reasoning string @description("Why this candidate is most sensible, referencing the flagged spans specifically.")
}

function JudgeCandidates(originalTranscript: string, flaggedSpans: FlaggedSpan[], candidates: Candidate[]) -> JudgeVerdict {
  client Judge
  prompt #"
    {{ _.role("system") }}
    You are comparing several speech-to-text providers' transcripts of the same call,
    after another pass flagged specific spans in an earlier transcript as likely wrong.
    Pick whichever candidate transcript reads most sensibly given the full conversation's
    context -- especially around the flagged spans. This is your best guess from text alone,
    not a certainty: a human will review your pick against the actual audio before it is
    trusted as correct, so explain your reasoning clearly rather than just asserting an answer.

    {{ _.role("user") }}
    ORIGINAL TRANSCRIPT (the one that was flagged):
    {{ originalTranscript }}

    FLAGGED SPANS:
    {% for f in flaggedSpans %}
    - "{{ f.text }}" -- {{ f.reason }}
    {% endfor %}

    CANDIDATES:
    {% for c in candidates %}
    === providerId: {{ c.providerId }} ({{ c.providerName }}) ===
    {{ c.transcript }}

    {% endfor %}

    {{ ctx.output_format }}
  "#
}
