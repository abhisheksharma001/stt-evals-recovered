# STT Benchmark — Provider Capability Matrix

**⚠ Important disclaimers:**
- All pricing figures in this document are **UNVERIFIED PLACEHOLDERS**. Do not use for financial decisions. Verify against the current provider pricing page and any applicable contract before any benchmark run.
- All capability claims marked "✓ (claimed)" or "? (unverified)" must be confirmed against current API documentation before integration is built. Provider APIs change without notice.
- This matrix was last reviewed: **[DATE TO BE FILLED AT IMPLEMENTATION TIME]**

---

## Capability Checklist

| Capability | Deepgram Nova-3 | AssemblyAI Universal | OpenAI gpt-4o-transcribe | OpenAI Whisper | ElevenLabs Scribe | Gladia | Speechmatics | Cartesia Ink-Whisper |
|------------|:--------------:|:-------------------:|:------------------------:|:--------------:|:-----------------:|:------:|:------------:|:--------------------:|
| **Streaming / Real-time API** | ✓ (claimed) | ✓ (claimed) | ? unverified | ✗ (batch only) | ? unverified | ✓ (claimed) | ✓ (claimed) | ✓ (streaming-**only** -- no batch endpoint exists) |
| **Diarization (speaker labels)** | ✓ (claimed) | ✓ (claimed) | ? unverified | ✗ | ? unverified | ✓ (claimed) | ✓ (claimed) | ✗ (not exposed by this API per current docs) |
| **Word-level timestamps** | ✓ (claimed) | ✓ (claimed) | ? unverified | ✓ (claimed) | ? unverified | ✓ (claimed) | ✓ (claimed) | ✓ (claimed, `words[]` on transcript messages) |
| **Confidence scores per word** | ✓ (claimed) | ✓ (claimed) | ✗ | ✓ (model logprob) | ? unverified | ✓ (claimed) | ✓ (claimed) | ? unverified |
| **Keyword / phrase boosting** | ✓ (claimed) | ✓ (claimed) | ✗ | ✗ | ? unverified | ✓ (claimed) | ✓ (claimed) | ? unverified |
| **Custom vocabulary / model** | ✓ (claimed) | ? unverified | ✗ | ✓ (fine-tune) | ? unverified | ? unverified | ✓ (claimed) | ? unverified |
| **Multichannel audio** | ✓ (claimed) | ✓ (claimed) | ? unverified | ? unverified | ? unverified | ✓ (claimed) | ✓ (claimed) | ✗ (adapter requires mono input, see below) |
| **Training data opt-out** | ? verify V3 | ? verify V3 | ? verify V3 | ? verify V3 | ? verify V3 | ? verify V3 | ? verify V3 | ? verify V3 |
| **DPA available** | ? verify V4 | ? verify V4 | ? verify V4 | ? verify V4 | ? verify V4 | ? verify V4 | ? verify V4 | ? verify V4 |
| **Audio not retained post-call** | ? verify V5 | ? verify V5 | ? verify V5 | ? verify V5 | ? verify V5 | ? verify V5 | ? verify V5 | ? verify V5 |

**Legend:**
- `✓ (claimed)` — Provider documents this capability; must be verified in API before use
- `✗` — Provider does not offer this capability (as of last review date above — verify)
- `? unverified` — Not confirmed; must be checked before integration

---

## Per-Provider Configuration Details

### Deepgram Nova-3

| Field | Value / Notes |
|-------|--------------|
| **Model identifier** | `nova-3` (verify current model name at `https://developers.deepgram.com/docs/models`) |
| **API endpoint (batch)** | `POST https://api.deepgram.com/v1/listen` |
| **API endpoint (streaming)** | WebSocket `wss://api.deepgram.com/v1/listen` |
| **Auth** | `Authorization: Token {DEEPGRAM_API_KEY}` |
| **Audio formats supported** | MP3, WAV, FLAC, OGG, others — verify current list |
| **Diarization parameter** | `diarize=true` (query param — verify) |
| **Keyword boosting parameter** | `keywords=term:boost` (verify syntax and boost range) |
| **Max audio duration** | Verify — may vary by plan |
| **Cost/minute** | **UNVERIFIED** — check `https://deepgram.com/pricing` at implementation time |
| **Rate tier for benchmark** | Pay-as-you-go vs. committed — verify which applies |
| **Training opt-out** | Verify in account settings or via DPA |

