import {
  ProviderConfigError,
  type ProviderAdapter,
  type ProviderTranscribeInput,
  type ProviderTranscribeResult,
} from "../types";
import { scaledPollTimeoutMs } from "../poll";
import type { FailureClass } from "../failure-class";
// Both helpers are vendor-neutral despite living in cartesia.ts: parseWavPcm
// reads a RIFF header, and endOfAudioLatencyMs is the ONE definition of the
// M-10b measurement. Re-deriving either here is how two adapters end up
// reporting the same column with two different meanings, which is exactly
// the failure M-10a had to unpick. Imported, not copied. (That they still
// live in a vendor's file is logged in docs/backlog/good-to-have.md.)
import { endOfAudioLatencyMs, parseWavPcm, type WavPcmInfo } from "./cartesia";
// M-19a: the boost parameter is a property of the Deepgram MODEL, not of
// the endpoint, and this adapter runs the same nova-3 the batch adapter
// does. Imported from there for the same reason the two helpers above are
// imported rather than copied: a second definition is how the two nova-3
// rows start differing in something other than how the audio arrives.
import { deepgramBoostParam } from "./deepgram";

// Deepgram nova-3 over the streaming WebSocket, as opposed to deepgram.ts
// which POSTs the whole file to the same /v1/listen path. Two adapters for
// one vendor because they are two different products: the batch row answers
// "how good is the transcript", this one answers "how long would a voice
// agent have waited", which is the number M-10b/M-10e/M-10f built a column
// for and which only a socket can produce.
//
// Docs, read 2026-09-07:
//   https://developers.deepgram.com/reference/speech-to-text/listen-streaming
//   https://developers.deepgram.com/docs/using-the-sec-websocket-protocol
//
// UNVERIFIED (flagged per the provider-matrix.md convention -- confirm
// against a real key in M-11d before trusting): the exact error frame. The
// reference documents four server messages (Results, Metadata, UtteranceEnd,
// SpeechStarted) and describes failures as close codes, but Deepgram is also
// observed to send a JSON frame carrying a description. Both are handled
// below; only the close code has been read off a document.
const PROVIDER_ID = "deepgram-nova-3-streaming";
const API_KEY_ENV_VAR = "DEEPGRAM_API_KEY";
const DEFAULT_API_MODEL = "nova-3";
// One chunk carries this much audio and is sent this often, so the stream
// runs at exactly real time. cartesia.ts hardcodes 6400 bytes every 190 ms,
// which is real time only for 16 kHz 16-bit mono and ~5% faster than real
// time even then; M-11's "must not send faster than real time" is easier to
// honour by deriving the size from the file than by asserting about a
// constant. Deepgram's own guidance is 20-250 ms per chunk.
const CHUNK_MS = 200;
const CONNECT_TIMEOUT_MS = 15_000;
// Quiet period after Finalize before asking the server to close, and again
// before forcing it. Same value and same purpose as cartesia.ts.
const IDLE_CLOSE_MS = 2_000;

// ---- Pure helpers (network-free, unit tested in parsers.test.ts) ----

/** Bytes of PCM that carry `chunkMs` of this file's audio. Derived from the
 * WAV header rather than assumed, so a 8 kHz or 44.1 kHz recording streams
 * at real time too instead of at 2x or 0.36x. */
export function deepgramStreamChunkBytes(wav: WavPcmInfo, chunkMs: number = CHUNK_MS): number {
  const bytesPerFrame = (wav.bitsPerSample / 8) * wav.numChannels;
  const framesPerChunk = Math.round((wav.sampleRate * chunkMs) / 1000);
  const bytes = framesPerChunk * bytesPerFrame;
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(
      `Cannot derive a chunk size from this WAV header (sampleRate ${wav.sampleRate}, ` +
        `bitsPerSample ${wav.bitsPerSample}, channels ${wav.numChannels}).`,
    );
  }
  return bytes;
}

