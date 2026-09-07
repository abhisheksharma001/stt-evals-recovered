import {
  ProviderConfigError,
  type ProviderAdapter,
  type ProviderTranscribeInput,
  type ProviderTranscribeResult,
} from "../types";
import { scaledPollTimeoutMs } from "../poll";
import type { FailureClass } from "../failure-class";
// Vendor-neutral, imported rather than copied for the same reason
// deepgram-streaming.ts imports them: parseWavPcm reads a RIFF header and
// endOfAudioLatencyMs is the ONE definition of the M-10b measurement.
import { endOfAudioLatencyMs, parseWavPcm, type WavPcmInfo } from "./cartesia";
// Two pure helpers from the v1 streaming adapter. Both are about the audio
// file, not about v1: the chunk size is derived from the WAV header so the
// stream runs at real time, and 16-bit PCM maps to linear16 on v2 exactly as
// it does on v1 (Flux also accepts linear32, mulaw, alaw, opus and ogg-opus,
// none of which this corpus contains). The socket machinery below is NOT
// shared -- see the header comment.
import { deepgramEncodingForBitDepth, deepgramStreamChunkBytes } from "./deepgram-streaming";

// Deepgram Flux, the v2 turn-based Listen socket. A third Deepgram adapter,
// because Flux is a third product: deepgram.ts POSTs a file,
// deepgram-streaming.ts streams nova-3 over the v1 socket, and this streams
// flux-general-en over the v2 socket, which speaks an entirely different
// message vocabulary (turns, not interim/final results).
//
// It exists because production is already running it. The live Vapi corpus
// shows deepgram/flux-general-en as the actual transcriber on 86 of 121
// calls, and until now providerCatalog pointed that id at the BATCH adapter,
// which has no endpoint that can serve a streaming-only model -- so the row
// that represents the production baseline could not have run at all.
//
// Docs, read 2026-09-07:
//   https://developers.deepgram.com/reference/speech-to-text/listen-flux
//
// UNVERIFIED, flagged per the docs/provider-matrix.md convention -- confirm
// against a real key in M-11d before trusting either:
//
//  1. THE AUTHENTICATION. Deepgram documents the Sec-WebSocket-Protocol
//     `token, <API_KEY>` pair on a page that names "Deepgram's Listen
//     WebSocket endpoint" and links to the V1 streaming reference. It never
//     mentions v2, /v2/listen or Flux. The Flux reference itself documents an
//     `Authorization` header and nothing else, and the global Node WebSocket
//     cannot set headers. So the subprotocol is used here because it is the
//     only header-less method Deepgram documents anywhere -- not because it
//     is documented for this endpoint. Assuming otherwise is precisely the
//     move that produced the M-11a defect: carrying a claim across an
//     endpoint boundary the vendor never crossed.
//  2. THE ERROR FRAME NAME. The reference lists ListenV2FatalError as a
//     server message; every message whose wire `type` this repo has actually
//     seen documented drops the ListenV2 prefix (ListenV2CloseStream is sent
//     as {"type":"CloseStream"}, ListenV2TurnInfo arrives as
//     {"type":"TurnInfo"}), so "FatalError" is the pattern-derived name and
//     is matched below. A frame under any other name is recorded in the raw
//     output but will read as "no final transcript" rather than as the error
//     it was, until M-11d captures a real one.
const PROVIDER_ID = "deepgram-flux-general-en";
const API_KEY_ENV_VAR = "DEEPGRAM_API_KEY";
const DEFAULT_API_MODEL = "flux-general-en";
// One chunk carries this much audio and is sent this often, so the stream
// runs at exactly real time. The two uses are paired deliberately: the size
// is derived from this number and the WAV header, and the interval IS this
// number. Splitting them -- deriving the size from a helper's own default
// while hardcoding the interval -- is how a stream silently runs at 2x and
// turns a latency measurement into fiction.
const CHUNK_MS = 200;
const CONNECT_TIMEOUT_MS = 15_000;
// Quiet period after CloseStream before hanging up. One stage, not the two
// deepgram-streaming.ts needs: v1 has a Finalize message that asks the server
// to flush before the close is requested, and v2 documents no such message --
// CloseStream is itself the flush-and-finish request.
const IDLE_CLOSE_MS = 2_000;

// ---- Pure helpers (network-free, unit tested in parsers.test.ts) ----

/** The socket's URL and its subprotocols. Mirrors deepgramStreamSocketArgs
 * deliberately, including building the query parameters itself rather than
 * taking them: M-11e's break test showed that leaving the parameter block
 * outside the helper leaves the one place a credential could reach the URL
 * uncovered by any test.
 *
 * Every parameter here appears in the v2 reference. Four that the v1 adapter
 * sends are absent because v2 documents none of them: `channels` (which is
 * why non-mono audio is refused outright below rather than sent as if it were
 * mono), `smart_format`, `diarize`, and `interim_results` -- partial text
 * arrives as Update / StartOfTurn turns by default, so the first-partial
 * anchor needs no parameter here. */
