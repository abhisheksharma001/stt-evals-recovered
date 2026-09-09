// Normalized provider adapter contract (PRO-02). Every adapter implements
// this shape so the run executor never special-cases a vendor. Batch/URL
// transcription only for MVP -- these are all REST "give me audio, give me
// back text" APIs. Streaming latency capture (RUN-02: first-partial vs
// final timing) is a separate, harder integration deferred until the batch
// harness has proven the scoring pipeline (see docs/execution-plan.md Phase 2).
//
// 2026-08-27 (technical-fixes FIX-2): the executor hands every adapter raw
// bytes, never a URL. Previously four adapters (AssemblyAI, Deepgram, Gladia,
// Speechmatics) handed a Vapi-signed URL straight to the *provider's own*
// servers to fetch, which meant the URL had to still be alive at run time --
// and Vapi's plan only retains recordings for 14 days, so any call not run
// before then became permanently unscoreable, on every provider, forever
// (confirmed live against 8 corpus calls). The executor now resolves a call's
// audio once, caches the bytes locally (lib/audio-cache.ts), and every
// adapter either uploads those bytes directly (all seven, now) or -- where a
// provider's batch API only accepts a URL it fetches itself -- uploads to
// that provider's own short-lived upload endpoint first. Either way, nothing
// downstream of the initial cache read depends on Vapi's URL surviving.
import { ClassifiedError, classifyProviderHttpStatus, type FailureClass } from "./failure-class";

export type ProviderTranscribeInput = {
  callId: string;
  audioBytes: Buffer;
  keywordBoosts?: string[];
  diarize?: boolean;
  /**
   * 2026-08-27, per Abhishek: a vendor is not a model. Every adapter used to
   * hardcode exactly one model string, so "Deepgram" could only ever mean
   * nova-3 -- while the live Vapi corpus showed production actually running
   * flux-general-en on 86 of 121 calls and nova-2 on 2 more. The benchmark
   * was therefore scoring candidates against a baseline it never measured.
   *
   * The API model string now comes from the provider catalog
   * (registry.ts's providerCatalog) so one adapter serves every model that
   * vendor exposes. Adapters must fall back to their own historical default
   * when this is absent, so existing provider rows behave exactly as before.
   */
  model?: string;
  /** Real audio length, used to scale async poll deadlines (see poll.ts). */
  audioDurationSeconds?: number;
};

export type ProviderTranscribeResult = {
  status: "ok" | "failed";
  submittedAt: string; // ISO timestamp
  finalAt: string | null;
  httpStatus: number | null;
  hypothesisTranscript: string | null;
  rawOutput: unknown;
  errorMessage: string | null;
  diarizationScore: number | null;
  /**
   * ISO timestamp of the first non-empty partial/segment the provider
   * returned, for RUN-02 time-to-first-partial latency. Optional because
   * every batch/URL adapter (all of them except Cartesia, which streams
   * over a WebSocket) has no such notion and legitimately omits it -- the
   * executor treats a missing value as "not measured", not "instant".
   */
  firstPartialAt?: string | null;
  /**
   * M-10b: milliseconds from the last audio chunk leaving this process to
   * the last final transcript segment arriving. Only a streaming adapter
   * can produce it -- the two anchors exist solely inside the socket, and
   * nothing the executor stores can reconstruct them, which is why this is
   * a derived number here rather than a pair of timestamps the executor
   * subtracts (the shape `firstPartialAt` above uses).
   *
   * It is NOT `finalAt - <end of audio>`. `finalAt` is stamped when the
   * socket settles, which is after this adapter's own IDLE_CLOSE_MS wait,
   * so it carries a constant of our own making: measured across 207 live
   * Cartesia rows the end-of-audio-to-`finalAt` gap sits at p25 2,580 ms /
   * median 2,983 ms / p75 3,358 ms, clustered around the 2,000 ms timer
   * rather than around anything Cartesia did. Anchoring on the last final
   * transcript message instead measures the vendor.
   *
   * It is also NOT end-of-speech latency: the anchor is the end of the
   * recording, so trailing silence inflates it. Naming it for what it
   * measures is the point -- `latencyFinalMs` already cost us a ranking by
   * meaning two things at once (M-10a).
   */
  latencyEndOfAudioMs?: number | null;
  /**
   * T-06: why this failed, set by the adapter that saw the actual response.
   * Required in spirit whenever `status === "failed"` -- an adapter that
   * omits it is recorded as `unknown` by the executor rather than having a
   * class inferred from its message. Always null/absent on success.
   */
  failureClass?: FailureClass | null;
};

/** T-104: one model a vendor offers, as the adapter knows it. `source`
 *  says whether the list came from the vendor's own API just now ("live":
 *  Deepgram, OpenAI) or from a list verified against the vendor's docs on
 *  `verifiedAt` ("catalog": AssemblyAI, Gladia, Cartesia, ElevenLabs). */
export type ProviderModelOption = {
  /** Exact string sent to the vendor's API. */
  apiModel: string;
  label: string;
  /** The vendor's newest general model. */
  latest: boolean;
  source: "live" | "catalog";
  verifiedAt: string;
  note?: string;
  /** True for the model the adapter's own historical row (e.g.
   *  "gladia-solaria") actually runs, so that row shows as enabled here. */
  legacyDefault?: boolean;
};

