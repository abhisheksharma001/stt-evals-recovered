// T-08: pulls {word, start, end} (seconds) out of a provider's stored raw
// response. The provider-specific twin of extractProviderConfidenceWords in
// hybrid-flagging.ts, and held to the same rule: every shape here was read
// off a real captured response (docs/provider-data-samples.md), not a doc
// page. Returns null when the provider does not return word timings at all,
// never an empty array for that case -- callers need "not available" to be
// distinguishable from "available and empty".
import type { TimedWord } from "@workspace/scoring";

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function extractProviderTimedWords(providerId: string, rawOutputJson: string | null): TimedWord[] | null {
  if (!rawOutputJson) return null;
  let body: unknown;
  try {
    body = JSON.parse(rawOutputJson);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;

  try {
    if (providerId === "assemblyai-universal") {
      // Milliseconds in the real response ("start": 1261) -- converted here.
      const words = (body as { words?: Array<{ text?: string; start?: number; end?: number }> }).words;
      if (!Array.isArray(words)) return null;
      const out = words
        .filter((w) => typeof w.text === "string" && isNum(w.start) && isNum(w.end))
        .map((w) => ({ word: w.text!, start: w.start! / 1000, end: w.end! / 1000 }));
      return out.length ? out : null;
    }
    if (providerId === "deepgram-nova-3") {
      // Seconds ("start": 2.88).
      const words = (
        body as {
          results?: { channels?: Array<{ alternatives?: Array<{ words?: Array<{ word?: string; start?: number; end?: number }> }> }> };
        }
      ).results?.channels?.[0]?.alternatives?.[0]?.words;
      if (!Array.isArray(words)) return null;
      const out = words
        .filter((w) => typeof w.word === "string" && isNum(w.start) && isNum(w.end))
        .map((w) => ({ word: w.word!, start: w.start!, end: w.end! }));
      return out.length ? out : null;
    }
    if (providerId === "gladia-solaria") {
      // Seconds, nested per utterance.
      const utterances = (
        body as { result?: { transcription?: { utterances?: Array<{ words?: Array<{ word?: string; start?: number; end?: number }> }> } } }
      ).result?.transcription?.utterances;
      if (!Array.isArray(utterances)) return null;
      const out: TimedWord[] = [];
      for (const u of utterances) {
        for (const w of u.words ?? []) {
          if (typeof w.word === "string" && isNum(w.start) && isNum(w.end)) out.push({ word: w.word, start: w.start, end: w.end });
        }
      }
      return out.length ? out : null;
    }
    if (providerId === "cartesia-ink-whisper") {
      // Streaming: the adapter stores every WebSocket message under
      // `events`; each final transcript message carries its own words with
      // seconds ("start": 1.97). Only is_final messages count -- partials
      // repeat the same words with moving boundaries.
      const events = (body as { events?: unknown[] }).events;
      if (!Array.isArray(events)) return null;
      const out: TimedWord[] = [];
      for (const e of events) {
        const msg = e as { type?: string; is_final?: boolean; words?: Array<{ word?: string; start?: number; end?: number }> };
        if (msg?.type !== "transcript" || !msg.is_final || !Array.isArray(msg.words)) continue;
        for (const w of msg.words) {
          if (typeof w.word === "string" && isNum(w.start) && isNum(w.end)) out.push({ word: w.word.trim(), start: w.start, end: w.end });
        }
      }
      return out.length ? out : null;
    }
  } catch {
    return null;
  }
  // openai-gpt-4o-transcribe (json response_format, text only),
  // elevenlabs-scribe (words carry speaker_id only in the captured
  // response), speechmatics: no word timings we have verified.
  return null;
}