export function deepgramFluxSocketArgs(
  apiKey: string,
  opts: { model: string; encoding: string; sampleRate: number; keywordBoosts?: string[] },
): { url: string; protocols: [string, string] } {
  const params = new URLSearchParams({
    model: opts.model,
    encoding: opts.encoding,
    sample_rate: String(opts.sampleRate),
  });
  // v2's spelling of the v1 `keywords` parameter.
  for (const term of opts.keywordBoosts ?? []) params.append("keyterm", term);
  return {
    url: `wss://api.deepgram.com/v2/listen?${params.toString()}`,
    protocols: ["token", apiKey],
  };
}

export type DeepgramFluxWord = {
  word?: string;
  confidence?: number;
  start?: number;
  end?: number;
};

export type DeepgramFluxMessage =
  | {
      type: "TurnInfo";
      event?: "Update" | "StartOfTurn" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn";
      turn_index?: number;
      transcript?: string;
      words?: DeepgramFluxWord[];
      end_of_turn_confidence?: number;
    }
  | { type: string; [key: string]: unknown };

export type DeepgramFluxEvent = { message: DeepgramFluxMessage; receivedAtMs: number };

/** Reduces the raw v2 message sequence into a transcript plus the two timing
 * anchors, in isolation from the socket.
 *
 * Flux does not report interim/final segments the way v1 does; it reports
 * TURNS. Only `EndOfTurn` settles one. `EagerEndOfTurn` is a prediction the
 * server offers so a voice agent can start thinking early, and `TurnResumed`
 * retracts it -- treating it as final would put speculative text that the
 * speaker went on to contradict into a scored transcript.
 *
 * The first-partial anchor is deliberately looser than the final one: any
 * turn carrying text counts, because RUN-02 asks when the agent could first
 * have seen words, not when they were settled. */
export function reduceDeepgramFluxTranscript(
  events: DeepgramFluxEvent[],
  startedAtMs: number,
): {
  transcript: string | null;
  firstPartialMs: number | null;
  lastFinalMs: number | null;
  errorMessage: string | null;
} {
  const turns: string[] = [];
  let firstPartialMs: number | null = null;
  let lastFinalMs: number | null = null;
  let errorMessage: string | null = null;

  for (const { message, receivedAtMs } of events) {
    if (message.type === "FatalError") {
      const m = message as { description?: string; message?: string; reason?: string };
      errorMessage = m.description ?? m.message ?? m.reason ?? "Deepgram Flux fatal error.";
      continue;
    }
    if (message.type !== "TurnInfo") continue;
    const turn = message as Extract<DeepgramFluxMessage, { type: "TurnInfo" }>;
    const text = (turn.transcript ?? "").trim();
    if (firstPartialMs === null && text.length > 0) {
      firstPartialMs = receivedAtMs - startedAtMs;
    }
    if (turn.event === "EndOfTurn" && text.length > 0) {
      turns.push(text);
      // Same condition as the push above on purpose: this is the instant the
      // transcript stopped growing, not the instant the socket shut, which is
      // IDLE_CLOSE_MS later and would measure our own timer (M-10b).
      lastFinalMs = receivedAtMs - startedAtMs;
    }
  }

  if (errorMessage) return { transcript: null, firstPartialMs, lastFinalMs, errorMessage };
  return {
    transcript: turns.join(" ").trim() || null,
    firstPartialMs,
    lastFinalMs,
    errorMessage: null,
  };
}

/** Always null, and a function rather than a literal so the reason is
 * assertable: Flux's documented parameter list contains no `diarize` and its
 * words carry no speaker label, so this row cannot separate speakers at all.
 *
 * Null, never 0. Zero is the score deepgram-streaming.ts gives a response
 * that COULD have carried speaker labels and did not; scoring Flux the same
 * way would rank it below a provider that tried and failed, for the
 * different reason that it was never asked. Absent is not zero. */
export function deepgramFluxDiarizationScore(): null {
  return null;
}

// ---- Live adapter ----

