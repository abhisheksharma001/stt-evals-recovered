// T-110: confidence extraction keys on the vendor, not the exact provider
// id -- a T-104 model row ("gladia-solaria-3") must read the same shape as
// the vendor's historical row.
import { describe, expect, it } from "vitest";
import { extractProviderConfidenceWords } from "./provider-confidence";

const assemblyBody = JSON.stringify({ words: [{ text: "hello", confidence: 0.99 }, { text: "there", confidence: 0.41 }] });
const gladiaBody = JSON.stringify({
  result: { transcription: { utterances: [{ words: [{ word: "one", confidence: 0.9 }, { word: "two", confidence: 0.3 }] }] } },
});
const deepgramBody = JSON.stringify({
  results: { channels: [{ alternatives: [{ words: [{ word: "four", confidence: 0.8 }] }] }] },
});

describe("extractProviderConfidenceWords (T-110, vendor-keyed)", () => {
  it("reads the historical ids exactly as before", () => {
    expect(extractProviderConfidenceWords("assemblyai-universal", assemblyBody)).toEqual([
      { word: "hello", confidence: 0.99 },
      { word: "there", confidence: 0.41 },
    ]);
    expect(extractProviderConfidenceWords("gladia-solaria", gladiaBody)).toHaveLength(2);
    expect(extractProviderConfidenceWords("deepgram-nova-3", deepgramBody)).toEqual([{ word: "four", confidence: 0.8 }]);
  });

  it("reads T-104 model rows of the same vendor (used to return null)", () => {
    expect(extractProviderConfidenceWords("assemblyai-universal-3-5-pro", assemblyBody)).toHaveLength(2);
    expect(extractProviderConfidenceWords("gladia-solaria-3", gladiaBody)).toHaveLength(2);
    expect(extractProviderConfidenceWords("deepgram-nova-2", deepgramBody)).toHaveLength(1);
    expect(extractProviderConfidenceWords("deepgram-flux-general-en", deepgramBody)).toHaveLength(1);
  });

  it("still returns null (not []) for vendors with no confidence", () => {
    expect(extractProviderConfidenceWords("cartesia-ink-whisper", JSON.stringify({ events: [] }))).toBeNull();
    expect(extractProviderConfidenceWords("openai-gpt-transcribe", JSON.stringify({ text: "x" }))).toBeNull();
  });
});
