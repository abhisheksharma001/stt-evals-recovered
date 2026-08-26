import { pollUntil } from "../poll";
import {
  ProviderConfigError,
  type ProviderAdapter,
  type ProviderTranscribeInput,
  type ProviderTranscribeResult,
} from "../types";

// AssemblyAI Universal: submit a job (POST /v2/transcript), then poll
// GET /v2/transcript/{id} until status is "completed" or "error".
// Docs: https://www.assemblyai.com/docs/api-reference/transcripts

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

export const assemblyAiAdapter: ProviderAdapter = {
  providerId: PROVIDER_ID,
  apiKeyEnvVar: API_KEY_ENV_VAR,
  async transcribe(input: ProviderTranscribeInput): Promise<ProviderTranscribeResult> {
    const apiKey = process.env[API_KEY_ENV_VAR];
    if (!apiKey) throw new ProviderConfigError(PROVIDER_ID, API_KEY_ENV_VAR);

    const submittedAt = new Date().toISOString();
    const submitRes = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: { authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_url: input.audioUrl,
        speaker_labels: input.diarize ?? true,
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
        errorMessage: `AssemblyAI submit returned HTTP ${submitRes.status}`,
        diarizationScore: null,
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
      });

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
      };
    }
  },
};