export const deepgramFluxAdapter: ProviderAdapter = {
  // The id that already exists in benchmark_providers and in providerCatalog,
  // not a new one: this step repairs a mapping rather than adding a row.
  providerId: PROVIDER_ID,
  // Same Deepgram account, same rate limit, so the same concurrency bucket --
  // and vendorOfProviderId must call this "deepgram" so the confidence and
  // timed-word extractors treat it as they treat every other Deepgram row.
  vendor: "deepgram",
  vendorLabel: "Deepgram",
  // NO listModels, for the reason deepgram-streaming.ts has none:
  // /benchmark/providers/models filters to the adapters that declare one and
  // groups them by vendor, so a second or third Deepgram adapter declaring
  // one would render extra Deepgram cards on Setup.
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
      // parseWavPcm already refuses anything but mono, which is the whole
      // requirement here: v2 documents no `channels` parameter, so there is
      // no way to tell Flux that samples are interleaved, and sending them
      // anyway would have the server decode two channels as one at half
      // speed and score the resulting noise as recognition error.
      //
      // An explicit re-check was written here first and removed: it could
      // never fire, and the test written to prove it worked passed on
      // parseWavPcm's error instead (its message also says "mono"). The
      // requirement is asserted at this adapter's own boundary in
      // parsers.test.ts, so relaxing parseWavPcm for some other vendor
      // fails that test rather than silently letting stereo through here.
      wav = parseWavPcm(input.audioBytes);
      encoding = deepgramEncodingForBitDepth(wav.bitsPerSample);
      chunkBytes = deepgramStreamChunkBytes(wav, CHUNK_MS);
    } catch (err) {
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

    // Every connect-time argument, credential included, built in one place so
    // that no later edit here can put the key on the URL (M-11e).
    const { url, protocols } = deepgramFluxSocketArgs(apiKey, {
      model: input.model ?? DEFAULT_API_MODEL,
      encoding,
      sampleRate: wav.sampleRate,
      keywordBoosts: input.keywordBoosts,
    });

    const events: DeepgramFluxEvent[] = [];
    let lastAudioSentAtMs: number | null = null;
    let connectError: string | null = null;
    let connectFailureClass: FailureClass | null = null;
    let wsCloseCode: number | null = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      let sendTimer: ReturnType<typeof setInterval> | null = null;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      // Gates the idle close on all the audio having actually gone out, so a
      // pause between speaker turns is never read as "the server is done".
      // This is the bug that truncated live Cartesia transcripts to the first
      // pause on 2026-08-24; inherited as a rule rather than rediscovered.
      let closeStreamSent = false;
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
      // (run-executor.ts, the `if (!result)` branch). The credential is an
      // argument to this constructor -- in the subprotocol, not the URL --
      // and this can throw on either argument, so nothing it might say is
      // ever repeated: the message is a constant. Resolves directly rather
      // than through finish(), which reads timers that do not exist yet.
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, protocols);
      } catch {
        settled = true;
        connectError = "Deepgram Flux WebSocket could not be opened.";
        connectFailureClass = "unknown";
        resolve();
        return;
      }

      const connectTimer = setTimeout(() => {
        connectError = connectError ?? "Deepgram Flux WebSocket connect timed out.";
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
          `Deepgram Flux WebSocket timed out waiting for a final turn (${Math.round(responseTimeoutMs / 1000)}s budget for a ${input.audioDurationSeconds ?? "unknown-length"}s call).`;
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
              // v2's only flush-and-finish request. There is no Finalize.
              ws.send(JSON.stringify({ type: "CloseStream" }));
              closeStreamSent = true;
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
            // Stamped after send() so a throw leaves it on the previous chunk
            // rather than claiming audio that never went out.
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
        let parsed: DeepgramFluxMessage | null = null;
        try {
          const raw = typeof event.data === "string" ? event.data : event.data.toString();
          parsed = JSON.parse(raw) as DeepgramFluxMessage;
        } catch {
          return; // not JSON we understand -- ignore rather than crash the run
        }
        events.push({ message: parsed, receivedAtMs });
        if (parsed.type === "FatalError") {
          try {
            ws.close();
          } catch {
            // already closed
          }
          return;
        }
        if (closeStreamSent) armIdleClose();
      });

      ws.addEventListener("error", () => {
        connectError = connectError ?? "Deepgram Flux WebSocket connection error.";
        connectFailureClass = connectFailureClass ?? "unknown";
      });

      ws.addEventListener("close", (event: CloseEvent) => {
        wsCloseCode = event.code ?? null;
        if (!closeStreamSent) {
          connectError =
            connectError ??
            `Deepgram Flux WebSocket closed before all audio was streamed ` +
              `(sent ${bytesSent}/${pcm.length} bytes, close code ${wsCloseCode}). ` +
              `Likely a transient server-side drop -- safe to retry.`;
          connectFailureClass = connectFailureClass ?? "provider_5xx";
        }
        finish();
      });
    });

    const finalAt = new Date().toISOString();
    const reduced = reduceDeepgramFluxTranscript(events, submittedAtMs);
    const rawOutput = { events: events.map((e) => e.message), wsCloseCode };
    const errorMessage =
      connectError ??
      reduced.errorMessage ??
      (reduced.transcript ? null : "Deepgram Flux returned no end-of-turn transcript.");
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
      httpStatus: null, // WebSocket, not HTTP -- see wsCloseCode inside rawOutput
      hypothesisTranscript: reduced.transcript,
      rawOutput,
      errorMessage,
      failureClass,
      diarizationScore: deepgramFluxDiarizationScore(),
    };
  },
};
