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
   * T-06: why this failed, set by the adapter that saw the actual response.
   * Required in spirit whenever `status === "failed"` -- an adapter that
   * omits it is recorded as `unknown` by the executor rather than having a
   * class inferred from its message. Always null/absent on success.
   */
  failureClass?: FailureClass | null;
};

export interface ProviderAdapter {
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
      `Failed to fetch audio from ${audioUrl}: HTTP ${res.status}`,
      failureClass,
      { httpStatus: res.status },
    );
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
