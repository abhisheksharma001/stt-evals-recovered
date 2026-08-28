import {
  ProviderConfigError,
  type ProviderAdapter,
  type ProviderTranscribeInput,
  type ProviderTranscribeResult,
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

export const openAiAdapter: ProviderAdapter = {
  providerId: PROVIDER_ID,
  apiKeyEnvVar: API_KEY_ENV_VAR,
  async transcribe(input: ProviderTranscribeInput): Promise<ProviderTranscribeResult> {
    const apiKey = process.env[API_KEY_ENV_VAR];
    if (!apiKey) throw new ProviderConfigError(PROVIDER_ID, API_KEY_ENV_VAR);

    const submittedAt = new Date().toISOString();

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(input.audioBytes)]), "audio.wav");
    form.append("model", MODEL);
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