**Open configuration questions (must answer before P1-T4):**
1. Does Nova-3 support multichannel stereo audio for diarization, or mono only?
2. What is the maximum keyword boost weight, and does boosting affect WER on non-boosted words?
3. Is streaming available on all plan tiers, or only Enterprise?
4. What is the format of word-level timestamps in the response JSON? (Confirm field names for latency instrumentation)

---

### AssemblyAI Universal

| Field | Value / Notes |
|-------|--------------|
| **Model identifier** | `universal` or `best` (verify current alias at `https://www.assemblyai.com/docs`) |
| **API endpoint** | Two-step async: `POST /upload` then `POST /transcript` then poll `GET /transcript/{id}` |
| **Auth** | `Authorization: {ASSEMBLYAI_API_KEY}` header |
| **Audio formats supported** | Most common formats — verify current list |
| **Diarization parameter** | `speaker_labels: true` (verify field name) |
| **Keyword boosting parameter** | `word_boost` array + `boost_param` (verify syntax) |
| **Max audio duration** | Verify — may require file upload for long audio |
| **Cost/minute** | **UNVERIFIED** — check `https://www.assemblyai.com/pricing` at implementation time |
| **Training opt-out** | Verify — AssemblyAI has previously offered DPA; confirm current policy |

**Open configuration questions (must answer before P1-T5):**
1. The two-step async pattern means `submitted_at` and `final_at` must be measured across the polling loop — confirm harness design handles this correctly and `first_partial_at` will be null (batch model)
2. Is there a synchronous (non-polling) endpoint for short audio? If so, use it for shorter calls to reduce latency inflation from polling interval
3. Does `word_boost` accept phonetic spellings for number strings (e.g., VINs read phonetically)?
4. What is the maximum items in the `word_boost` array?

---

### OpenAI gpt-4o-transcribe

| Field | Value / Notes |
|-------|--------------|
| **Model identifier** | `gpt-4o-transcribe` (verify exact name — may differ from ChatGPT interface name) |
| **API endpoint** | `POST https://api.openai.com/v1/audio/transcriptions` (verify — may share Whisper endpoint) |
| **Auth** | `Authorization: Bearer {OPENAI_API_KEY}` |
| **Audio formats supported** | MP3, MP4, MPEG, MPGA, M4A, WAV, WEBM — verify for gpt-4o-transcribe specifically |
| **Diarization parameter** | **UNVERIFIED** — not documented in Whisper API; verify if gpt-4o-transcribe adds this |
| **Keyword boosting parameter** | `prompt` field (provides context but is not guaranteed boosting) |
| **Max audio file size** | 25 MB (Whisper) — verify if gpt-4o-transcribe inherits this limit |
| **Streaming** | **UNVERIFIED** — Whisper is batch-only; verify if gpt-4o-transcribe adds streaming |
| **Cost/minute** | **UNVERIFIED** — check `https://openai.com/pricing` under Audio models at implementation time |
| **Training opt-out** | Requires API usage policy opt-out — verify current mechanism |

**Open configuration questions (must answer before P1-T6):**
1. Is `gpt-4o-transcribe` a distinct model or an alias on the same endpoint as Whisper? This affects whether it is one provider record or two in the DB.
2. Does the `prompt` parameter provide reliable entity boosting or is it purely for style guidance?
3. Is there a timestamp granularity parameter (word vs. segment)?
4. Confirm file size limit — calls > 25 MB will need chunking or format conversion

---

### OpenAI Whisper

| Field | Value / Notes |
|-------|--------------|
| **Model identifier** | `whisper-1` |
| **API endpoint** | `POST https://api.openai.com/v1/audio/transcriptions` |
| **Auth** | Same as gpt-4o-transcribe |
| **Audio formats supported** | Same as above |
| **Diarization parameter** | Not supported |
| **Keyword boosting parameter** | `prompt` field only (not true boosting) |
| **Max audio file size** | 25 MB |
| **Streaming** | Not supported (batch only) |
| **Cost/minute** | **UNVERIFIED** — check `https://openai.com/pricing` at implementation time |
| **Training opt-out** | Same as gpt-4o-transcribe |

