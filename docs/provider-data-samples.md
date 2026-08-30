# What data we actually get back — real examples

Every sample below is real data pulled from our own test calls today (not made up, not
from docs). Trimmed to the interesting parts — the full responses have a lot more
noise (internal IDs, feature flags we don't use, etc.).

Same call used for all 4 STT providers where possible, so you can compare like-for-like:
a ~9 second trucking call, "This is Josh with Watt. Got a second?"

---

## 1. Vapi — the call recording source

Vapi is where the phone call itself lives. We pull two things from it per call:

- **The audio file link** (a temporary, signed download URL — expires in 30 minutes,
  which is why the app re-fetches it fresh every time instead of storing it)
- **Vapi's own transcript** — Vapi already runs its own STT provider on every call
  (visible below, this call used **Deepgram**) to power the live AI agent. We call this
  the "draft" transcript. It's a useful starting point for a human reviewer to correct
  into the "gold" (ground-truth) transcript, but it must never be graded as if it were
  one of our candidate providers' outputs — see the caveat at the bottom.

```json
{
  "id": "019fedaf-549c-7000-8625-582e741edd7f",
  "status": "ended",
  "endedReason": "customer-ended-call",
  "startedAt": "2026-08-10T21:58:38.944Z",
  "endedAt": "2026-08-10T21:58:49.798Z",
  "transcript": "AI: This is Josh with Watt. Got a second?\n",

  "costs": [
    {
      "type": "transcriber",
      "transcriber": { "provider": "deepgram", "model": "flux-general-en" }
    }
  ],

  "artifact": {
    "presignedMonoUrl": "https://hipaa-recordings.<account>.r2.cloudflarestorage.com/019fedaf-...-mono.wav?X-Amz-Algorithm=...&X-Amz-Expires=1800&X-Amz-Signature=...",
    "presignedUrlsExpiresAt": "2026-08-24T16:41:25Z"
  }
}
```

**What's useful here:** `costs[].transcriber` tells us which provider Vapi itself used
for the live call. This specific call used **Deepgram** — meaning if we ever score
Deepgram as a candidate on this exact call, its "draft" transcript and its "candidate"
transcript could come from the exact same engine, which would make Deepgram look
artificially accurate on this call. We now record this per call so we can flag it (see
caveat below).

---

## 2. AssemblyAI

You send a link to the audio file; AssemblyAI fetches it themselves and sends back one
JSON blob with the full transcript, word-by-word timing, AND a confidence score per word
**and** for the whole transcript.

```json
{
  "text": "This is Josh with Watt. Got a second?",
  "confidence": 0.9925851,
  "words": [
    { "text": "This", "start": 1261, "end": 1395, "confidence": 0.9935, "speaker": "A" },
    { "text": "is",   "start": 1395, "end": 1467, "confidence": 0.9998, "speaker": "A" },
    { "text": "Josh", "start": 1467, "end": 1611, "confidence": 0.8760, "speaker": "A" }
  ]
}
```

**Confidence:** yes — 0.0 to 1.0, both per-word and for the whole transcript.

---

## 3. Deepgram

Same idea — send a link, get back one JSON blob. Also gives confidence per word AND
for the whole transcript, plus (bonus) a separate `speaker_confidence` per word.

```json
{
  "results": {
    "channels": [{
      "alternatives": [{
        "transcript": "This is Josh with Watt. Got a second?",
        "confidence": 0.9980469,
        "words": [
          { "word": "this", "start": 2.88, "end": 3.20, "confidence": 1.0,     "speaker": 0, "speaker_confidence": 1.0 },
          { "word": "is",   "start": 3.20, "end": 3.36, "confidence": 0.9980, "speaker": 0, "speaker_confidence": 1.0 },
          { "word": "josh", "start": 3.36, "end": 3.68, "confidence": 0.9780, "speaker": 0, "speaker_confidence": 1.0 }
        ]
      }]
    }]
  }
}
```

**Confidence:** yes — 0.0 to 1.0, per-word and for the whole transcript. Also gives a
separate speaker-confidence number per word (how sure it is about *who* said it, not
just *what* they said).

---

## 4. Gladia

Same shape idea, organized into "utterances" (chunks of continuous speech from one
speaker) each containing words. Confidence at both the utterance level and the word level.

```json
{
  "result": {
    "transcription": {
      "full_transcript": "This is Josh with Watt. Got a second?",
      "utterances": [
        {
          "text": "This is Josh with Watt. Got a second?",
          "confidence": 0.93,
          "speaker": 0,
          "words": [
            { "word": "This", "start": 1.28, "end": 1.42, "confidence": 0.86 },
            { "word": "is",   "start": 1.42, "end": 1.54, "confidence": 0.99 }
          ]
        }
      ]
    }
  }
}
```

**Confidence:** yes — 0.0 to 1.0, per-word and per-utterance (a chunk of speech, not
the whole call at once like the other two).

---

## 5. Cartesia

Different shape entirely — this one is a live, streaming connection (like a phone line
staying open), not a single "send file, get file back." It sends us small pieces of
the transcript as the call plays, tagged `is_final` once a piece is locked in.

```json
{ "type": "transcript", "is_final": true, "text": " This is Josh with Watt. Got a second?",
  "duration": 4.265, "language": "en",
  "words": [
    { "word": " This", "start": 1.97, "end": 2.17 },
    { "word": " is",   "start": 2.17, "end": 2.33 },
    { "word": " Josh", "start": 2.33, "end": 2.60 }
  ]
}
```

**Confidence: no.** Checked Cartesia's real response directly (not just their docs) —
there is no confidence number anywhere, per-word or overall. Also checked their public
docs to be sure this isn't a flag we're just not requesting; it isn't documented as
available at all right now. This is a real gap if we want a "low confidence → flag as
possibly distorted audio" feature across all 4 providers evenly — Cartesia can't
currently participate in that.

---

## What this means for "flag distorted audio"

3 of 4 providers (AssemblyAI, Deepgram, Gladia) already hand us a confidence number —
we're just not capturing or using it yet. Cartesia doesn't have one at all. A
distorted/garbled moment in a call would very likely show up as a string of low
confidence scores in a row from those 3, which is exactly the kind of thing a
threshold could catch automatically instead of a human having to notice it by ear.

Real open questions before building this (not yet decided):
- What counts as "low"? AssemblyAI's own docs suggest 0.4–0.5 as a starting point for
  flagging a word for review — that's a documentation suggestion, not something we've
  tested against our own calls yet.
- One bad word vs. a run of bad words in a row probably needs different handling — a
  single low-confidence word might just be an unusual name; several in a row is a much
  stronger "something's wrong with the audio here" signal.
- Where should this show up — a flag on the call in Review? A column in Results?

## The draft-transcript bias risk, made concrete

The Vapi sample above shows call `019fedaf...` used **Deepgram** as its own live
transcriber. We just added Deepgram as a candidate provider today. If we ever score
Deepgram against a call where Deepgram was also the draft source, that comparison is
unfair to the other providers — Deepgram gets a head start because the "gold" transcript
a human corrected started out already agreeing with Deepgram's own words.

## Vapi assistant `transcriber` — can the STT provider be switched per assistant? (T-93, verified 2026-08-30)

**Yes. The transcriber is a per-assistant setting, and Vapi's own API accepts it on
update.** Register Q-1 is answered; a verdict is something a person can act on.

Read live, `GET https://api.vapi.ai/assistant/b3914788-3dc5-473c-b534-3d02b7848b29`
(org "Land And Apartment", key from `VAPI_API_KEY_LAND_AND_APARTMENT`; read-only, no
write was made):

```json
{
  "name": "[PROD] Waterside Apartments Leasing",
  "transcriber": {
    "provider": "deepgram",
    "model": "flux-general-en",
    "language": "en",
    "fallbackPlan": {
      "transcribers": [
        { "provider": "assembly-ai", "language": "en", "formatTurns": true, "disablePartialTranscripts": false }
      ]
    }
  }
}
```

Two things this shows that the corpus columns (`sourceTranscriberProvider/Model`)
did not: the production transcriber carries a **`fallbackPlan`** (here AssemblyAI
behind Deepgram Flux) — so "what runs in production" is a primary plus a fallback,
and the baseline line on Results names only the primary; and `flux-general-en` is
Vapi's model id for Deepgram Flux, which is why the catalog match in
`useProductionBaseline` normalises names before comparing.

Write side, from Vapi's published OpenAPI (`GET https://api.vapi.ai/api-json`, fetched
2026-08-30): `PATCH /assistant/{id}` takes `UpdateAssistantDTO`, whose `transcriber`
property is a `oneOf` over these providers:

