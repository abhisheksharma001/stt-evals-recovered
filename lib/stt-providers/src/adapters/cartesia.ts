import {
  ProviderConfigError,
  type ProviderAdapter,
  type ProviderTranscribeInput,
  type ProviderTranscribeResult,
} from "../types";
import { scaledPollTimeoutMs } from "../poll";
import type { FailureClass } from "../failure-class";

// Cartesia Ink-Whisper: WebSocket streaming STT, not a batch/URL REST call
// like the other six adapters in this package (confirmed against Cartesia's
// docs -- there is no batch endpoint for STT, only
// `wss://api.cartesia.ai/stt/websocket`). That makes this the one adapter
// where RUN-02 time-to-first-partial can be measured for real: we send raw
// PCM audio in near-real-time chunks and time the first non-empty
// `transcript` message we get back.
//
// Docs: https://docs.cartesia.ai/api-reference/stt/stt
//
// UNVERIFIED (flag per provider-matrix.md convention -- confirm with a real
// key before trusting): the exact close/finalize handshake. The docs show
// the client can send text commands "finalize" (flush remaining audio, get
// a final transcript) or "close", but not the precise sequence/timing the
// server expects. This implementation sends "finalize" once all audio is
// sent, then waits for the connection to go quiet (IDLE_CLOSE_MS) before
// sending "close" itself -- reasonable given the docs, not confirmed live.

const PROVIDER_ID = "cartesia-ink-whisper";
const API_KEY_ENV_VAR = "CARTESIA_API_KEY";
const CARTESIA_VERSION = "2026-08-14";
const CHUNK_BYTES = 6400; // ~200ms of 16kHz 16-bit mono PCM
const SEND_INTERVAL_MS = 190; // stream slightly ahead of real-time, not a single dump
const CONNECT_TIMEOUT_MS = 15_000;
// T-8-style fix (2026-08-27, found live: 15 cells failed on one bulk, every
// one of them "WebSocket timed out waiting for a final transcript" -- and
// every failure was a long call, 93s-445s). This used to be a fixed 120s
// RESPONSE_TIMEOUT_MS covering the ENTIRE socket lifetime (connect + stream
// + finalize + idle-close), set once at connection start and never reset.
// Audio is streamed at ~real-time pace (SEND_INTERVAL_MS below), so just
// streaming a 3-minute call already takes ~3 minutes -- a fixed 120s cap
// guaranteed a timeout on any call over roughly 100s, regardless of
// Cartesia's own health. Scaled the same way the async-poll adapters
// already were (poll.ts's scaledPollTimeoutMs, same 3x-realtime/60s-floor/
// 15min-cap policy) instead of inventing a second timeout policy.
const IDLE_CLOSE_MS = 2_000; // quiet period after "finalize" before we force-close

// ---- Pure helpers (network-free, unit tested in parsers.test.ts) ----

export type WavPcmInfo = {
  sampleRate: number;
  bitsPerSample: number;
  numChannels: number;
  audioFormat: number; // 1 = PCM integer, 3 = IEEE float
  dataOffset: number;
  dataLength: number;
};

/** Parses a RIFF/WAVE header to locate the PCM `data` chunk. Cartesia's
 * streaming endpoint wants raw PCM samples, not a WAV container, so the
 * caller slices `bytes[dataOffset, dataOffset + dataLength)` and streams
 * that. Throws (not a silent fallback) on anything this adapter can't
 * safely handle -- non-WAV input, compressed formats, or multichannel
 * audio -- since Vapi recordings in this corpus are consistently mono WAV
 * (see the "-mono.wav" filename convention) and silently downmixing or
 * guessing at an unsupported format would corrupt the audio sent upstream.
 */
export function parseWavPcm(bytes: Buffer): WavPcmInfo {
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error(
      "Not a RIFF/WAVE file -- the Cartesia adapter only supports raw PCM WAV input.",
    );
  }

  let offset = 12;
  let fmt: {
    audioFormat: number;
    numChannels: number;
    sampleRate: number;
    bitsPerSample: number;
  } | null = null;
  let data: { offset: number; length: number } | null = null;

  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (chunkId === "fmt ") {
      fmt = {
        audioFormat: bytes.readUInt16LE(body),
        numChannels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bitsPerSample: bytes.readUInt16LE(body + 14),
      };
    } else if (chunkId === "data") {
      data = { offset: body, length: chunkSize };
    }

    offset = body + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }

  if (!fmt) throw new Error("WAV file has no fmt chunk.");
  if (!data) throw new Error("WAV file has no data chunk.");
  if (fmt.audioFormat !== 1) {
    throw new Error(
      `Unsupported WAV audio format ${fmt.audioFormat} -- only PCM integer (1) is supported by the Cartesia adapter.`,
    );
  }
  if (fmt.numChannels !== 1) {
    throw new Error(
      `Cartesia adapter only supports mono WAV input, got ${fmt.numChannels} channel(s).`,
    );
  }

  return {
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    numChannels: fmt.numChannels,
    audioFormat: fmt.audioFormat,
    dataOffset: data.offset,
    dataLength: Math.min(data.length, bytes.length - data.offset),
  };
}