**Configuration notes:**
- Whisper is included as a baseline comparison for gpt-4o-transcribe
- Use identical call audio and settings (except model) for a direct comparison
- `first_partial_at` will be null for both OpenAI models

---

### ElevenLabs Scribe

| Field | Value / Notes |
|-------|--------------|
| **Model identifier** | `scribe_v1` or similar — verify at `https://elevenlabs.io/docs` |
| **API endpoint** | Verify — ElevenLabs primarily known for TTS; Scribe is STT product; confirm endpoint |
| **Auth** | `xi-api-key: {ELEVENLABS_API_KEY}` (verify header name) |
| **Audio formats supported** | **UNVERIFIED** — check current docs |
| **Diarization parameter** | **UNVERIFIED** — check current docs |
| **Keyword boosting parameter** | **UNVERIFIED** — check current docs |
| **Streaming** | **UNVERIFIED** — check current docs |
| **Cost/minute** | **UNVERIFIED** — check `https://elevenlabs.io/pricing` at implementation time |
| **Training opt-out** | **UNVERIFIED** — check current ToS and DPA availability |

**Open configuration questions (must answer before P1-T7):**
1. Is the Scribe product GA (generally available) or in beta? Beta products may have breaking API changes during the benchmark period.
2. Does Scribe support diarization? If not, document as missing capability per §8 of logic-register.
3. What is the maximum audio file size and duration?
4. Is there a DPA available for ElevenLabs? This is a blocker (V4) — verify before sending any audio.

---

### Gladia

| Field | Value / Notes |
|-------|--------------|
| **Model identifier** | Gladia uses third-party models — verify which ASR engine underlies current offering |
| **API endpoint** | `POST https://api.gladia.io/audio/text/audio-transcription/` (verify — may have changed) |
| **Auth** | `x-gladia-key: {GLADIA_API_KEY}` (verify header name) |
| **Audio formats supported** | Verify current list |
| **Diarization parameter** | `toggle_diarization: true` (verify field name and tier availability) |
| **Keyword boosting parameter** | `custom_vocabulary` array (verify) |
| **Streaming** | Real-time WebSocket available — verify endpoint |
| **Cost/minute** | **UNVERIFIED** — check `https://www.gladia.io/pricing` at implementation time. Note: Gladia has multiple tiers (transcription-only vs. audio intelligence) with different pricing. |
| **Training opt-out** | Verify |

**Open configuration questions (must answer before P3-T2):**
1. Is diarization available on the pay-as-you-go tier, or does it require an enterprise plan?
2. What is the underlying ASR engine? If it changes between benchmark runs, results are not comparable.
3. Does the `custom_vocabulary` parameter behave as hard boosting or as soft context?
4. Is there a code-switching or accent configuration parameter?

---

### Speechmatics

| Field | Value / Notes |
|-------|--------------|
| **Model identifier** | Verify current model version at `https://docs.speechmatics.com` |
| **API endpoint (batch)** | `POST https://asr.api.speechmatics.com/v2/jobs/` (verify) |
| **API endpoint (real-time)** | WebSocket — verify current URL |
| **Auth** | `Authorization: Bearer {SPEECHMATICS_API_KEY}` (verify) |
| **Audio formats supported** | Verify current list |
| **Diarization parameter** | `diarization: "speaker"` in job config (verify) |
| **Keyword boosting parameter** | `additional_vocab` with `content` and optional `sounds_like` fields (verify) |
| **Streaming** | Real-time API available — different pricing from batch |
| **Cost/minute** | **UNVERIFIED** — check `https://www.speechmatics.com/pricing` at implementation time. Batch and real-time may have different rates. |
| **Training opt-out** | Verify — Speechmatics offers enterprise terms; check current policy |

**Open configuration questions (must answer before P3-T2):**
1. Should benchmark use batch API or real-time API? Batch is simpler; real-time enables TTFP measurement but may cost more. Resolve per logic-register §5 and execution-plan P3-T2 logic gate.
2. Does `sounds_like` in `additional_vocab` allow phonetic VIN boosting? If so, this is a significant differentiator.
3. What is the maximum number of items in `additional_vocab`?
4. Is English the default language model, or must it be specified explicitly?

