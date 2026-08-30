// T-110: pulls {word, confidence} pairs out of a provider's stored raw
// response. Pure -- no DB import -- the twin of timed-words.ts. Every
// shape here was read off a real captured response
// (docs/provider-data-samples.md). Keyed on the VENDOR so a T-104 model
// row ("gladia-solaria-3") is read the same as the vendor's historical id.
import { vendorOfProviderId } from "@workspace/stt-providers";

type ConfidenceWord = { word: string; confidence: number };

/** Provider-specific: pulls {word, confidence} pairs out of a provider's raw
 * response JSON. Returns null when the provider doesn't expose confidence at
 * all (Cartesia, OpenAI, ElevenLabs, Speechmatics -- confirmed absent from
 * real captured responses, docs/provider-data-samples.md), never an empty
 * array for that case -- callers need to tell "not available" apart from
 * "available and clean." */
export function extractProviderConfidenceWords(
  providerId: string,
  rawOutputJson: string | null,
): ConfidenceWord[] | null {
  if (!rawOutputJson) return null;
  let body: unknown;
  try {
    body = JSON.parse(rawOutputJson);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;

  // T-110: keyed on the vendor, not the exact id -- "gladia-solaria-3" and
  // "assemblyai-universal-3-5-pro" (T-104 rows) return the same shapes as
  // the historical ids and used to fall through to null here.
  const vendor = vendorOfProviderId(providerId);
  try {
    if (vendor === "assemblyai") {
      const words = (body as { words?: Array<{ text?: string; confidence?: number }> }).words;
      if (!Array.isArray(words)) return null;
      return words
        .filter((w) => typeof w.text === "string" && typeof w.confidence === "number")
        .map((w) => ({ word: w.text!, confidence: w.confidence! }));
    }
    if (vendor === "deepgram") {
      const words = (
        body as {
          results?: { channels?: Array<{ alternatives?: Array<{ words?: Array<{ word?: string; confidence?: number }> }> }> };
        }
      ).results?.channels?.[0]?.alternatives?.[0]?.words;
      if (!Array.isArray(words)) return null;
      return words
        .filter((w) => typeof w.word === "string" && typeof w.confidence === "number")
        .map((w) => ({ word: w.word!, confidence: w.confidence! }));
    }
    if (vendor === "gladia") {
      const utterances = (
        body as { result?: { transcription?: { utterances?: Array<{ words?: Array<{ word?: string; confidence?: number }> }> } } }
      ).result?.transcription?.utterances;
      if (!Array.isArray(utterances)) return null;
      const words: ConfidenceWord[] = [];
      for (const u of utterances) {
        for (const w of u.words ?? []) {
          if (typeof w.word === "string" && typeof w.confidence === "number") {
            words.push({ word: w.word, confidence: w.confidence });
          }
        }
      }
      return words.length ? words : null;
    }
  } catch {
    return null;
  }
  // cartesia, openai, elevenlabs, speechmatics: no per-word confidence in
  // their real responses.
  return null;
}
