import {
  ProviderConfigError,
  type ProviderAdapter,
  type ProviderTranscribeInput,
  type ProviderTranscribeResult,
} from "../types";

// ElevenLabs Scribe: POST /v1/speech-to-text (multipart upload).
// Docs: https://elevenlabs.io/docs/api-reference/speech-to-text

export type ElevenLabsResponse = {
  text?: string;
  words?: Array<{ speaker_id?: string }>;
  detail?: { message?: string } | string;
};

export function parseElevenLabsResponse(body: ElevenLabsResponse): {
  transcript: string | null;
  diarizationScore: number | null;
  errorMessage: string | null;
} {
  if (body.detail) {
    const message = typeof body.detail === "string" ? body.detail : body.detail.message;
    return { transcript: null, diarizationScore: null, errorMessage: message ?? "ElevenLabs error" };
  }
  const speakers = new Set((body.words ?? []).map((w) => w.speaker_id).filter(Boolean));
  return {
    transcript: body.text ?? null,
    diarizationScore: body.words?.length ? (speakers.size > 0 ? 1 : 0) : null,
    errorMessage: null,
  };
}

const PROVIDER_ID = "elevenlabs-scribe";
const API_KEY_ENV_VAR = "ELEVENLABS_API_KEY";

export const elevenLabsAdapter: ProviderAdapter = {
  providerId: PROVIDER_ID,
  apiKeyEnvVar: API_KEY_ENV_VAR,
  async transcribe(input: ProviderTranscribeInput): Promise<ProviderTranscribeResult> {
    const apiKey = process.env[API_KEY_ENV_VAR];
    if (!apiKey) throw new ProviderConfigError(PROVIDER_ID, API_KEY_ENV_VAR);

    const submittedAt = new Date().toISOString();

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(input.audioBytes)]), "audio.wav");
    form.append("model_id", "scribe_v1");
    form.append("diarize", String(input.diarize ?? true));

    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });

    const rawOutput = (await res.json().catch(() => null)) as ElevenLabsResponse | null;
    const finalAt = new Date().toISOString();

    if (!res.ok || !rawOutput) {
      return {
        status: "failed",
        submittedAt,
        finalAt,
        httpStatus: res.status,
        hypothesisTranscript: null,
        rawOutput,
        errorMessage: `ElevenLabs returned HTTP ${res.status}: ${(typeof rawOutput?.detail === "string" ? rawOutput.detail : rawOutput?.detail?.message) ?? JSON.stringify(rawOutput) ?? "no body"}`,
        diarizationScore: null,
      };
    }

    const parsed = parseElevenLabsResponse(rawOutput);
    return {
      status: parsed.errorMessage ? "failed" : "ok",
      submittedAt,
      finalAt,
      httpStatus: res.status,
      hypothesisTranscript: parsed.transcript,
      rawOutput,
      errorMessage: parsed.errorMessage,
      diarizationScore: parsed.diarizationScore,
    };
  },
};
