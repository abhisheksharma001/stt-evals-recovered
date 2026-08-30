// T-08: pulls {word, start, end} (seconds) out of a provider's stored raw
// response. The provider-specific twin of extractProviderConfidenceWords in
// hybrid-flagging.ts, and held to the same rule: every shape here was read
// off a real captured response (docs/provider-data-samples.md), not a doc
// page. Returns null when the provider does not return word timings at all,
// never an empty array for that case -- callers need "not available" to be
// distinguishable from "available and empty".
import type { TimedWord } from "@workspace/scoring";
import { vendorOfProviderId } from "@workspace/stt-providers";

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

  // T-110: vendor-keyed (see hybrid-flagging.ts) so T-104 model rows get
  // timings too.
  const vendor = vendorOfProviderId(providerId);
  try {
    if (vendor === "assemblyai") {
      // Milliseconds in the real response ("start": 1261) -- converted here.
      const words = (body as { words?: Array<{ text?: string; start?: number; end?: number }> }).words;
      if (!Array.isArray(words)) return null;
      const out = words
        .filter((w) => typeof w.text === "string" && isNum(w.start) && isNum(w.end))
        .map((w) => ({ word: w.text!, start: w.start! / 1000, end: w.end! / 1000 }));
      return out.length ? out : null;
    }
    if (vendor === "deepgram") {
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
    if (vendor === "gladia") {
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
    if (vendor === "cartesia") {
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
    if (vendor === "elevenlabs") {
      // T-48, verified against the real API 2026-08-29: Scribe returns
      // words as {text, start, end, type, speaker_id, logprob} with
      // seconds, and interleaves type "spacing" entries -- only type "word"
      // is a word. The adapter's own response type never declared start/end,
      // which is why this read as "no timings" before.
      const words = (body as { words?: Array<{ text?: string; start?: number; end?: number; type?: string }> }).words;
      if (!Array.isArray(words)) return null;
      const out = words
        .filter((w) => w.type === "word" && typeof w.text === "string" && isNum(w.start) && isNum(w.end))
        .map((w) => ({ word: w.text!.trim(), start: w.start!, end: w.end! }));
      return out.length ? out : null;
    }
  } catch {
    return null;
  }
  // openai-gpt-4o-transcribe: text only, and not requestable otherwise --
  // verified 2026-08-29 against the real API: response_format=verbose_json
  // is rejected ("response_format 'verbose_json' is not compatible with
  // model 'gpt-4o-transcribe'. Use 'json' or 'text' instead.") and
  // timestamp_granularities[]=word with json returns {text, usage} only.
  // speechmatics: no captured response yet to read a shape from.
  return null;
}