`AssemblyAITranscriber, AzureSpeechTranscriber, CustomTranscriber,
DeepgramTranscriber, ElevenLabsTranscriber, GladiaTranscriber, GoogleTranscriber,
SpeechmaticsTranscriber, TalkscriberTranscriber, OpenAITranscriber,
CartesiaTranscriber, SonioxTranscriber, XaiTranscriber, VapiTranscriber`

Every provider this tool benchmarks (AssemblyAI, Cartesia, Deepgram, ElevenLabs,
Gladia, OpenAI, Speechmatics) is a Vapi transcriber option, so any winner the
verdict names can be applied to the assistant with one PATCH. **Not exercised** —
PATCHing a production assistant is a write with live consequences and is nobody's
call but Abhishek's. If an "apply the verdict" button is ever wanted, this is the
endpoint, and it must be a confirmed, audit-logged action, never automatic.


## Which benchmarked providers share a base model? (Q-2 / T-100, researched 2026-08-30)

Why it matters: two providers built on the same base model tend to make the *same*
mistakes, so their agreement is not two independent votes (T-18's
`excessAgreement` exists for exactly this). The question was open since T-18.

| Provider id | Base model | Source (vendor's own statement unless noted) |
|---|---|---|
| `cartesia-ink-whisper` | **Whisper** — Cartesia says Ink-Whisper was built from OpenAI `whisper-large-v3-turbo`, optimised for streaming. | https://www.cartesia.ai/blog/introducing-ink-speech-to-text |
| `gladia-solaria` | **Whisper lineage, likely.** Gladia's earlier production model "Whisper-Zero" is described by Gladia as "a complete rework of Whisper"; the Solaria-1 launch post gives **no** architecture statement at all. Third-party write-ups say Solaria-1 keeps the Whisper foundation + ensemble validators. Treat as "probably shared base", not confirmed. | https://www.gladia.io/blog/introducing-whisper-zero · https://www.gladia.io/blog/introducing-solaria-the-first-truly-universal-speech-to-text-model (fetched 2026-08-30: no architecture sentence) |
| `assemblyai-universal` | **Own** — Universal-2 is a 600M-parameter Conformer encoder + RNN-T decoder, pre-trained with BEST-RQ; not Whisper. | https://www.assemblyai.com/research/universal-2 · https://arxiv.org/abs/2404.09841 |
| `deepgram-nova-3` / `deepgram-flux-general-en` | **Own** — proprietary; Deepgram publishes no Whisper lineage. | https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/ (lists Nova as proprietary) |
| `openai-gpt-4o-transcribe` | **Own, not Whisper** — OpenAI states the model is GPT-4o fine-tuned for transcription (RL + audio mid-training); `whisper-1` is the separate Whisper endpoint. | https://openai.com/index/introducing-our-next-generation-audio-models/ |
| `elevenlabs-scribe` (no key yet) | **Own** — closed model, benchmarked by ElevenLabs *against* Whisper v3. | https://elevenlabs.io/blog/meet-scribe |
| `speechmatics` (no key yet) | **Own** — Ursa is proprietary. | https://arxiv.org/pdf/2503.06924 (lists Ursa-2 as proprietary) |

So on today's four live providers the only shared-base pair is **Cartesia + Gladia**.

**Does the data agree?** Live `provider-correlation` on bulk `340400b2` (56 shared
calls, 2026-08-30):

| Pair | agreement | excessAgreement |
|---|---|---|
| assemblyai ↔ gladia | 0.935 | **+0.039** (highest) |
| assemblyai ↔ deepgram | 0.911 | +0.023 |
| **cartesia ↔ gladia** | 0.912 | **+0.021** (third of ten) |
| deepgram ↔ gladia | 0.912 | +0.018 |
| cartesia ↔ deepgram | 0.883 | −0.000 |
| every pair with openai | 0.83–0.88 | −0.02 to −0.04 |

The Whisper pair is above average but not the outlier; the strongest excess
agreement is between two providers with *different* bases. Read: on phone audio at
this corpus size, shared base is a weak signal; do not weight votes by it. What the
table does show is that gpt-4o-transcribe disagrees with everyone — it is the one
genuinely independent reading, not the one to drop.

## Vapi assistant transcriber: fallback plan and boosted vocabulary (T-97, read live 2026-08-30)

Two more assistants read via `GET /assistant/{id}` (system prompt and voice
omitted; only `transcriber` shown):

```json
// 05103255 "Rush Truck Center - Service Female" (account: Default)
"transcriber": {
  "provider": "deepgram", "model": "flux-general-multi", "language": "en",
  "numerals": true, "eotThreshold": 0.7, "eotTimeoutMs": 5000, "confidenceThreshold": 0.24,
  "keyterm": ["Peterbilt", "Freightliner", "Kenworth", "Volvo", "Mack", ... 120 terms ...]
}
// b3914788 "[PROD] Waterside Apartments Leasing" (account: Land And Apartment)
"transcriber": {
  "provider": "deepgram", "model": "flux-general-en", "language": "en",
  "fallbackPlan": { "transcribers": [ { "provider": "assembly-ai", "language": "en", "formatTurns": true, "disablePartialTranscripts": false } ] }
}
```

What this means for the benchmark:

- **`fallbackPlan.transcribers`** is an ordered list; Vapi switches to the first
  entry when the primary fails mid-call. The per-call `costs[].transcriber` entry
  (what `transcriberOf()` reads) names whichever one actually ran, so a call that
  fell over to AssemblyAI is stored with `sourceTranscriberProvider = assembly-ai`.
  The Results baseline counts those as a different production provider — which
  they were, for that call.
- **`keyterm`** is Deepgram's vocabulary boost. The Rush assistant carries 120
  truck-parts terms; every candidate provider in the benchmark, *including
  Deepgram itself*, ran without them. "Production Deepgram beat benchmark
  Deepgram" is therefore expected on Rush calls and is not evidence about the
  model. `numerals: true` likewise formats spoken numbers as digits in
  production only.
- Read on the Results page as "Configured in Vapi: … · fallback … · N boosted
  keyterms" under the production baseline (`GET
  /benchmark/assistants/{id}/transcriber`, live, 10-minute cache, read-only).
  The account that owns the assistant is not stored; it is the org label most
  of the assistant's imported calls carry.

## Which STT models each vendor offers, and how to ask (T-104, verified 2026-08-30)

| Vendor | List API? | Verified today | Request parameter |
|---|---|---|---|
| Deepgram | **yes** — `GET https://api.deepgram.com/v1/models` (443 STT entries: `canonical_name`, `architecture`, `version`, `batch`, `streaming`); `nova-3-general` is what plain `model=nova-3` means | live | `model` query param |
| OpenAI | **yes** — `GET /v1/models`; STT ids 2026-08-30: `gpt-transcribe`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize`, `whisper-1` (+ realtime variants) | live | multipart `model` |
| AssemblyAI | no | docs: `speech_models` array, values `universal-3-5-pro`, `universal-2`; omitted = both, newest first. `speech_model` (singular, what old docs showed) is deprecated | `speech_models: [..]` |
| Gladia | no (`/v2/models` → 404) | docs: `model` = `solaria-1` (default) or `solaria-3` | `model` |
| Cartesia | no (`/models` → 404) | docs: only `ink-whisper` | `model` query param on the WebSocket URL |
| ElevenLabs | no | docs: `model_id` = `scribe_v2` (this repo's adapter sent `scribe_v1` until today) | multipart `model_id` |
| Speechmatics | not checked (no key) | — | — |

Consequence for the benchmark: `assemblyai-universal` has always sent **no** model, so
it runs whatever AssemblyAI's default is on the day (newest first). That is a moving
target and is now visible on the Setup page as "vendor default today".