export function cartesiaEncodingForBitDepth(
  bitsPerSample: number,
): "pcm_s16le" | "pcm_s32le" {
  if (bitsPerSample === 16) return "pcm_s16le";
  if (bitsPerSample === 32) return "pcm_s32le";
  throw new Error(
    `Unsupported PCM bit depth ${bitsPerSample} -- Cartesia adapter supports 16-bit or 32-bit integer PCM.`,
  );
}

export type CartesiaMessage =
  | {
      type: "transcript";
      is_final?: boolean;
      text?: string;
      duration?: number;
      words?: Array<{ word: string; start: number; end: number }>;
    }
  | { type: "error"; status_code?: number; title?: string; message?: string; error_code?: string }
  | { type: string; [key: string]: unknown };

export type CartesiaReceivedEvent = { message: CartesiaMessage; receivedAtMs: number };

/** Reduces the raw sequence of WebSocket messages into a final transcript
 * plus time-to-first-partial, in isolation from the socket itself so this
 * logic is unit testable without a live connection. */
export function reduceCartesiaTranscript(
  events: CartesiaReceivedEvent[],
  startedAtMs: number,
): { transcript: string | null; firstPartialMs: number | null; errorMessage: string | null } {
  const finals: string[] = [];
  let firstPartialMs: number | null = null;
  let errorMessage: string | null = null;

  for (const { message, receivedAtMs } of events) {
    if (message.type === "error") {
      const m = message as Extract<CartesiaMessage, { type: "error" }>;
      errorMessage = m.message ?? m.title ?? `Cartesia error (${m.error_code ?? "unknown"})`;
      continue;
    }
    if (message.type !== "transcript") continue;
    const t = message as Extract<CartesiaMessage, { type: "transcript" }>;
    if (firstPartialMs === null && (t.text?.length ?? 0) > 0) {
      firstPartialMs = receivedAtMs - startedAtMs;
    }
    if (t.is_final && t.text) finals.push(t.text);
  }

  if (errorMessage) return { transcript: null, firstPartialMs, errorMessage };
  return { transcript: finals.join(" ").trim() || null, firstPartialMs, errorMessage: null };
}

// ---- Live adapter ----

