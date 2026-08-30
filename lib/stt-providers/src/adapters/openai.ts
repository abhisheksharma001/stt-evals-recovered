import {
  ProviderConfigError,
  type ProviderAdapter,
  type ProviderTranscribeInput,
  type ProviderTranscribeResult,
  type ProviderModelOption,
} from "../types";
import { classifyProviderHttpStatus } from "../failure-class";

// OpenAI gpt-4o-transcribe / whisper: POST /v1/audio/transcriptions.
// Takes uploaded bytes directly -- the executor already hands us the cached
// corpus audio, so we just re-upload it.
// Docs: https://platform.openai.com/docs/api-reference/audio/createTranscription

export type OpenAiResponse = {
  text?: string;
  error?: { message?: string };
};

export function parseOpenAiResponse(body: OpenAiResponse): {
  transcript: string | null;
  errorMessage: string | null;
} {
  if (body.error) return { transcript: null, errorMessage: body.error.message ?? "OpenAI error" };
  return { transcript: body.text ?? null, errorMessage: null };
}

const PROVIDER_ID = "openai-gpt-4o-transcribe";
const API_KEY_ENV_VAR = "OPENAI_API_KEY";
const MODEL = "gpt-4o-transcribe";

/** T-104: OpenAI lists models live (GET /v1/models). Kept: ids containing
 *  "transcribe" or "whisper" that are not realtime/live variants. Verified
 *  2026-08-30: gpt-transcribe, gpt-4o-transcribe, gpt-4o-mini-transcribe,
 *  gpt-4o-transcribe-diarize, whisper-1. "latest" = gpt-transcribe when
 *  present (OpenAI's own migration guide names it the successor). */
async function listOpenAiModels(): Promise<ProviderModelOption[]> {
  const apiKey = process.env[API_KEY_ENV_VAR];
  if (!apiKey) throw new ProviderConfigError(PROVIDER_ID, API_KEY_ENV_VAR);
  const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`OpenAI /v1/models returned HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (body.data ?? [])
    .map((m) => m.id ?? "")
    .filter((id) => /transcribe|whisper/.test(id) && !/realtime|live/.test(id) && !/-\d{4}-\d{2}-\d{2}$/.test(id))
    .sort();
  const verifiedAt = new Date().toISOString();
  const latestId = ids.includes("gpt-transcribe") ? "gpt-transcribe" : MODEL;
  return ids
    .map((id) => ({ apiModel: id, label: id, latest: id === latestId, source: "live" as const, verifiedAt, legacyDefault: id === MODEL }))
    .sort((a, b) => Number(b.latest) - Number(a.latest) || a.apiModel.localeCompare(b.apiModel));
}

export const openAiAdapter: ProviderAdapter = {
  providerId: PROVIDER_ID,
  vendor: "openai",
  vendorLabel: "OpenAI",
  listModels: listOpenAiModels,
  apiKeyEnvVar: API_KEY_ENV_VAR,
  async transcribe(input: ProviderTranscribeInput): Promise<ProviderTranscribeResult> {
    const apiKey = process.env[API_KEY_ENV_VAR];
    if (!apiKey) throw new ProviderConfigError(PROVIDER_ID, API_KEY_ENV_VAR);

    const submittedAt = new Date().toISOString();

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(input.audioBytes)]), "audio.wav");
    form.append("model", input.model ?? MODEL);
    form.append("response_format", "json");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    const rawOutput = (await res.json().catch(() => null)) as OpenAiResponse | null;
    const finalAt = new Date().toISOString();

    if (!res.ok || !rawOutput) {
      return {
        status: "failed",
        submittedAt,
        finalAt,
        httpStatus: res.status,
        hypothesisTranscript: null,
        rawOutput,
        errorMessage: `OpenAI returned HTTP ${res.status}: ${rawOutput?.error?.message ?? JSON.stringify(rawOutput) ?? "no body"}`,
        diarizationScore: null,
        failureClass: classifyProviderHttpStatus(res.status),
      };
    }

    const parsed = parseOpenAiResponse(rawOutput);
    return {
      status: parsed.errorMessage ? "failed" : "ok",
      submittedAt,
      finalAt,
      httpStatus: res.status,
      hypothesisTranscript: parsed.transcript,
      rawOutput,
      errorMessage: parsed.errorMessage,
      failureClass: parsed.errorMessage ? "unknown" : null,
      diarizationScore: null, // OpenAI transcription API does not diarize
    };
  },
};
