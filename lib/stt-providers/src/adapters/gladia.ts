import { pollUntil } from "../poll";
import {
  ProviderConfigError,
  type ProviderAdapter,
  type ProviderTranscribeInput,
  type ProviderTranscribeResult,
} from "../types";

// Gladia: POST /v2/transcription (JSON, remote url) -> {id, result_url},
// then poll result_url until status "done".
// Docs: https://docs.gladia.io/api-reference/v2/pre-recorded/init

export type GladiaSubmitResponse = { id?: string; result_url?: string };
export type GladiaResultResponse = {
  status?: "queued" | "processing" | "done" | "error";
  result?: {
    transcription?: {
      full_transcript?: string;
      utterances?: Array<{ speaker?: number }>;
    };
  };
  error_code?: number;
};

export function parseGladiaResponse(body: GladiaResultResponse): {
  transcript: string | null;
  diarizationScore: number | null;
  errorMessage: string | null;
} {
  if (body.status === "error") {
    return { transcript: null, diarizationScore: null, errorMessage: `Gladia error ${body.error_code ?? ""}`.trim() };
  }
  const utterances = body.result?.transcription?.utterances ?? [];
  const speakers = new Set(utterances.map((u) => u.speaker).filter((s): s is number => typeof s === "number"));
  return {
    transcript: body.result?.transcription?.full_transcript ?? null,
    diarizationScore: utterances.length ? (speakers.size > 0 ? 1 : 0) : null,
    errorMessage: null,
  };
}

const PROVIDER_ID = "gladia-solaria";
const API_KEY_ENV_VAR = "GLADIA_API_KEY";

export const gladiaAdapter: ProviderAdapter = {
  providerId: PROVIDER_ID,
  apiKeyEnvVar: API_KEY_ENV_VAR,
  async transcribe(input: ProviderTranscribeInput): Promise<ProviderTranscribeResult> {
    const apiKey = process.env[API_KEY_ENV_VAR];
    if (!apiKey) throw new ProviderConfigError(PROVIDER_ID, API_KEY_ENV_VAR);

    const submittedAt = new Date().toISOString();
    const submitRes = await fetch("https://api.gladia.io/v2/transcription", {
      method: "POST",
      headers: { "x-gladia-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_url: input.audioUrl,
        diarization: input.diarize ?? true,
        custom_vocabulary: input.keywordBoosts?.length ? input.keywordBoosts : undefined,
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
        errorMessage: `Gladia submit returned HTTP ${submitRes.status}`,
        diarizationScore: null,
      };
    }

    const submitBody = (await submitRes.json()) as GladiaSubmitResponse;
    if (!submitBody.result_url) {
      return {
        status: "failed",
        submittedAt,
        finalAt: new Date().toISOString(),
        httpStatus: submitRes.status,
        hypothesisTranscript: null,
        rawOutput: submitBody,
        errorMessage: "Gladia did not return a result_url",
        diarizationScore: null,
      };
    }

    try {
      const finalBody = await pollUntil<GladiaResultResponse>(async () => {
        const pollRes = await fetch(submitBody.result_url!, {
          headers: { "x-gladia-key": apiKey },
        });
        const body = (await pollRes.json()) as GladiaResultResponse;
        if (body.status === "done" || body.status === "error") return body;
        return null;
      });

      const parsed = parseGladiaResponse(finalBody);
      return {
        status: parsed.errorMessage ? "failed" : "ok",
        submittedAt,
        finalAt: new Date().toISOString(),
        httpStatus: 200,
        hypothesisTranscript: parsed.transcript,
        rawOutput: finalBody,
        errorMessage: parsed.errorMessage,
        diarizationScore: parsed.diarizationScore,
      };
    } catch (err) {
      return {
        status: "failed",
        submittedAt,
        finalAt: new Date().toISOString(),
        httpStatus: null,
        hypothesisTranscript: null,
        rawOutput: submitBody,
        errorMessage: err instanceof Error ? err.message : String(err),
        diarizationScore: null,
      };
    }
  },
};