/** The `encoding` value for raw PCM at this bit depth. Only 16-bit is
 * accepted: linear16 is the raw-PCM encoding Deepgram's v1 streaming
 * reference documents, and guessing at another one would send audio the
 * server decodes as noise and score the resulting nonsense as recognition
 * error. */
export function deepgramEncodingForBitDepth(bitsPerSample: number): "linear16" {
  if (bitsPerSample === 16) return "linear16";
  throw new Error(
    `Deepgram streaming adapter supports 16-bit PCM only, got ${bitsPerSample}-bit.`,
  );
}

export type DeepgramStreamWord = {
  word?: string;
  start?: number;
  end?: number;
  confidence?: number;
  speaker?: number;
};

export type DeepgramStreamMessage =
  | {
      type: "Results";
      is_final?: boolean;
      speech_final?: boolean;
      channel?: { alternatives?: Array<{ transcript?: string; words?: DeepgramStreamWord[] }> };
    }
  | { type: string; [key: string]: unknown };

export type DeepgramStreamEvent = { message: DeepgramStreamMessage; receivedAtMs: number };

function alternativeOf(message: DeepgramStreamMessage): { transcript?: string; words?: DeepgramStreamWord[] } | null {
  const m = message as Extract<DeepgramStreamMessage, { type: "Results" }>;
  return m.channel?.alternatives?.[0] ?? null;
}

/** Reduces the raw sequence of WebSocket messages into a final transcript
 * plus the two timing anchors, in isolation from the socket so it is unit
 * testable without a live connection. Mirrors reduceCartesiaTranscript, on
 * Deepgram's shape: a segment is finished when `is_final` is true, and the
 * interim messages before it repeat the same span with moving boundaries,
 * so only the finals are concatenated. */
export function reduceDeepgramStreamTranscript(
  events: DeepgramStreamEvent[],
  startedAtMs: number,
): {
  transcript: string | null;
  firstPartialMs: number | null;
  lastFinalMs: number | null;
  errorMessage: string | null;
} {
  const finals: string[] = [];
  let firstPartialMs: number | null = null;
  // M-10b: when the last segment that actually contributed text arrived --
  // deliberately the same condition as the finals.push below, so this is the
  // instant the transcript stopped growing, not the instant the socket shut,
  // which is IDLE_CLOSE_MS later and measures our own timer.
  let lastFinalMs: number | null = null;
  let errorMessage: string | null = null;

  for (const { message, receivedAtMs } of events) {
    if (message.type === "Error" || message.type === "Fatal") {
      const m = message as { description?: string; message?: string; reason?: string };
      errorMessage = m.description ?? m.message ?? m.reason ?? "Deepgram streaming error.";
      continue;
    }
    if (message.type !== "Results") continue;
    const alt = alternativeOf(message);
    const text = alt?.transcript ?? "";
    if (firstPartialMs === null && text.length > 0) {
      firstPartialMs = receivedAtMs - startedAtMs;
    }
    const isFinal = (message as { is_final?: boolean }).is_final === true;
    if (isFinal && text.length > 0) {
      finals.push(text);
      lastFinalMs = receivedAtMs - startedAtMs;
    }
  }

  if (errorMessage) return { transcript: null, firstPartialMs, lastFinalMs, errorMessage };
  return {
    transcript: finals.join(" ").trim() || null,
    firstPartialMs,
    lastFinalMs,
    errorMessage: null,
  };
}

/** The same coarse proxy parseDeepgramResponse applies to the batch shape:
 * 1.0 if the finished segments carried at least one distinct speaker label,
 * 0 if they carried words but no labels, null if there is nothing to score.
 * Identical rule on purpose -- the batch nova-3 row and this one exist to be
 * compared, and a different diarization rule would make that comparison a
 * comparison of two rules. */
export function deepgramStreamDiarizationScore(events: DeepgramStreamEvent[]): number | null {
  const speakers = new Set<number>();
  let wordCount = 0;
  for (const { message } of events) {
    if (message.type !== "Results") continue;
    if ((message as { is_final?: boolean }).is_final !== true) continue;
    for (const w of alternativeOf(message)?.words ?? []) {
      wordCount += 1;
      if (typeof w.speaker === "number") speakers.add(w.speaker);
    }
  }
  if (wordCount === 0) return null;
  return speakers.size > 0 ? 1 : 0;
}

