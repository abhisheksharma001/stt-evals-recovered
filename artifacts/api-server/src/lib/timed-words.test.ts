// T-48: word-timing extraction, on shapes read off real responses.
import { describe, expect, it } from "vitest";
import { extractProviderTimedWords } from "./timed-words";

describe("extractProviderTimedWords", () => {
  it("reads ElevenLabs Scribe words (seconds), skipping spacing entries", () => {
    // Shape captured live 2026-08-29 from POST /v1/speech-to-text (scribe_v1).
    const raw = JSON.stringify({
      language_code: "eng",
      text: "Hello there.",
      words: [
        { text: "Hello", start: 1.719, end: 2.1, type: "word", speaker_id: "speaker_0", logprob: -0.02 },
        { text: " ", start: 2.1, end: 2.2, type: "spacing", speaker_id: "speaker_0", logprob: 0 },
        { text: "there.", start: 2.2, end: 2.399, type: "word", speaker_id: "speaker_0", logprob: -0.1 },
      ],
    });
    expect(extractProviderTimedWords("elevenlabs-scribe", raw)).toEqual([
      { word: "Hello", start: 1.719, end: 2.1 },
      { word: "there.", start: 2.2, end: 2.399 },
    ]);
  });

  it("returns null, not [], for OpenAI gpt-4o-transcribe (text only, verified against the real API)", () => {
    expect(extractProviderTimedWords("openai-gpt-4o-transcribe", JSON.stringify({ text: "hello", usage: { type: "tokens" } }))).toBeNull();
  });

  it("returns null for an unparseable or empty body", () => {
    expect(extractProviderTimedWords("elevenlabs-scribe", "not json")).toBeNull();
    expect(extractProviderTimedWords("elevenlabs-scribe", JSON.stringify({ words: [] }))).toBeNull();
    expect(extractProviderTimedWords("elevenlabs-scribe", null)).toBeNull();
  });
});
