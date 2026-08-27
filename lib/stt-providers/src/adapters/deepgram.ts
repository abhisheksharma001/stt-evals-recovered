import {
  ProviderConfigError,
  type ProviderAdapter,
  type ProviderTranscribeInput,
  type ProviderTranscribeResult,
} from "../types";

// Deepgram Nova-3 prerecorded (batch) transcription: POST /v1/listen with the
// raw audio bytes as the request body (audio/wav), not a remote URL.
//
// 2026-08-27 (technical-fixes FIX-2): previously sent `{"url": audioUrl}` --
// Deepgram's own servers fetched it, which broke permanently for any call
// past Vapi's 14-day retention window. The same endpoint also accepts raw
// bytes directly (documented alternative), which removes that dependency
// entirely -- Deepgram never needs to reach back out to Vapi at all.
// Docs: https://developers.deepgram.com/reference/speech-to-text-api/listen

export type DeepgramResponse = {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        words?: Array<{ speaker?: number }>;
      }>;
    }>;
  };
};

export function parseDeepgramResponse(body: DeepgramResponse): {
  transcript: string | null;
  diarizationScore: number | null;
} {
  const alt = body.results?.channels?.[0]?.alternatives?.[0];
  const transcript = alt?.transcript ?? null;
  const speakers = new Set(
    (alt?.words ?? [])
      .map((w) => w.speaker)
      .filter((s): s is number => typeof s === "number"),
  );
  // We don't have gold speaker segments wired yet (OD-4/PRO-03 dependency),
  // so this is a coarse proxy: 1.0 if diarization returned >=1 distinct
  // speaker label, null if the provider gave us nothing to score.
  const diarizationScore = (alt?.words?.length ?? 0) > 0 ? (speakers.size > 0 ? 1 : 0) : null;
  return { transcript, diarizationScore };
}

const PROVIDER_ID = "deepgram-nova-3";
const API_KEY_ENV_VAR = "DEEPGRAM_API_KEY";

export const deepgramAdapter: ProviderAdapter = {
  providerId: PROVIDER_ID,
  apiKeyEnvVar: API_KEY_ENV_VAR,
  async transcribe(input: ProviderTranscribeInput): Promise<ProviderTranscribeResult> {
    const apiKey = process.env[API_KEY_ENV_VAR];
    if (!apiKey) throw new ProviderConfigError(PROVIDER_ID, API_KEY_ENV_VAR);

    const submittedAt = new Date().toISOString();
    const params = new URLSearchParams({
      model: "nova-3",
      smart_format: "true",
      diarize: String(input.diarize ?? true),
    });
    if (input.keywordBoosts?.length) {
      for (const term of input.keywordBoosts) params.append("keywords", term);
    }

    const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "audio/wav",
      },
      body: new Uint8Array(input.audioBytes),
    });

    const rawOutput = await res.json().catch(() => null);
    const finalAt = new Date().toISOString();

    if (!res.ok) {
      return {
        status: "failed",
        submittedAt,
        finalAt,
        httpStatus: res.status,
        hypothesisTranscript: null,
        rawOutput,
        errorMessage: `Deepgram returned HTTP ${res.status}: ${(rawOutput as { err_msg?: string } | null)?.err_msg ?? JSON.stringify(rawOutput) ?? "no body"}`,
        diarizationScore: null,
      };
    }

    const parsed = parseDeepgramResponse(rawOutput as DeepgramResponse);
    return {
      status: "ok",
      submittedAt,
      finalAt,
      httpStatus: res.status,
      hypothesisTranscript: parsed.transcript,
      rawOutput,
      errorMessage: null,
      diarizationScore: parsed.diarizationScore,
    };
  },
};
