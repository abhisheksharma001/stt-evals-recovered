import { pollUntil, scaledPollTimeoutMs } from "../poll";
import {
  ProviderConfigError,
  type ProviderAdapter,
  type ProviderTranscribeInput,
  type ProviderTranscribeResult,
  type ProviderModelOption,
} from "../types";
import {
  classifyProviderHttpStatus,
  failureClassOf,
} from "../failure-class";

// AssemblyAI Universal: upload bytes first (POST /v2/upload -- returns a
// short-lived URL on AssemblyAI's own CDN), submit a job against that URL
// (POST /v2/transcript), then poll GET /v2/transcript/{id} until status is
// "completed" or "error".
//
// 2026-08-27 (technical-fixes FIX-2): previously sent Vapi's own recording
// URL as `audio_url` directly, which meant AssemblyAI's servers had to fetch
// it themselves -- broke permanently for any call past Vapi's 14-day
// retention window. Uploading our own (cached) bytes first removes that
// dependency: AssemblyAI's CDN URL is only ever used seconds after we create
// it, never subject to Vapi's retention at all.
// Docs: https://www.assemblyai.com/docs/api-reference/transcripts,
// https://www.assemblyai.com/docs/api-reference/upload

export type AssemblyAiResponse = {
  id?: string;
  status?: "queued" | "processing" | "completed" | "error";
  text?: string | null;
  error?: string;
};

export function parseAssemblyAiResponse(body: AssemblyAiResponse): {
  transcript: string | null;
  errorMessage: string | null;
} {
  if (body.status === "error") {
    return { transcript: null, errorMessage: body.error ?? "AssemblyAI job failed" };
  }
  return { transcript: body.text ?? null, errorMessage: null };
}

const PROVIDER_ID = "assemblyai-universal";
const API_KEY_ENV_VAR = "ASSEMBLYAI_API_KEY";

// T-104, verified on assemblyai.com/docs/api-reference/transcripts/submit
// 2026-08-30: `speech_model` is deprecated for `speech_models` (an array);
// allowed values universal-3-5-pro and universal-2; omitted = both, newest
// first. The historical rows here sent nothing, i.e. the vendor default.
export const ASSEMBLYAI_DEFAULT_MODEL = "universal-3-5-pro";

const ASSEMBLYAI_MODELS: ProviderModelOption[] = [
  { apiModel: "universal-3-5-pro", label: "Universal-3.5 Pro", latest: true, source: "catalog", verifiedAt: "2026-08-30", legacyDefault: true, note: "what the assemblyai-universal row is pinned to (T-110); was the vendor default" },
  { apiModel: "universal-2", label: "Universal-2", latest: false, source: "catalog", verifiedAt: "2026-08-30" },
];

export const assemblyAiAdapter: ProviderAdapter = {
  providerId: PROVIDER_ID,
  vendor: "assemblyai",
  vendorLabel: "AssemblyAI",
  listModels: async () => ASSEMBLYAI_MODELS,
  apiKeyEnvVar: API_KEY_ENV_VAR,
  async transcribe(input: ProviderTranscribeInput): Promise<ProviderTranscribeResult> {
    const apiKey = process.env[API_KEY_ENV_VAR];
    if (!apiKey) throw new ProviderConfigError(PROVIDER_ID, API_KEY_ENV_VAR);

    const submittedAt = new Date().toISOString();

    const uploadRes = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: { authorization: apiKey, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(input.audioBytes),
    });
    const uploadBody = (await uploadRes.json().catch(() => null)) as { upload_url?: string } | null;
    if (!uploadRes.ok || !uploadBody?.upload_url) {
      return {
        status: "failed",
        submittedAt,
        finalAt: new Date().toISOString(),
        httpStatus: uploadRes.status,
        hypothesisTranscript: null,
        rawOutput: uploadBody,
        errorMessage: `AssemblyAI upload returned HTTP ${uploadRes.status}: ${JSON.stringify(uploadBody) ?? "no body"}`,
        diarizationScore: null,
        failureClass: classifyProviderHttpStatus(uploadRes.status),
      };
    }

    const submitRes = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: { authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_url: uploadBody.upload_url,
        speaker_labels: input.diarize ?? true,
        // T-110: the historical "assemblyai-universal" row used to send no
        // model at all, i.e. whatever AssemblyAI's default was that day -- a
        // moving target that would silently change what old and new results
        // of the same row mean. Pinned to the default verified 2026-08-30;
        // a newer model gets its own row via T-104, never a silent swap.
        speech_models: [input.model ?? ASSEMBLYAI_DEFAULT_MODEL],
        word_boost: input.keywordBoosts?.length ? input.keywordBoosts : undefined,
      }),
    });

    if (!submitRes.ok) {
      const rawOutput = await submitRes.json().catch(() => null);
      return {
        status: "failed",
        submittedAt,
        finalAt: new Date().toISOString(),
        httpStatus: submitRes.status,
        hypothesisTranscript: null,
        rawOutput,
        errorMessage: `AssemblyAI submit returned HTTP ${submitRes.status}: ${(rawOutput as { error?: string } | null)?.error ?? JSON.stringify(rawOutput) ?? "no body"}`,
        diarizationScore: null,
        failureClass: classifyProviderHttpStatus(submitRes.status),
      };
    }

    const submitBody = (await submitRes.json()) as AssemblyAiResponse;
    const jobId = submitBody.id;
    if (!jobId) {
      return {
        status: "failed",
        submittedAt,
        finalAt: new Date().toISOString(),
        httpStatus: submitRes.status,
        hypothesisTranscript: null,
        rawOutput: submitBody,
        errorMessage: "AssemblyAI did not return a job id",
        diarizationScore: null,
        // A 2xx with no job id is a contract violation we have no bucket
        // for. Left unclassified on purpose rather than guessed at.
        failureClass: "unknown",
      };
    }

    try {
      const finalBody = await pollUntil<AssemblyAiResponse>(async () => {
        const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${jobId}`, {
          headers: { authorization: apiKey },
        });
        const body = (await pollRes.json()) as AssemblyAiResponse;
        if (body.status === "completed" || body.status === "error") return body;
        return null;
      }, { timeoutMs: scaledPollTimeoutMs(input.audioDurationSeconds) });

      const parsed = parseAssemblyAiResponse(finalBody);
      const finalAt = new Date().toISOString();
      return {
        status: parsed.errorMessage ? "failed" : "ok",
        submittedAt,
        finalAt,
        httpStatus: 200,
        hypothesisTranscript: parsed.transcript,
        rawOutput: finalBody,
        errorMessage: parsed.errorMessage,
        diarizationScore: null,
        // AssemblyAI reports its own job failures inside a 200 body. We hold
        // no status or socket state here that would name a cause, so it
        // stays unclassified rather than being read out of the sentence.
        failureClass: parsed.errorMessage ? "unknown" : null,
      };
    } catch (err) {
      return {
        status: "failed",
        submittedAt,
        finalAt: new Date().toISOString(),
        httpStatus: null,
        hypothesisTranscript: null,
        rawOutput: { jobId },
        errorMessage: err instanceof Error ? err.message : String(err),
        diarizationScore: null,
        failureClass: failureClassOf(err) ?? "unknown",
      };
    }
  },
};
