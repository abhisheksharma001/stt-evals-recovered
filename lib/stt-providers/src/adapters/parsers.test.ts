import { describe, expect, it } from "vitest";
import { parseAssemblyAiResponse } from "./assemblyai";
import {
  cartesiaEncodingForBitDepth,
  endOfAudioLatencyMs,
  parseWavPcm,
  reduceCartesiaTranscript,
} from "./cartesia";
import { deepgramAdapter, parseDeepgramResponse } from "./deepgram";
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
    expect(getProviderAdapter("deepgram-flux-general-en")).toBe(deepgramAdapter);
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
  const params = () =>
    new URLSearchParams({ model: "nova-3", encoding: "linear16", sample_rate: "16000" });

  it("carries the credential in the subprotocol, never in the URL", () => {
    const key = "dg-live-secret-value";
    const { url, protocols } = deepgramStreamSocketArgs(key, params());
    expect(url).not.toContain(key);
    expect(url).not.toContain("token=");
    expect(protocols).toEqual(["token", key]);
  });

  it("does not smuggle a key with URL-special characters in encoded", () => {
    const key = "a/b+c=d e";
    const { url } = deepgramStreamSocketArgs(key, params());
    const asAParam = new URLSearchParams({ v: key }).toString().slice(2);
    expect(url).not.toContain(key);
    expect(url).not.toContain(asAParam);
    expect(url).not.toContain(encodeURIComponent(key));
  });

  it("still addresses v1 listen and keeps every query parameter", () => {
    const { url } = deepgramStreamSocketArgs("secret", params());
    expect(url.startsWith("wss://api.deepgram.com/v1/listen?")).toBe(true);
    expect(url).toContain("model=nova-3");
    expect(url).toContain("encoding=linear16");
    expect(url).toContain("sample_rate=16000");
  });
});