export const cartesiaAdapter: ProviderAdapter = {
  providerId: PROVIDER_ID,
  vendor: "cartesia",
  vendorLabel: "Cartesia",
  // T-104, verified on docs.cartesia.ai/api-reference/stt/transcribe
  // 2026-08-30: the only accepted model is ink-whisper.
  listModels: async () => [{ apiModel: "ink-whisper", label: "Ink-Whisper", latest: true, source: "catalog", verifiedAt: "2026-08-30", legacyDefault: true }],
  apiKeyEnvVar: API_KEY_ENV_VAR,
  async transcribe(input: ProviderTranscribeInput): Promise<ProviderTranscribeResult> {
    const apiKey = process.env[API_KEY_ENV_VAR];
    if (!apiKey) throw new ProviderConfigError(PROVIDER_ID, API_KEY_ENV_VAR);

    const submittedAt = new Date().toISOString();
    const submittedAtMs = Date.now();

    let wav: WavPcmInfo;
    let encoding: "pcm_s16le" | "pcm_s32le";
    try {
      wav = parseWavPcm(input.audioBytes);
      encoding = cartesiaEncodingForBitDepth(wav.bitsPerSample);
    } catch (err) {
      // The bytes are in hand and they are not decodable WAV PCM. Nothing
      // about the network or the vendor is involved, so this is the one
      // failure this adapter can name with certainty before connecting.
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

    // access_token (query param), not X-API-Key (header): the global Node
    // WebSocket client can't set custom request headers, and Cartesia's
    // docs offer this as the documented alternative for exactly that case.
    const params = new URLSearchParams({
      model: input.model ?? "ink-whisper",
      encoding,
      sample_rate: String(wav.sampleRate),
      cartesia_version: CARTESIA_VERSION,
      access_token: apiKey,
    });
    const url = `wss://api.cartesia.ai/stt/websocket?${params.toString()}`;

    const events: CartesiaReceivedEvent[] = [];
    let connectError: string | null = null;
    // T-06: set at the same instant as connectError, by whichever handler
    // actually observed the failure. Nothing downstream re-reads the
    // sentence to work out what happened.
    let connectFailureClass: FailureClass | null = null;
    let wsCloseCode: number | null = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      let sendTimer: ReturnType<typeof setInterval> | null = null;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      // BUG (found live 2026-08-24 against a real 105s call): armIdleClose
      // used to run on every incoming message unconditionally, including
      // while sendTimer was still mid-transmission. Cartesia can legitimately
      // go quiet for >IDLE_CLOSE_MS between utterances (a pause between
      // speaker turns) without the call being over -- that silently closed
      // the socket and truncated the transcript to whatever was said before
      // the first pause, well before the real end of the recording. Gate
      // arming the close timer on finalize having actually been sent.
      let finalizeSent = false;
      // Tracked outside the send-loop closure so the close handler can tell
      // a premature disconnect (server hung up mid-stream) from a normal
      // end-of-call close. BUG (found live 2026-08-24, second pass): a
      // premature close used to fall through to the same "ok" path as a
      // clean finish, just with whatever partial transcript had arrived --
      // silently scoring a severely truncated transcript as if it were
      // real recognition error, which is exactly what unfairly tanked
      // Cartesia's WER in the first place. Observed live: several 90-105s
      // calls closed cleanly (code 1000) after only ~5s of audio was
      // acknowledged, while a similar-length call the same run went
      // through in full -- so this reads as an intermittent server-side
      // drop, not something a client-side timer fix can prevent. Turn it
      // into a visible, retryable failure instead of bad data.
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

      const ws = new WebSocket(url);

      const connectTimer = setTimeout(() => {
        connectError = connectError ?? "Cartesia WebSocket connect timed out.";
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
          `Cartesia WebSocket timed out waiting for a final transcript (${Math.round(responseTimeoutMs / 1000)}s budget for a ${input.audioDurationSeconds ?? "unknown-length"}s call).`;
        connectFailureClass = connectFailureClass ?? "provider_timeout";
        try {
          ws.close();
        } catch {
          // socket already dead
        }
        finish();
      }, responseTimeoutMs);

      const armIdleClose = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          try {
            ws.send("close");
          } catch {
            // already closed
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
              ws.send("finalize");
              finalizeSent = true;
            } catch (err) {
              connectError = err instanceof Error ? err.message : String(err);
              // Overwritten, not ??-guarded, to stay in step with the line
              // above: if the message describes this send failure, the class
              // has to describe the same event.
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
          const chunk = pcm.subarray(offset, offset + CHUNK_BYTES);
          offset += CHUNK_BYTES;
          try {
            ws.send(chunk);
            bytesSent += chunk.length;
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
        }, SEND_INTERVAL_MS);
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        const receivedAtMs = Date.now();
        let parsed: CartesiaMessage | null = null;
        try {
          const raw = typeof event.data === "string" ? event.data : event.data.toString();
          parsed = JSON.parse(raw) as CartesiaMessage;
        } catch {
          return; // not JSON we understand -- ignore rather than crash the run
        }
        events.push({ message: parsed, receivedAtMs });
        if (parsed.type === "error") {
          try {
            ws.close();
          } catch {
            // already closed
          }
          return;
        }
        // Only arm the idle-close once all audio has actually been sent --
        // a quiet stretch mid-transmission (a pause between speaker turns)
        // is normal, not "the server is done and we should hang up."
        if (finalizeSent) armIdleClose();
      });

      ws.addEventListener("error", () => {
        connectError = connectError ?? "Cartesia WebSocket connection error.";
        connectFailureClass = connectFailureClass ?? "unknown";
      });

      ws.addEventListener("close", (event: CloseEvent) => {
        wsCloseCode = event.code ?? null;
        if (!finalizeSent) {
          connectError =
            connectError ??
            `Cartesia WebSocket closed before all audio was streamed ` +
              `(sent ${bytesSent}/${pcm.length} bytes, close code ${wsCloseCode}). ` +
              `Likely a transient server-side drop -- safe to retry.`;
          // The provider's server ended the stream before we finished
          // sending. Not an HTTP status, but the same thing provider_5xx
          // names: the vendor's side failed the request, and a retry is
          // the right response.
          connectFailureClass = connectFailureClass ?? "provider_5xx";
        }
        finish();
      });
    });

    const finalAt = new Date().toISOString();
    const reduced = reduceCartesiaTranscript(events, submittedAtMs);
    const rawOutput = { events: events.map((e) => e.message), wsCloseCode };
    const errorMessage =
      connectError ??
      reduced.errorMessage ??
      (reduced.transcript ? null : "Cartesia returned no final transcript segment.");
    // Cartesia's own `error` frames, and a clean close that simply produced
    // no final text, are both left `unknown` on purpose: nothing observed
    // here names a cause, and an unclassified failure has to stay visible
    // as one rather than be filed under the nearest-looking bucket.
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
      httpStatus: null, // WebSocket, not HTTP -- see wsCloseCode inside rawOutput instead
      hypothesisTranscript: reduced.transcript,
      rawOutput,
      errorMessage,
      failureClass,
      diarizationScore: null, // not exposed by this API per current docs
    };
  },
};
