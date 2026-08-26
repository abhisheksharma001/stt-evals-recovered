import { describe, expect, it } from "vitest";
import { parseAssemblyAiResponse } from "./assemblyai";
import {
  cartesiaEncodingForBitDepth,
  parseWavPcm,
  reduceCartesiaTranscript,
} from "./cartesia";
import { parseDeepgramResponse } from "./deepgram";
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
  });
});
