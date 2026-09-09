/**
 * R-12. The provider rows this API seeds on first read (ensureDefaultProviders
 * in routes/benchmark.ts). Moved out of that route module so the invariant
 * below it can be unit-tested: importing routes/benchmark.ts pulls in
 * @workspace/db, whose module body throws without DATABASE_URL and opens a
 * pool -- and vitest.config.ts says out loud that nothing under src/ which
 * touches the database is a target here. Pure data, no imports.
 */
export const defaultProviders = [
  {
    id: "deepgram-nova-3",
    name: "Deepgram",
    model: "Nova-3",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.0043,
    keywordBoosting: true,
    configNote:
      "Current Rush baseline. Planning price only; verify contract and current VAPI model mapping.",
  },
  {
    id: "assemblyai-universal",
    name: "AssemblyAI",
    model: "Universal",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.006,
    keywordBoosting: true,
    configNote:
      "Verify current Universal model version, streaming parity, and custom vocabulary behavior.",
  },
  {
    id: "openai-gpt-4o-transcribe",
    name: "OpenAI",
    model: "gpt-4o-transcribe",
    supportsStreaming: false,
    supportsDiarization: false,
    costPerMinute: 0.006,
    keywordBoosting: false,
    configNote:
      "Keep as a batch reference unless current VAPI streaming support and latency meet the protocol.",
  },
  {
    id: "elevenlabs-scribe",
    name: "ElevenLabs",
    model: "Scribe",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.0065,
    keywordBoosting: false,
    configNote:
      "Verify model version, streaming price, diarization semantics, and vocabulary controls.",
  },
  {
    id: "gladia-solaria",
    name: "Gladia",
    model: "Solaria",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.0102,
    keywordBoosting: true,
    configNote:
      "Planning price reflects a non-volume tier; replace with negotiated volume pricing before ranking.",
  },
  {
    id: "speechmatics",
    name: "Speechmatics",
    model: "Realtime",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.004,
    keywordBoosting: true,
    configNote:
      "Verify realtime model, operating-point settings, diarization add-ons, and volume price.",
  },
  {
    id: "cartesia-ink-whisper",
    name: "Cartesia",
    model: "Ink-Whisper",
    supportsStreaming: true,
    supportsDiarization: false,
    costPerMinute: 0.0022,
    keywordBoosting: false,
    configNote:
      "Added on direct request, not in the original written ticket's list. WebSocket-streaming only (no batch REST endpoint), so this is the one provider with a real, measured time-to-first-partial instead of an untested 0. Planning price from public per-hour rate ($0.13/hr on the Scale plan); verify against current pricing and confirm the finalize/close handshake against a real key before trusting output.",
  },
  // 2026-08-27, per Abhishek: a vendor is not a model. These are the other
  // Deepgram models this corpus has real evidence for -- both were observed
  // as the live transcriber on Abhishek's own Vapi calls (flux-general-en on
  // 86 of 121, nova-2 on 2), which is exactly why they matter: the benchmark
  // was ranking candidates against a production baseline it never measured.
  //
  // Seeded manuallyDisabled so adding them costs nothing until someone opts
  // in on the Providers page. Cost per minute is copied from the nova-3 row
  // as a PLACEHOLDER -- confirm real per-model pricing before trusting any
  // ranking that turns on cost.
  {
    id: "deepgram-flux-general-en",
    name: "Deepgram",
    model: "Flux General EN",
    supportsStreaming: true,
    supportsDiarization: true,
    // T-62: verified against deepgram.com/pricing on 2026-08-29. Flux is
    // streaming-only; pay-as-you-go regular price $0.0077/min (a promotional
    // $0.0065 was showing that day -- list price is what gets quoted).
    // Nova-3's $0.0043 above is the PRE-RECORDED rate, which is what this
    // benchmark actually calls; Flux has no pre-recorded rate.
    costPerMinute: 0.0077,
    keywordBoosting: true,
    manuallyDisabled: true,
    configNote:
      "The model most of this corpus was actually recorded with in production (86 of 121 calls). Enable it to benchmark against the real baseline. Price: Deepgram pay-as-you-go regular streaming rate, verified 2026-08-29 (promo $0.0065 seen).",
  },
  {
    id: "deepgram-nova-2",
    name: "Deepgram",
    model: "Nova-2",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.0043,
    keywordBoosting: true,
    manuallyDisabled: true,
    configNote:
      "Observed on 2 calls in this corpus. Price is a placeholder copied from Nova-3 -- verify per-model pricing before relying on cost.",
  },
  // R-12. The streaming counterpart of deepgram-nova-3 above: the same model
  // string, a socket instead of a POST, so the two rows differ only in how
  // the audio reaches Deepgram -- which is the whole comparison. The adapter
  // and its catalog entry have existed since M-11a; the row never did, so the
  // id resolved to an adapter no run could select ("one or more providers do
  // not exist"). The test beside this file pins that gap shut for the next
  // adapter as well as this one.
  //
  // Seeded manuallyDisabled, which spends nothing. Note what that does NOT
  // buy, because M-11d's grill assumed it did: syncProviderReadiness()
  // derives status "disabled" from this flag, and POST /benchmark/runs
  // refuses any run naming a provider whose status is not "ready". So a
  // disabled row cannot be streamed to at all -- "create both rows disabled,
  // stream to them while disabled" does not work, and enabling has to happen
  // BEFORE the first live call rather than after it. Corrected in the
  // register where that plan was written.
  {
    id: "deepgram-nova-3-streaming",
    name: "Deepgram",
    model: "Nova-3 Streaming",
    supportsStreaming: true,
    // The streaming adapter sends diarize (deepgram-streaming.ts), unlike
    // Flux, whose documented parameter list has none.
    supportsDiarization: true,
    // PLACEHOLDER -- the one number in this entry that is not evidence.
    // Deepgram prices streaming and pre-recorded separately: nova-3's
    // $0.0043 above is the PRE-RECORDED rate and would understate this row,
    // and $0.0077 is the *Flux* streaming regular rate verified 2026-08-29,
    // for Flux and not for nova-3. No nova-3 streaming rate has been read
    // off the pricing page by anyone here. Carried rather than left null
    // because hybridCompositeScore scores a null cost as the cheapest
    // possible (O-37) and cost is 15% of the composite, so an unpriced row
    // would outrank a priced one the moment someone enabled it. M-11d reads
    // the real rate before this row is trusted for cost.
    costPerMinute: 0.0077,
    // M-19a: nova-3 boosts through `keyterm`, and the streaming adapter
    // sends it.
    keywordBoosting: true,
    manuallyDisabled: true,
    configNote:
      "Nova-3 over a WebSocket instead of the batch endpoint -- the same model, so this row measures transport, not recognition. No Deepgram socket has ever been opened from this repo: the handshake, the finalize sequence and the latencies are all unverified until M-11d streams one live call. Price is a PLACEHOLDER (Flux's streaming rate, not a nova-3 streaming rate) -- verify it before trusting any ranking that turns on cost.",
  },
] as const;