// ---- Live adapter ----

/** M-11e. The socket's URL and its subprotocols, kept pure so that "the
 * credential never appears in the URL" is testable without opening a socket.
 * Deepgram documents two ways to authenticate a Listen socket: the
 * `Authorization` header, which the global Node `WebSocket` cannot set, and
 * the subprotocol pair `Sec-WebSocket-Protocol: token, <API_KEY>` for exactly
 * that case. The query string carries no credential -- v1 /listen's
 * documented parameter list contains no `token`, which is what M-11a got
 * wrong when it put the key there.
 *
 * It builds the query parameters as well as the URL, rather than taking them,
 * so there is exactly one place a credential could be added to the URL and a
 * test can watch it. Taking a caller-built URLSearchParams left the adapter's
 * own parameter block uncovered: putting `token` back there was a mutation the
 * suite did not catch. */
export function deepgramStreamSocketArgs(
  apiKey: string,
  opts: {
    model: string;
    encoding: string;
    sampleRate: number;
    channels: number;
    diarize: boolean;
    keywordBoosts?: string[];
  },
): { url: string; protocols: [string, string] } {
  const params = new URLSearchParams({
    model: opts.model,
    encoding: opts.encoding,
    sample_rate: String(opts.sampleRate),
    channels: String(opts.channels),
    // Matched to deepgram.ts's batch parameters on purpose. The two nova-3
    // rows exist to be compared, and smart_format changes the text while
    // diarize changes what the words carry -- differing here would turn a
    // provider comparison into a settings comparison.
    smart_format: "true",
    diarize: String(opts.diarize),
    // Required for a first-partial time to exist at all: without it the
    // server sends only finished segments, and RUN-02's time-to-first-
    // partial would be the time to the first FINAL, silently.
    interim_results: "true",
  });
  const boostParam = deepgramBoostParam(opts.model);
  for (const term of opts.keywordBoosts ?? []) params.append(boostParam, term);
  return {
    url: `wss://api.deepgram.com/v1/listen?${params.toString()}`,
    protocols: ["token", apiKey],
  };
}

