import { describe, expect, it, vi } from "vitest";
import { parseAssemblyAiResponse } from "./assemblyai";
import {
  cartesiaEncodingForBitDepth,
  endOfAudioLatencyMs,
  parseWavPcm,
  reduceCartesiaTranscript,
} from "./cartesia";
import { deepgramAdapter, parseDeepgramResponse } from "./deepgram";
import {
  deepgramFluxAdapter,
  deepgramFluxDiarizationScore,
  deepgramFluxSocketArgs,
  reduceDeepgramFluxTranscript,
  type DeepgramFluxEvent,
} from "./deepgram-flux";
import {
  deepgramEncodingForBitDepth,
  deepgramStreamChunkBytes,
  deepgramStreamDiarizationScore,
  deepgramStreamSocketArgs,
  deepgramStreamingAdapter,
  reduceDeepgramStreamTranscript,
  type DeepgramStreamEvent,
} from "./deepgram-streaming";
import {
  getProviderApiModel,
  getProviderAdapter,
  listProviderAdapters,
  providerCatalog,
  providerRegistry,
  vendorOf,
  vendorOfProviderId,
} from "../registry";
import { parseElevenLabsResponse } from "./elevenlabs";
import { parseGladiaResponse } from "./gladia";
import { parseOpenAiResponse } from "./openai";
import { parseSpeechmaticsTranscript } from "./speechmatics";

// These exercise each adapter's pure response parser against fixture JSON
// shaped like each vendor's documented response, without any network call --
// they can run with zero API keys configured (PRO-01 dependency: live
// integration tests still require real keys and are out of scope here).

describe("parseDeepgramResponse", () => {
  it("extracts transcript and detects >1 speaker as diarized", () => {
    const parsed = parseDeepgramResponse({
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: "unit twelve b needs a new filter",
                words: [{ speaker: 0 }, { speaker: 1 }],
              },
            ],
          },
        ],
      },
    });
    expect(parsed.transcript).toBe("unit twelve b needs a new filter");
    expect(parsed.diarizationScore).toBe(1);
  });

  it("returns null transcript for an empty payload", () => {
    expect(parseDeepgramResponse({}).transcript).toBeNull();
  });
});

describe("parseAssemblyAiResponse", () => {
  it("returns text on completed status", () => {
    const parsed = parseAssemblyAiResponse({ status: "completed", text: "hello there" });
    expect(parsed.transcript).toBe("hello there");
    expect(parsed.errorMessage).toBeNull();
  });

  it("surfaces the error message on failed status instead of a null-swallow", () => {
    const parsed = parseAssemblyAiResponse({ status: "error", error: "audio_url unreachable" });
    expect(parsed.transcript).toBeNull();
    expect(parsed.errorMessage).toBe("audio_url unreachable");
  });
});

describe("parseOpenAiResponse", () => {
  it("extracts text on success", () => {
    expect(parseOpenAiResponse({ text: "vin one h g c m" }).transcript).toBe("vin one h g c m");
  });

  it("surfaces API error body instead of treating it as an empty transcript", () => {
    const parsed = parseOpenAiResponse({ error: { message: "invalid_request_error" } });
    expect(parsed.transcript).toBeNull();
    expect(parsed.errorMessage).toBe("invalid_request_error");
  });
});

describe("parseElevenLabsResponse", () => {
  it("extracts text and diarization from words[].speaker_id", () => {
    const parsed = parseElevenLabsResponse({
      text: "load number four four one two",
      words: [{ speaker_id: "spk_0" }, { speaker_id: "spk_1" }],
    });
    expect(parsed.transcript).toBe("load number four four one two");
    expect(parsed.diarizationScore).toBe(1);
  });

  it("surfaces `detail` as an error rather than a blank transcript", () => {
    const parsed = parseElevenLabsResponse({ detail: "quota_exceeded" });
    expect(parsed.errorMessage).toBe("quota_exceeded");
  });
});

describe("parseGladiaResponse", () => {
  it("extracts full_transcript on done status", () => {
    const parsed = parseGladiaResponse({
      status: "done",
      result: { transcription: { full_transcript: "property inspection scheduled" } },
    });
    expect(parsed.transcript).toBe("property inspection scheduled");
  });

  it("surfaces error_code on error status", () => {
    const parsed = parseGladiaResponse({ status: "error", error_code: 422 });
    expect(parsed.errorMessage).toContain("422");
  });
});

describe("parseSpeechmaticsTranscript", () => {
  it("joins token alternatives into a transcript and detects diarization", () => {
    const parsed = parseSpeechmaticsTranscript({
      results: [
        { alternatives: [{ content: "hello", speaker: "S1" }] },
        { alternatives: [{ content: ",", speaker: "S1" }] },
        { alternatives: [{ content: "trucking", speaker: "S2" }] },
      ],
    });
    expect(parsed.transcript).toBe("hello, trucking");
    expect(parsed.diarizationScore).toBe(1);
  });

  it("returns empty string (not null/throw) when results are absent", () => {
    expect(parseSpeechmaticsTranscript({}).transcript).toBe("");
  });
});