export interface ProviderAdapter {
  /** T-104: vendor key, the prefix of every provider id this adapter serves
   *  ("deepgram" serves deepgram-nova-3, deepgram-nova-3-medical ...). */
  vendor?: string;
  vendorLabel?: string;
  /** T-104: the models this vendor offers today. Absent = one fixed model. */
  listModels?(): Promise<ProviderModelOption[]>;
  /** Must match the `id` column on benchmark_providers. */
  providerId: string;
  /** Env var name holding the API key/secret. Never logged or persisted. */
  apiKeyEnvVar: string;
  transcribe(input: ProviderTranscribeInput): Promise<ProviderTranscribeResult>;
}

export class ProviderConfigError extends Error {
  constructor(providerId: string, envVar: string) {
    super(
      `Provider "${providerId}" is not configured: missing env var ${envVar}. ` +
        `Per PRO-01/logic-register.md, a run must fail loudly rather than silently ` +
        `skip or fall back to another model.`,
    );
    this.name = "ProviderConfigError";
  }
}

/** B-5: a recording link is a credential. Vapi's presigned URLs carry their
 *  signature in the query string, and this message is persisted verbatim into
 *  benchmark_scores.error_message (run-executor.ts:678) and served from
 *  GET /benchmark/runs/:runId/results -- so the whole URL reaches the browser
 *  and stays in the row after the signature has expired. Origin and path name
 *  the object well enough to debug with; everything that authenticates is cut.
 *
 *  This runs inside an error path, so it never throws and never returns the
 *  input on a parse failure. data: and blob: are handled separately because
 *  their "path" is the audio itself, not a locator (audio-cache.test.ts feeds
 *  data: URIs). */
export function redactUrlForMessage(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "<unparseable url>";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `${parsed.protocol}<redacted>`;
  }
  const carried =
    parsed.search !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "";
  return `${parsed.origin}${parsed.pathname}${carried ? " (credentials redacted)" : ""}`;
}

/** R-36 (ox-alpha B-86): the outcome for a `fetch` that THREW while submitting
 *  billable work.
 *
 *  The HTTP-error paths in each adapter are already handled. What was not is a
 *  transport-level throw -- a socket reset, a lost response -- on the request
 *  that creates the job. Those escaped `transcribe()`, and `isRetryableError`
 *  in run-executor treats a generic Error as retryable, so the cell
 *  immediately submitted a SECOND job while the first may already have been
 *  accepted and started billing. AssemblyAI and Speechmatics create an async
 *  job here; OpenAI's call does the transcription itself. All three charge.
 *
 *  Returning a failed result instead of throwing is the whole fix: the attempt
 *  loop asks `isRetryableOutcome(httpStatus, errorMessage)`, and with a null
 *  status and a message that does not say "safe to retry" it stops rather than
 *  resubmitting. The cell stays retryable by a HUMAN -- failureClass "unknown"
 *  is retryable at the run level -- which is the difference between a run that
 *  is resumable and one that is retryable by luck.
 *
 *  The message must never contain "safe to retry": that exact phrase is the
 *  contract `isRetryableOutcome` reads. */
export function submitLegThrewResult(params: {
  vendorLabel: string;
  submittedAt: string;
  err: unknown;
}): ProviderTranscribeResult {
  // "safe to retry" is a CONTROL PHRASE in this repo -- isRetryableOutcome()
  // greps for it. Interpolating a provider's own error text verbatim would let
  // a vendor whose message happens to contain those words steer our retry
  // decision and get the job resubmitted after all, which is the "safe to
  // retry contract abuse" the wave-2 register warns about. Neutralised here
  // rather than trusted. Caught by a test of this function, not by review.
  const raw = params.err instanceof Error ? params.err.message : String(params.err);
  const detail = raw.replace(/safe to retry/gi, "[provider text removed]");
  return {
    status: "failed",
    submittedAt: params.submittedAt,
    finalAt: new Date().toISOString(),
    httpStatus: null,
    hypothesisTranscript: null,
    rawOutput: null,
    errorMessage:
      `${params.vendorLabel} did not answer the request that submits the work: ${detail}. ` +
      `The job may already have been accepted and billed, so it was NOT resubmitted ` +
      `automatically. Retry this run deliberately if you want to pay for it again.`,
    diarizationScore: null,
    failureClass: "unknown",
  };
}

export async function fetchAudioBytes(audioUrl: string): Promise<Buffer> {
  const res = await fetch(audioUrl);
  if (!res.ok) {
    // T-06: classified here, holding the real Response, rather than left for
    // something downstream to read out of the sentence below. A 403/401 on a
    // presigned recording link is the storage-bucket failure documented in
    // docs/backlog/good-to-have.md -- permanent, never worth a retry.
    const failureClass =
      res.status === 403 || res.status === 401
        ? "audio_url_forbidden"
        : classifyProviderHttpStatus(res.status);
    throw new ClassifiedError(
      `Failed to fetch audio from ${redactUrlForMessage(audioUrl)}: HTTP ${res.status}`,
      failureClass,
      { httpStatus: res.status },
    );
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