export const deepgramStreamingAdapter: ProviderAdapter = {
  providerId: PROVIDER_ID,
  // Same vendor as the batch adapter, deliberately: it is the same account
  // and the same rate limit, so this row belongs in the same concurrency
  // bucket, and the confidence / timed-word extractors that switch on
  // vendorOfProviderId must treat it as Deepgram.
  vendor: "deepgram",
  vendorLabel: "Deepgram",
  // NO listModels, deliberately. /benchmark/providers/models filters to the
  // adapters that have one and groups them by vendor, so a second adapter
  // declaring both would render two Deepgram cards on Setup. The ids this
  // adapter serves come from providerCatalog instead, the way
  // elevenlabs-scribe-v2 already does.
  apiKeyEnvVar: API_KEY_ENV_VAR,
  async transcribe(input: ProviderTranscribeInput): Promise<ProviderTranscribeResult> {
    const apiKey = process.env[API_KEY_ENV_VAR];
    if (!apiKey) throw new ProviderConfigError(PROVIDER_ID, API_KEY_ENV_VAR);

    const submittedAt = new Date().toISOString();
    const submittedAtMs = Date.now();

    let wav: WavPcmInfo;
    let encoding: "linear16";
    let chunkBytes: number;
    try {
      wav = parseWavPcm(input.audioBytes);
      encoding = deepgramEncodingForBitDepth(wav.bitsPerSample);
      chunkBytes = deepgramStreamChunkBytes(wav);
    } catch (err) {
      // The bytes are in hand and they are not streamable PCM. Nothing about
      // the network or the vendor is involved, so this is the one failure
      // this adapter can name with certainty before connecting.
      return {
        status: "failed",
        submittedAt,
        finalAt: new Date().toISOString(),
        firstPartialAt: null,
        httpStatus: null,
        hypothesisTranscript: null,
        rawOutput: null,
        errorMessage: err instanceof Error ? err.message : String(err),
        diarizationScore: null,
        failureClass: "audio_decode",
      };
    }

    const pcm = input.audioBytes.subarray(wav.dataOffset, wav.dataOffset + wav.dataLength);
    const responseTimeoutMs = scaledPollTimeoutMs(input.audioDurationSeconds);

    // Every connect-time argument, credential included, is built in one
    // place so that no later edit here can put the key back on the URL.
    const { url, protocols } = deepgramStreamSocketArgs(apiKey, {
      model: input.model ?? DEFAULT_API_MODEL,
      encoding,
      sampleRate: wav.sampleRate,
      channels: wav.numChannels,
      diarize: input.diarize ?? true,
      keywordBoosts: input.keywordBoosts,
    });

    const events: DeepgramStreamEvent[] = [];
    // M-10b: when the last audio chunk left this process. Declared out here,
    // not inside the promise, because the result below has to read it.
    let lastAudioSentAtMs: number | null = null;
    let connectError: string | null = null;
    let connectFailureClass: FailureClass | null = null;
    let wsCloseCode: number | null = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      let sendTimer: ReturnType<typeof setInterval> | null = null;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      // Gate on Finalize having actually been sent, so a quiet stretch
      // mid-transmission -- a pause between speaker turns -- is not read as
      // "the server is done". This is the bug that truncated live Cartesia
      // transcripts to the first pause on 2026-08-24; inherited as a rule
      // rather than rediscovered.
      let finalizeSent = false;
      let closeStreamSent = false;
      // Lets the close handler tell a server-side drop mid-stream from a
      // normal end-of-call close, so a truncated transcript fails loudly
      // instead of being scored as bad recognition.
      let bytesSent = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (sendTimer) clearInterval(sendTimer);
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(connectTimer);
        clearTimeout(responseTimer);
        resolve();
      };

      // A thrown error's message is written verbatim into
      // benchmark_provider_call_results.error_message and rendered on screen
      // (run-executor.ts, the `if (!result)` branch). Since M-11e the URL no
      // longer carries the key -- it rides in the subprotocol -- but the
      // reasoning holds whatever the arguments contain, and this constructor
      // can throw on the subprotocol argument too: nothing it might say is
      // ever repeated, the message is a constant. Resolves directly rather
      // than through finish(), which reads timers that do not exist yet at
      // this point.
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, protocols);
      } catch {
        settled = true;
        connectError = "Deepgram streaming WebSocket could not be opened.";
        connectFailureClass = "unknown";
        resolve();
        return;
      }

      const connectTimer = setTimeout(() => {
        connectError = connectError ?? "Deepgram streaming WebSocket connect timed out.";
        connectFailureClass = connectFailureClass ?? "provider_timeout";
        try {
          ws.close();
        } catch {
          // socket already dead -- fall through to finish() below
        }
        finish();
      }, CONNECT_TIMEOUT_MS);

      const responseTimer = setTimeout(() => {
        connectError =
          connectError ??
          `Deepgram streaming WebSocket timed out waiting for a final transcript (${Math.round(responseTimeoutMs / 1000)}s budget for a ${input.audioDurationSeconds ?? "unknown-length"}s call).`;
        connectFailureClass = connectFailureClass ?? "provider_timeout";
        try {
          ws.close();
        } catch {
          // socket already dead
        }
        finish();
      }, responseTimeoutMs);

      // Two-stage, unlike cartesia.ts's single stage: Deepgram answers
      // CloseStream by flushing whatever is left and THEN closing, so
      // hanging up in the same tick would throw away the last segment. Ask
      // once, wait another quiet period, only then force it.
      const armIdleClose = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (!closeStreamSent) {
            closeStreamSent = true;
            try {
              ws.send(JSON.stringify({ type: "CloseStream" }));
            } catch {
              // already closed
            }
            armIdleClose();
            return;
          }
          try {
            ws.close();
          } catch {
            // already closed
          }
        }, IDLE_CLOSE_MS);
      };

      ws.addEventListener("open", () => {
        clearTimeout(connectTimer);
        let offset = 0;
        sendTimer = setInterval(() => {
          if (offset >= pcm.length) {
            if (sendTimer) clearInterval(sendTimer);
            try {
              ws.send(JSON.stringify({ type: "Finalize" }));
              finalizeSent = true;
            } catch (err) {
              connectError = err instanceof Error ? err.message : String(err);
              connectFailureClass = "unknown";
              try {
                ws.close();
              } catch {
                // already closed
              }
              return;
            }
            armIdleClose(); // in case the server never replies further
            return;
          }
          const chunk = pcm.subarray(offset, offset + chunkBytes);
          offset += chunkBytes;
          try {
            ws.send(chunk);
            bytesSent += chunk.length;
            // Stamped after send() so a throw leaves it on the previous
            // chunk rather than claiming audio that never went out.
            lastAudioSentAtMs = Date.now();
          } catch (err) {
            connectError = err instanceof Error ? err.message : String(err);
            connectFailureClass = "unknown";
            if (sendTimer) clearInterval(sendTimer);
            try {
              ws.close();
            } catch {
              // already closed
            }
          }
        }, CHUNK_MS);
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        const receivedAtMs = Date.now();
        let parsed: DeepgramStreamMessage | null = null;
        try {
          const raw = typeof event.data === "string" ? event.data : event.data.toString();
          parsed = JSON.parse(raw) as DeepgramStreamMessage;
        } catch {
          return; // not JSON we understand -- ignore rather than crash the run
        }
        events.push({ message: parsed, receivedAtMs });
        if (parsed.type === "Error" || parsed.type === "Fatal") {
          try {
            ws.close();
          } catch {
            // already closed
          }
          return;
        }
        if (finalizeSent) armIdleClose();
      });

      ws.addEventListener("error", () => {
        connectError = connectError ?? "Deepgram streaming WebSocket connection error.";
        connectFailureClass = connectFailureClass ?? "unknown";
      });

      ws.addEventListener("close", (event: CloseEvent) => {
        wsCloseCode = event.code ?? null;
        if (!finalizeSent) {
          connectError =
            connectError ??
            `Deepgram streaming WebSocket closed before all audio was streamed ` +
              `(sent ${bytesSent}/${pcm.length} bytes, close code ${wsCloseCode}). ` +
              `Likely a transient server-side drop -- safe to retry.`;
          connectFailureClass = connectFailureClass ?? "provider_5xx";
        }
        finish();
      });
    });

    const finalAt = new Date().toISOString();
    const reduced = reduceDeepgramStreamTranscript(events, submittedAtMs);
    const rawOutput = { events: events.map((e) => e.message), wsCloseCode };
    const errorMessage =
      connectError ??
      reduced.errorMessage ??
      (reduced.transcript ? null : "Deepgram streaming returned no final transcript segment.");
    // A server error frame, and a clean close that simply produced no final
    // text, are both left unknown on purpose: nothing observed here names a
    // cause, and an unclassified failure has to stay visible as one rather
    // than be filed under the nearest-looking bucket.
    const failureClass: FailureClass | null = errorMessage
      ? (connectFailureClass ?? "unknown")
      : null;

    return {
      status: errorMessage ? "failed" : "ok",
      submittedAt,
      finalAt,
      firstPartialAt:
        reduced.firstPartialMs !== null
          ? new Date(submittedAtMs + reduced.firstPartialMs).toISOString()
          : null,
      latencyEndOfAudioMs: endOfAudioLatencyMs(
        reduced.lastFinalMs,
        lastAudioSentAtMs === null ? null : lastAudioSentAtMs - submittedAtMs,
      ),
      httpStatus: null, // WebSocket, not HTTP -- see wsCloseCode inside rawOutput instead
      hypothesisTranscript: reduced.transcript,
      rawOutput,
      errorMessage,
      failureClass,
      diarizationScore: deepgramStreamDiarizationScore(events),
    };
  },
};