---

### Cartesia Ink-Whisper

Added on direct request, not in the original written ticket's candidate list --
see docs/PRD.md and docs/HANDOFF.md. WebSocket-streaming only (no batch REST
endpoint), so this is the one provider with a real, measured time-to-first-partial
instead of an untested 0 -- see docs/HANDOFF.md and the adapter's `firstPartialMs`
capture. Planning price from the public per-hour rate ($0.13/hr on the Scale
plan, below); verify against current pricing and confirm the finalize/close
handshake (open question #1 below) against a real key before trusting output.

| Field | Value / Notes |
|-------|--------------|
| **Model identifier** | `ink-whisper` |
| **API endpoint (batch)** | **None** -- confirmed against current docs, Cartesia STT has no batch/URL endpoint, only streaming |
| **API endpoint (streaming)** | WebSocket `wss://api.cartesia.ai/stt/websocket` |
| **Auth** | `X-API-Key` header (server-to-server) or `access_token` query param (browser/no-custom-headers contexts). This adapter uses `access_token` since Node's built-in `WebSocket` can't set custom headers. |
| **Required query params** | `model=ink-whisper`, `encoding` (`pcm_s16le`/`pcm_s32le`/etc.), `sample_rate`, `cartesia_version` (pinned to `2026-08-14` in the adapter -- verify this is still current before relying on it) |
| **Audio format sent** | Raw PCM only, no container. This adapter parses a WAV header, requires mono PCM (16- or 32-bit int), and streams the raw sample bytes in ~200ms chunks. It throws (does not silently downmix/transcode) on stereo, compressed, or non-WAV input. |
| **Diarization parameter** | None found in current docs -- treat as unsupported until confirmed otherwise |
| **Keyword boosting parameter** | Not found in current docs -- **unverified** |
| **Cost/minute** | **UNVERIFIED PLACEHOLDER** — public rate is ~$0.13/hr on the Scale plan (~$0.0022/min); confirm against `https://www.cartesia.ai/pricing` and your actual plan tier before any decision-grade run |
| **Training opt-out** | ? verify V3 |

**Open configuration questions (must answer before trusting this adapter's output):**
1. The exact `finalize`/`close` handshake is inferred from partial docs, not confirmed live: this adapter sends `finalize` once all audio is streamed, then waits `IDLE_CLOSE_MS` (2s) of silence before sending `close` itself. Verify against a real connection whether the server closes on its own after a final transcript, or expects the client to.
2. Whether stereo/multichannel audio is supported at all (docs didn't cover it) -- if Vapi ever records stereo, this adapter currently refuses rather than guessing.
3. Whether there's a maximum audio duration or idle-connection timeout on Cartesia's side that this adapter's `RESPONSE_TIMEOUT_MS` (120s) needs to be tuned against for longer calls.
4. Whether diarization or keyword boosting exist under a different parameter name than searched.

---

## Verification Workflow

For each provider, complete the following before integration:

```
[ ] Read current API documentation end-to-end (not cached / not from third-party summary)
[ ] Verify every capability marked "✓ (claimed)" or "? unverified" in the matrix above
[ ] Complete vendor data-handling verification (docs/data-governance.md §4)
[ ] Answer all open configuration questions for the provider
[ ] Update this matrix with verified values and date
[ ] Create provider record in DB with config_hash and config_note referencing this verification
```

**Do not begin provider integration until the vendor data-handling verification (data-governance.md §4.1) is complete. This is a hard gate.**

---

## Pricing Verification Protocol

1. At the start of each benchmark run phase, check the pricing page for every provider included in that run
2. Record the listed rate in the provider config's `config_note` with the date and URL checked
3. Set `rate_verified = false` initially; update to `true` only after comparing against an actual invoice
4. If a volume discount or enterprise contract applies, use the contracted rate and note the agreement reference
5. All cost figures in benchmark reports must be footnoted with the rate source and date

*Pricing figures are intentionally omitted from this matrix to prevent stale data from being treated as authoritative.*