// Cartesia is WebSocket streaming, not a batch/URL REST call, so there's no
// single JSON response to parse -- instead these test the two pieces that
// don't require a live socket: WAV-header parsing (to find/slice raw PCM
// for streaming) and reducing a sequence of received messages into a final
// transcript + first-partial latency.
function buildMonoPcmWav(opts: {
  sampleRate: number;
  bitsPerSample: number;
  numChannels?: number;
  audioFormat?: number;
  samples: number[];
}): Buffer {
  const numChannels = opts.numChannels ?? 1;
  const audioFormat = opts.audioFormat ?? 1;
  const bytesPerSample = opts.bitsPerSample / 8;
  const dataBytes = opts.samples.length * bytesPerSample * numChannels;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(audioFormat, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(opts.sampleRate, 24);
  buf.writeUInt32LE(opts.sampleRate * numChannels * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(numChannels * bytesPerSample, 32); // block align
  buf.writeUInt16LE(opts.bitsPerSample, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (const sample of opts.samples) {
    if (opts.bitsPerSample === 16) {
      buf.writeInt16LE(sample, offset);
      offset += 2;
    } else {
      buf.writeInt32LE(sample, offset);
      offset += 4;
    }
  }
  return buf;
}

describe("parseWavPcm", () => {
  it("locates the data chunk and reports format for a 16-bit mono WAV", () => {
    const wav = buildMonoPcmWav({ sampleRate: 16000, bitsPerSample: 16, samples: [1, 2, 3, -4] });
    const info = parseWavPcm(wav);
    expect(info.sampleRate).toBe(16000);
    expect(info.bitsPerSample).toBe(16);
    expect(info.numChannels).toBe(1);
    expect(info.dataOffset).toBe(44);
    expect(info.dataLength).toBe(8);
  });

  it("throws on non-RIFF input rather than silently guessing a format", () => {
    expect(() => parseWavPcm(Buffer.from("not a wav file"))).toThrow(/RIFF\/WAVE/);
  });

  it("throws on stereo input rather than silently downmixing", () => {
    const wav = buildMonoPcmWav({
      sampleRate: 16000,
      bitsPerSample: 16,
      numChannels: 2,
      samples: [1, 2, 3, 4],
    });
    expect(() => parseWavPcm(wav)).toThrow(/mono/);
  });

  it("throws on compressed (non-PCM) audio format codes", () => {
    const wav = buildMonoPcmWav({
      sampleRate: 16000,
      bitsPerSample: 16,
      audioFormat: 7, // mu-law, not PCM
      samples: [1, 2],
    });
    expect(() => parseWavPcm(wav)).toThrow(/Unsupported WAV audio format/);
  });
});

describe("cartesiaEncodingForBitDepth", () => {
  it("maps 16-bit to pcm_s16le and 32-bit to pcm_s32le", () => {
    expect(cartesiaEncodingForBitDepth(16)).toBe("pcm_s16le");
    expect(cartesiaEncodingForBitDepth(32)).toBe("pcm_s32le");
  });

  it("throws on an unsupported bit depth", () => {
    expect(() => cartesiaEncodingForBitDepth(8)).toThrow(/Unsupported PCM bit depth/);
  });
});

describe("reduceCartesiaTranscript", () => {
  it("joins only is_final segments and times the first non-empty partial", () => {
    const result = reduceCartesiaTranscript(
      [
        { message: { type: "transcript", is_final: false, text: "load" }, receivedAtMs: 1300 },
        { message: { type: "transcript", is_final: true, text: "load number" }, receivedAtMs: 1800 },
        { message: { type: "transcript", is_final: true, text: "four four one two" }, receivedAtMs: 2400 },
      ],
      1000,
    );
    expect(result.transcript).toBe("load number four four one two");
    expect(result.firstPartialMs).toBe(300);
    expect(result.errorMessage).toBeNull();
  });

  it("surfaces an error message instead of returning a blank transcript", () => {
    const result = reduceCartesiaTranscript(
      [{ message: { type: "error", message: "invalid encoding" }, receivedAtMs: 1200 }],
      1000,
    );
    expect(result.transcript).toBeNull();
    expect(result.errorMessage).toBe("invalid encoding");
  });

  it("returns null transcript (not empty string) when nothing final ever arrived", () => {
    const result = reduceCartesiaTranscript([], 1000);
    expect(result.transcript).toBeNull();
    expect(result.firstPartialMs).toBeNull();
    expect(result.lastFinalMs).toBeNull();
  });

  // M-10b. lastFinalMs anchors end-of-audio latency, so it has to track the
  // last segment that CONTRIBUTED TEXT -- not the last message of any kind.
  it("times the last final segment, ignoring later partials and non-final chatter", () => {
    const result = reduceCartesiaTranscript(
      [
        { message: { type: "transcript", is_final: true, text: "load number" }, receivedAtMs: 1800 },
        { message: { type: "transcript", is_final: true, text: "four four one two" }, receivedAtMs: 2400 },
        { message: { type: "transcript", is_final: false, text: "and" }, receivedAtMs: 2900 },
        { message: { type: "flush_done" }, receivedAtMs: 3500 },
      ],
      1000,
    );
    expect(result.lastFinalMs).toBe(1400);
  });

  it("does not count an is_final segment that carried no text", () => {
    const result = reduceCartesiaTranscript(
      [
        { message: { type: "transcript", is_final: true, text: "load number" }, receivedAtMs: 1800 },
        { message: { type: "transcript", is_final: true, text: "" }, receivedAtMs: 2600 },
      ],
      1000,
    );
    expect(result.transcript).toBe("load number");
    expect(result.lastFinalMs).toBe(800);
  });
});

describe("endOfAudioLatencyMs", () => {
  it("measures from the last audio chunk out to the last final segment in", () => {
    expect(endOfAudioLatencyMs(9_400, 8_600)).toBe(800);
  });

  it("is null, not zero, when either anchor was never observed", () => {
    expect(endOfAudioLatencyMs(null, 8_600)).toBeNull();
    expect(endOfAudioLatencyMs(9_400, null)).toBeNull();
    expect(endOfAudioLatencyMs(null, null)).toBeNull();
  });

  // The truncated-stream shape: the vendor's last text predates the last
  // chunk we sent, so no transcription happened after the audio ended.
  // 11% of the 207 live Cartesia rows measured this way. Zero would read as
  // "instant", which is the opposite of what that row means.
  it("is null, not negative and not zero, when the last final predates the last chunk", () => {
    expect(endOfAudioLatencyMs(5_000, 8_600)).toBeNull();
  });

  it("keeps a genuine zero-length gap distinguishable from an unmeasured one", () => {
    expect(endOfAudioLatencyMs(8_600, 8_600)).toBe(0);
  });
});

// ---- M-11a: Deepgram nova-3 over the streaming socket ----
//
// Same shape of coverage as the Cartesia block above and for the same
// reason: this adapter has no single JSON response to parse, so what is
// testable without a live socket is the chunking arithmetic, the encoding
// check, and the reduction of a received message sequence.

function dgResults(opts: {
  atMs: number;
  transcript: string;
  isFinal?: boolean;
  words?: Array<{ word: string; start: number; end: number; confidence?: number; speaker?: number }>;
}): DeepgramStreamEvent {
  return {
    receivedAtMs: opts.atMs,
    message: {
      type: "Results",
      is_final: opts.isFinal ?? false,
      channel: { alternatives: [{ transcript: opts.transcript, words: opts.words ?? [] }] },
    },
  };
}

describe("deepgramStreamChunkBytes", () => {
  // The point of deriving the size instead of hardcoding one: at every
  // sample rate a chunk must carry the SAME amount of time, because the send
  // loop's interval is fixed. A constant byte count would stream 8 kHz audio
  // at half speed and 44.1 kHz audio at nearly three times real time, and
  // M-11's "must not send faster than real time" would be silently violated
  // by the file rather than by the code.
  it("carries 200 ms of audio at every sample rate", () => {
    for (const sampleRate of [8_000, 16_000, 24_000, 44_100, 48_000]) {
      const bytes = deepgramStreamChunkBytes({
        sampleRate,
        bitsPerSample: 16,
        numChannels: 1,
        audioFormat: 1,
        dataOffset: 44,
        dataLength: 0,
      });
      const ms = (bytes / (sampleRate * 2)) * 1000;
      expect(Math.round(ms)).toBe(200);
    }
  });

  it("matches the Cartesia constant for the 16 kHz mono case it was written for", () => {
    const bytes = deepgramStreamChunkBytes({
      sampleRate: 16_000,
      bitsPerSample: 16,
      numChannels: 1,
      audioFormat: 1,
      dataOffset: 44,
      dataLength: 0,
    });
    expect(bytes).toBe(6_400);
  });

  it("throws rather than returning a zero-length chunk that would spin forever", () => {
    expect(() =>
      deepgramStreamChunkBytes({
        sampleRate: 0,
        bitsPerSample: 16,
        numChannels: 1,
        audioFormat: 1,
        dataOffset: 44,
        dataLength: 0,
      }),
    ).toThrow(/chunk size/i);
  });
});

describe("deepgramEncodingForBitDepth", () => {
  it("maps 16-bit PCM to linear16", () => {
    expect(deepgramEncodingForBitDepth(16)).toBe("linear16");
  });

  // Guessing at an encoding for an unsupported depth sends audio the server
  // decodes as noise, and the nonsense transcript then scores as recognition
  // error rather than as a configuration failure.
  it("throws on a bit depth it has no verified encoding for", () => {
    expect(() => deepgramEncodingForBitDepth(32)).toThrow(/16-bit/);
    expect(() => deepgramEncodingForBitDepth(8)).toThrow(/16-bit/);
  });
});

describe("reduceDeepgramStreamTranscript", () => {
  it("joins the finished segments and ignores the interims that preceded them", () => {
    const events: DeepgramStreamEvent[] = [
      dgResults({ atMs: 1_400, transcript: "hi is" }),
      dgResults({ atMs: 1_900, transcript: "hi is this" }),
      dgResults({ atMs: 2_300, transcript: "hi is this the letting office", isFinal: true }),
      dgResults({ atMs: 5_100, transcript: "yes it" }),
      dgResults({ atMs: 6_000, transcript: "yes it is", isFinal: true }),
    ];
    const out = reduceDeepgramStreamTranscript(events, 1_000);
    expect(out.transcript).toBe("hi is this the letting office yes it is");
    expect(out.errorMessage).toBeNull();
  });

  // Time to first partial is time to the first message carrying text, which
  // is an interim. Reading it off the first FINAL instead would quietly
  // report a much larger number under the same label.
  it("takes the first-partial anchor from an interim, not from the first final", () => {
    const events: DeepgramStreamEvent[] = [
      dgResults({ atMs: 1_100, transcript: "" }),
      dgResults({ atMs: 1_400, transcript: "hi is" }),
      dgResults({ atMs: 2_300, transcript: "hi is this the letting office", isFinal: true }),
    ];
    const out = reduceDeepgramStreamTranscript(events, 1_000);
    expect(out.firstPartialMs).toBe(400);
    expect(out.lastFinalMs).toBe(1_300);
  });

  // M-10b's anchor: the instant the transcript stopped growing. A final
  // message carrying no text is the server tidying up, not transcription,
  // and moving the anchor onto it would inflate every end-of-audio number by
  // however long that took.
  it("does not move the last-final anchor onto an empty final message", () => {
    const events: DeepgramStreamEvent[] = [
      dgResults({ atMs: 2_300, transcript: "hi is this the letting office", isFinal: true }),
      dgResults({ atMs: 9_800, transcript: "", isFinal: true }),
    ];
    expect(reduceDeepgramStreamTranscript(events, 1_000).lastFinalMs).toBe(1_300);
  });

  it("reports an error frame instead of the text that arrived before it", () => {
    const events: DeepgramStreamEvent[] = [
      dgResults({ atMs: 1_400, transcript: "hi is", isFinal: true }),
      { receivedAtMs: 1_800, message: { type: "Error", description: "payload too large" } },
    ];
    const out = reduceDeepgramStreamTranscript(events, 1_000);
    expect(out.transcript).toBeNull();
    expect(out.errorMessage).toBe("payload too large");
  });

  it("returns null, not an empty string, when nothing final ever arrived", () => {
    const out = reduceDeepgramStreamTranscript(
      [dgResults({ atMs: 1_400, transcript: "hi is" })],
      1_000,
    );
    expect(out.transcript).toBeNull();
    expect(out.lastFinalMs).toBeNull();
  });

  it("ignores Metadata and other message types rather than crashing on them", () => {
    const events: DeepgramStreamEvent[] = [
      { receivedAtMs: 1_100, message: { type: "Metadata", request_id: "abc" } },
      dgResults({ atMs: 1_400, transcript: "hello", isFinal: true }),
      { receivedAtMs: 1_500, message: { type: "UtteranceEnd", last_word_end: 1.2 } },
    ];
    expect(reduceDeepgramStreamTranscript(events, 1_000).transcript).toBe("hello");
  });
});

describe("deepgramStreamDiarizationScore", () => {
  // Deliberately the same coarse rule parseDeepgramResponse applies to the
  // batch shape: the batch nova-3 row and the streaming one exist to be
  // compared, so a second rule here would make that a comparison of rules.
  it("scores 1 when the finished segments carried a speaker label", () => {
    const events = [
      dgResults({
        atMs: 2_000,
        transcript: "hello",
        isFinal: true,
        words: [{ word: "hello", start: 0.1, end: 0.4, speaker: 0 }],
      }),
    ];
    expect(deepgramStreamDiarizationScore(events)).toBe(1);
  });

  it("scores 0 when words came back without labels", () => {
    const events = [
      dgResults({
        atMs: 2_000,
        transcript: "hello",
        isFinal: true,
        words: [{ word: "hello", start: 0.1, end: 0.4 }],
      }),
    ];
    expect(deepgramStreamDiarizationScore(events)).toBe(0);
  });

  it("is null, not zero, when there was nothing to score", () => {
    expect(deepgramStreamDiarizationScore([])).toBeNull();
    expect(
      deepgramStreamDiarizationScore([dgResults({ atMs: 2_000, transcript: "hello" })]),
    ).toBeNull();
  });
});

describe("registry resolution with two Deepgram adapters", () => {
  it("sends the streaming id to the streaming adapter", () => {
    expect(getProviderAdapter("deepgram-nova-3-streaming")).toBe(deepgramStreamingAdapter);
    expect(getProviderApiModel("deepgram-nova-3-streaming")).toBe("nova-3");
  });

  // The hazard M-11a introduced: adapterByVendorPrefix returns the FIRST
  // adapter whose vendor prefix matches, and both Deepgram adapters declare
  // vendor "deepgram". Every id below resolved to the batch adapter before
  // this change and must still, including deepgram-nova, which is a live
  // enabled row that is in no catalog and resolves by prefix alone.
  it("leaves every pre-existing deepgram id on the batch adapter", () => {
    expect(getProviderAdapter("deepgram-nova-3")).toBe(deepgramAdapter);
    expect(getProviderAdapter("deepgram-nova-2")).toBe(deepgramAdapter);
    expect(getProviderAdapter("deepgram-nova")).toBe(deepgramAdapter);
    // deepgram-flux-general-en used to be asserted here too. That assertion
    // pinned a bug: Flux is streaming-only, so the batch adapter it resolved
    // to had no endpoint that could serve it. M-11c repointed it; the
    // replacement assertion is in the test below.
  });

  // M-11c. The repair itself, and the reason the step exists.
  it("sends the flux id to the flux adapter, keeping its model string", () => {
    expect(getProviderAdapter("deepgram-flux-general-en")).toBe(deepgramFluxAdapter);
    expect(getProviderApiModel("deepgram-flux-general-en")).toBe("flux-general-en");
  });

  it("keeps the flux row in the Deepgram vendor bucket", () => {
    expect(vendorOfProviderId("deepgram-flux-general-en")).toBe("deepgram");
  });

  // Found by M-11c's break test. getProviderAdapter checks the exact registry
  // key BEFORE the catalog, and deepgram-flux-general-en is now both -- it is
  // the flux adapter's own providerId. So the catalog's adapterId for that id
  // is never read, and repointing it back at the batch adapter (the exact bug
  // this step fixes) changed nothing any behavioural test could see.
  //
  // Asserted as an invariant over every entry rather than for flux alone,
  // because the trap is structural: it springs for any catalog id that is
  // also an adapter's own id, and it leaves the two structures stating
  // different things about the same row with only one of them consulted.
  it("never lets a catalog entry name a different adapter than the one that serves it", () => {
    for (const [providerId, entry] of Object.entries(providerCatalog)) {
      const named = providerRegistry[entry.adapterId];
      expect(named, `catalog entry ${providerId} names unknown adapter ${entry.adapterId}`)
        .toBeDefined();
      expect(getProviderAdapter(providerId), `catalog entry ${providerId} is not the adapter that serves it`)
        .toBe(named);
    }
  });

  it("keeps the streaming row in the Deepgram vendor bucket", () => {
    // Concurrency limits, confidence extraction and timed-word extraction
    // all switch on this. A different vendor key would give the streaming
    // row its own rate-limit bucket against the same Deepgram account.
    expect(vendorOfProviderId("deepgram-nova-3-streaming")).toBe("deepgram");
  });

  // /benchmark/providers/models filters to adapters that declare listModels
  // and groups them by vendor, so a second Deepgram adapter declaring one
  // would render two Deepgram cards on Setup.
  it("leaves exactly one Deepgram adapter declaring a model list", () => {
    const listers = listProviderAdapters().filter(
      (a) => vendorOf(a) === "deepgram" && typeof a.listModels === "function",
    );
    expect(listers).toHaveLength(1);
    expect(listers[0]).toBe(deepgramAdapter);
  });
});

describe("deepgramStreamSocketArgs (M-11e)", () => {
  const opts = () => ({
    model: "nova-3",
    encoding: "linear16",
    sampleRate: 16000,
    channels: 1,
    diarize: true,
  });

  it("carries the credential in the subprotocol, never in the URL", () => {
    const key = "dg-live-secret-value";
    const { url, protocols } = deepgramStreamSocketArgs(key, opts());
    expect(url).not.toContain(key);
    expect(url).not.toContain("token=");
    expect(protocols).toEqual(["token", key]);
  });

  it("does not smuggle a key with URL-special characters in encoded", () => {
    const key = "a/b+c=d e";
    const { url } = deepgramStreamSocketArgs(key, opts());
    const asAParam = new URLSearchParams({ v: key }).toString().slice(2);
    expect(url).not.toContain(key);
    expect(url).not.toContain(asAParam);
    expect(url).not.toContain(encodeURIComponent(key));
  });

  it("still addresses v1 listen and carries the parameters deepgram.ts sends", () => {
    const { url } = deepgramStreamSocketArgs("secret", opts());
    expect(url.startsWith("wss://api.deepgram.com/v1/listen?")).toBe(true);
    expect(url).toContain("model=nova-3");
    expect(url).toContain("encoding=linear16");
    expect(url).toContain("sample_rate=16000");
    expect(url).toContain("channels=1");
    expect(url).toContain("smart_format=true");
    expect(url).toContain("diarize=true");
    expect(url).toContain("interim_results=true");
  });

  it("appends every keyword boost and still no credential", () => {
    const key = "boost-secret";
    const { url } = deepgramStreamSocketArgs(key, { ...opts(), keywordBoosts: ["Ellavox", "Vapi"] });
    expect(url).toContain("keywords=Ellavox");
    expect(url).toContain("keywords=Vapi");
    expect(url).not.toContain(key);
  });
});

describe("deepgramStreamingAdapter socket wiring (M-11e)", () => {
  it("hands the credential to the socket as a subprotocol, not on the URL", async () => {
    const key = "dg-wiring-secret-999";
    const seen: Array<{ url: string; protocols: unknown }> = [];
    const originalWs = globalThis.WebSocket;
    const originalKey = process.env.DEEPGRAM_API_KEY;
    // Throws on construction, which is the one place transcribe() settles
    // before any timer exists -- so this test never opens a socket, never
    // waits, and never leaves a handle pending.
    class ThrowingWebSocket {
      constructor(url: string, protocols?: unknown) {
        seen.push({ url, protocols });
        throw new Error("stub refused the connection");
      }
    }
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = ThrowingWebSocket;
    process.env.DEEPGRAM_API_KEY = key;
    try {
      const result = await deepgramStreamingAdapter.transcribe({
        callId: "call-m11e",
        audioBytes: buildMonoPcmWav({ sampleRate: 16000, bitsPerSample: 16, samples: [0, 1, -1, 0] }),
      });
      expect(result.status).toBe("failed");
      // The guard M-11a added: a thrown constructor's message is written
      // verbatim into a persisted, rendered field, so it must be a constant.
      expect(result.errorMessage ?? "").not.toContain(key);
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWs;
      if (originalKey === undefined) delete process.env.DEEPGRAM_API_KEY;
      else process.env.DEEPGRAM_API_KEY = originalKey;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.protocols).toEqual(["token", key]);
    expect(seen[0]!.url).not.toContain(key);
  });
});


describe("deepgramFluxSocketArgs (M-11c)", () => {
  const opts = () => ({ model: "flux-general-en", encoding: "linear16", sampleRate: 16000 });

  it("carries the credential in the subprotocol, never in the URL", () => {
    const key = "dg-flux-secret-value";
    const { url, protocols } = deepgramFluxSocketArgs(key, opts());
    expect(url).not.toContain(key);
    expect(url).not.toContain("token=");
    expect(protocols).toEqual(["token", key]);
  });

  it("does not smuggle a key with URL-special characters in encoded", () => {
    const key = "a/b+c=d e";
    const { url } = deepgramFluxSocketArgs(key, opts());
    const asAParam = new URLSearchParams({ v: key }).toString().slice(2);
    expect(url).not.toContain(key);
    expect(url).not.toContain(asAParam);
    expect(url).not.toContain(encodeURIComponent(key));
  });

  it("addresses the v2 endpoint, not v1", () => {
    const { url } = deepgramFluxSocketArgs("secret", opts());
    expect(url.startsWith("wss://api.deepgram.com/v2/listen?")).toBe(true);
    expect(url).toContain("model=flux-general-en");
    expect(url).toContain("encoding=linear16");
    expect(url).toContain("sample_rate=16000");
  });

  // The step's Must-not: no parameter the v2 reference does not document.
  // Each of these IS documented on v1 and is sent by deepgram-streaming.ts,
  // so copying that adapter's parameter block across is the likely mistake.
  it("sends none of the v1-only parameters", () => {
    const { url } = deepgramFluxSocketArgs("secret", {
      ...opts(),
      keywordBoosts: ["Ellavox"],
    });
    expect(url).not.toContain("channels=");
    expect(url).not.toContain("smart_format=");
    expect(url).not.toContain("diarize=");
    expect(url).not.toContain("interim_results=");
    expect(url).not.toContain("keywords=");
  });

  it("spells keyword boosts keyterm, once per term, with no credential", () => {
    const key = "flux-boost-secret";
    const { url } = deepgramFluxSocketArgs(key, {
      ...opts(),
      keywordBoosts: ["Ellavox", "Vapi"],
    });
    expect(url).toContain("keyterm=Ellavox");
    expect(url).toContain("keyterm=Vapi");
    expect(url).not.toContain(key);
  });
});

describe("reduceDeepgramFluxTranscript (M-11c)", () => {
  const at = (ms: number, message: DeepgramFluxEvent["message"]): DeepgramFluxEvent => ({
    message,
    receivedAtMs: 1_000 + ms,
  });

  it("joins the EndOfTurn transcripts in order", () => {
    const out = reduceDeepgramFluxTranscript(
      [
        at(100, { type: "Connected" }),
        at(200, { type: "TurnInfo", event: "StartOfTurn", turn_index: 0, transcript: "" }),
        at(300, { type: "TurnInfo", event: "Update", turn_index: 0, transcript: "hello" }),
        at(400, { type: "TurnInfo", event: "EndOfTurn", turn_index: 0, transcript: "hello there" }),
        at(900, { type: "TurnInfo", event: "EndOfTurn", turn_index: 1, transcript: "second turn" }),
      ],
      1_000,
    );
    expect(out.transcript).toBe("hello there second turn");
    expect(out.errorMessage).toBeNull();
  });

  // The step's Must-not. EagerEndOfTurn is a prediction; TurnResumed retracts
  // it. Scoring it as final puts words the speaker went on to contradict into
  // a transcript that is then compared against a gold one.
  it("never treats EagerEndOfTurn as final, including when TurnResumed retracts it", () => {
    const out = reduceDeepgramFluxTranscript(
      [
        at(100, { type: "TurnInfo", event: "EagerEndOfTurn", turn_index: 0, transcript: "cancel my" }),
        at(200, { type: "TurnInfo", event: "TurnResumed", turn_index: 0, transcript: "cancel my" }),
        at(300, { type: "TurnInfo", event: "EndOfTurn", turn_index: 0, transcript: "cancel my appointment please" }),
      ],
      1_000,
    );
    expect(out.transcript).toBe("cancel my appointment please");
    expect(out.transcript).not.toContain("cancel my cancel my");
  });

  it("anchors first-partial on the first turn carrying text, not the first final", () => {
    const out = reduceDeepgramFluxTranscript(
      [
        at(100, { type: "TurnInfo", event: "StartOfTurn", turn_index: 0, transcript: "" }),
        at(250, { type: "TurnInfo", event: "Update", turn_index: 0, transcript: "hel" }),
        at(800, { type: "TurnInfo", event: "EndOfTurn", turn_index: 0, transcript: "hello" }),
      ],
      1_000,
    );
    expect(out.firstPartialMs).toBe(250);
    expect(out.lastFinalMs).toBe(800);
  });

  it("anchors last-final on the last turn that contributed text", () => {
    const out = reduceDeepgramFluxTranscript(
      [
        at(300, { type: "TurnInfo", event: "EndOfTurn", turn_index: 0, transcript: "only words" }),
        // A final turn that settles with nothing in it must not move the
        // anchor: M-10b measures when the transcript stopped growing.
        at(1200, { type: "TurnInfo", event: "EndOfTurn", turn_index: 1, transcript: "   " }),
      ],
      1_000,
    );
    expect(out.transcript).toBe("only words");
    expect(out.lastFinalMs).toBe(300);
  });

  it("reports a fatal error and returns no transcript", () => {
    const out = reduceDeepgramFluxTranscript(
      [
        at(100, { type: "TurnInfo", event: "EndOfTurn", turn_index: 0, transcript: "partial words" }),
        at(200, { type: "FatalError", description: "unsupported encoding" }),
      ],
      1_000,
    );
    expect(out.errorMessage).toBe("unsupported encoding");
    expect(out.transcript).toBeNull();
  });

  it("returns null rather than an empty string when nothing settled", () => {
    const out = reduceDeepgramFluxTranscript(
      [at(100, { type: "TurnInfo", event: "Update", turn_index: 0, transcript: "hel" })],
      1_000,
    );
    expect(out.transcript).toBeNull();
    expect(out.lastFinalMs).toBeNull();
  });
});

describe("deepgramFluxDiarizationScore (M-11c)", () => {
  // Absent is not zero. Zero is what deepgram-streaming.ts scores a response
  // that could have carried speaker labels and did not; Flux was never asked,
  // because its documented parameter list has no diarize at all.
  it("is null, never 0, even when the turns are full of words", () => {
    expect(deepgramFluxDiarizationScore()).toBeNull();
  });
});

describe("deepgramFluxAdapter (M-11c)", () => {
  it("declares the id the catalog and the database already use", () => {
    expect(deepgramFluxAdapter.providerId).toBe("deepgram-flux-general-en");
    expect(vendorOf(deepgramFluxAdapter)).toBe("deepgram");
    // A third Deepgram adapter declaring listModels would render a third
    // Deepgram card on Setup -- /benchmark/providers/models filters to the
    // adapters that have one and groups them by vendor.
    expect(deepgramFluxAdapter.listModels).toBeUndefined();
  });

  // v2 documents no `channels` parameter, so multi-channel audio cannot be
  // described to Flux and must never reach the socket. The refusal happens
  // inside parseWavPcm today; this asserts it at THIS adapter's boundary, so
  // relaxing parseWavPcm for another vendor fails here rather than silently
  // streaming interleaved samples to Deepgram as if they were mono.
  //
  // The WebSocket is stubbed to throw, so if that ever regresses the test
  // fails fast on the failureClass instead of opening a real connection:
  // a thrown constructor yields "unknown", never "audio_decode".
  it("refuses multi-channel audio instead of streaming it as if it were mono", async () => {
    const originalWs = globalThis.WebSocket;
    const original = process.env.DEEPGRAM_API_KEY;
    class RefusingWebSocket {
      constructor() {
        throw new Error("stub refused the connection");
      }
    }
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = RefusingWebSocket;
    process.env.DEEPGRAM_API_KEY = "dg-flux-mono-guard";
    try {
      const result = await deepgramFluxAdapter.transcribe({
        callId: "call-m11c-stereo",
        audioBytes: buildMonoPcmWav({
          sampleRate: 16000,
          bitsPerSample: 16,
          numChannels: 2,
          samples: [0, 1, -1, 0],
        }),
      });
      expect(result.status).toBe("failed");
      expect(result.failureClass).toBe("audio_decode");
      expect(result.errorMessage ?? "").toMatch(/mono/i);
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWs;
      if (original === undefined) delete process.env.DEEPGRAM_API_KEY;
      else process.env.DEEPGRAM_API_KEY = original;
    }
  });

  // Found by M-11c's break test: halving the send interval -- streaming at
  // 2x real time -- passed every test. It would not be a wrong transcript, it
  // would be a wrong LATENCY, which is the entire reason this adapter exists,
  // and it would look plausible. M-11d's acceptance requires the adapter to
  // have never sent audio faster than real time; this is where that is
  // checked, because a live run cannot see its own send timestamps.
  it("streams at real time: one second of wall clock sends one second of audio", async () => {
    const bytesPerSecond = 16000 * 2; // 16 kHz, 16-bit, mono
    const originalWs = globalThis.WebSocket;
    const originalKey = process.env.DEEPGRAM_API_KEY;
    let sentBytes = 0;
    let openHandler: (() => void) | null = null;
    let closeHandler: ((e: { code: number }) => void) | null = null;

    class PacedWebSocket {
      addEventListener(type: string, handler: (e: never) => void) {
        if (type === "open") openHandler = handler as () => void;
        if (type === "close") closeHandler = handler as (e: { code: number }) => void;
      }
      send(payload: unknown) {
        // JSON control frames (CloseStream) are not audio.
        if (typeof payload !== "string") sentBytes += (payload as Buffer).length;
      }
      close() {
        closeHandler?.({ code: 1000 });
      }
    }

    vi.useFakeTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = PacedWebSocket;
    process.env.DEEPGRAM_API_KEY = "dg-flux-pacing";
    try {
      // Four seconds of audio, so one second in there is plenty left to send.
      const pending = deepgramFluxAdapter.transcribe({
        callId: "call-m11c-pacing",
        audioBytes: buildMonoPcmWav({
          sampleRate: 16000,
          bitsPerSample: 16,
          samples: new Array(16000 * 4).fill(0),
        }),
      });
      await Promise.resolve();
      openHandler!();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sentBytes).toBeGreaterThan(0);
      expect(sentBytes).toBeLessThanOrEqual(bytesPerSecond);

      closeHandler!({ code: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      await pending;
    } finally {
      vi.useRealTimers();
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWs;
      if (originalKey === undefined) delete process.env.DEEPGRAM_API_KEY;
      else process.env.DEEPGRAM_API_KEY = originalKey;
    }
  });

  it("hands the credential to the socket as a subprotocol, not on the URL", async () => {
    const key = "dg-flux-wiring-secret-999";
    const seen: Array<{ url: string; protocols: unknown }> = [];
    const originalWs = globalThis.WebSocket;
    const originalKey = process.env.DEEPGRAM_API_KEY;
    // Throws on construction, which is the one place transcribe() settles
    // before any timer exists -- so this test never opens a socket, never
    // waits, and never leaves a handle pending.
    class ThrowingWebSocket {
      constructor(url: string, protocols?: unknown) {
        seen.push({ url, protocols });
        throw new Error("stub refused the connection");
      }
    }
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = ThrowingWebSocket;
    process.env.DEEPGRAM_API_KEY = key;
    try {
      const result = await deepgramFluxAdapter.transcribe({
        callId: "call-m11c",
        audioBytes: buildMonoPcmWav({ sampleRate: 16000, bitsPerSample: 16, samples: [0, 1, -1, 0] }),
      });
      expect(result.status).toBe("failed");
      // A thrown constructor's message is written verbatim into a persisted,
      // rendered field, so it must be a constant that repeats no argument.
      expect(result.errorMessage ?? "").not.toContain(key);
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWs;
      if (originalKey === undefined) delete process.env.DEEPGRAM_API_KEY;
      else process.env.DEEPGRAM_API_KEY = originalKey;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.protocols).toEqual(["token", key]);
    expect(seen[0]!.url).not.toContain(key);
    expect(seen[0]!.url).toContain("/v2/listen?");
  });
});
