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
