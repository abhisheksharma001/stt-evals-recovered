import { pollUntil } from "../poll";
import {
  ProviderConfigError,
  type ProviderAdapter,
  type ProviderTranscribeInput,
  type ProviderTranscribeResult,
} from "../types";

// Speechmatics batch: POST /v2/jobs (multipart `config` part plus a
// `data_file` part with the raw audio), then poll GET /v2/jobs/{id} for
// status "done", then GET /v2/jobs/{id}/transcript?format=json-v2.
//
// 2026-08-27 (technical-fixes FIX-2): previously used `fetch_url` so
// Speechmatics' servers fetched Vapi's own recording URL themselves -- broke
// permanently for any call past Vapi's 14-day retention window. `data_file`
// is the documented alternative for uploading bytes directly instead of
// pointing at a remote URL, which removes that dependency entirely.
// Docs: https://docs.speechmatics.com/api-ref/batch-async

export type SpeechmaticsSubmitResponse = { id?: string };
export type SpeechmaticsJobStatusResponse = {
  job?: { status?: "running" | "done" | "rejected" };
};
export type SpeechmaticsTranscriptResponse = {
  results?: Array<{
    alternatives?: Array<{ content?: string; speaker?: string }>;
  }>;
};

export function parseSpeechmaticsTranscript(body: SpeechmaticsTranscriptResponse): {
  transcript: string;
  diarizationScore: number | null;
} {
  const tokens = body.results ?? [];
  const transcript = tokens
    .map((r) => r.alternatives?.[0]?.content ?? "")
    .join(" ")
    .replace(/\s+([.,!?])/g, "$1")
    .trim();
  const speakers = new Set(
    tokens.map((r) => r.alternatives?.[0]?.speaker).filter((s): s is string => Boolean(s)),
  );
  return { transcript, diarizationScore: tokens.length ? (speakers.size > 0 ? 1 : 0) : null };
}

const PROVIDER_ID = "speechmatics";
const API_KEY_ENV_VAR = "SPEECHMATICS_API_KEY";

export const speechmaticsAdapter: ProviderAdapter = {
  providerId: PROVIDER_ID,
  apiKeyEnvVar: API_KEY_ENV_VAR,
  async transcribe(input: ProviderTranscribeInput): Promise<ProviderTranscribeResult> {
    const apiKey = process.env[API_KEY_ENV_VAR];
    if (!apiKey) throw new ProviderConfigError(PROVIDER_ID, API_KEY_ENV_VAR);

    const submittedAt = new Date().toISOString();
    const config = {
      type: "transcription",
      transcription_config: {
        language: "en",
        diarization: (input.diarize ?? true) ? "speaker" : "none",
        additional_vocab: input.keywordBoosts?.map((content) => ({ content })),
      },
    };

    const form = new FormData();
    form.append("config", JSON.stringify(config));
    form.append("data_file", new Blob([new Uint8Array(input.audioBytes)]), "audio.wav");

    const submitRes = await fetch("https://asr.api.speechmatics.com/v2/jobs", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
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
        errorMessage: `Speechmatics submit returned HTTP ${submitRes.status}: ${(rawOutput as { detail?: string } | null)?.detail ?? JSON.stringify(rawOutput) ?? "no body"}`,
        diarizationScore: null,
      };
    }

    const submitBody = (await submitRes.json()) as SpeechmaticsSubmitResponse;
    const jobId = submitBody.id;
    if (!jobId) {
      return {
        status: "failed",
        submittedAt,
        finalAt: new Date().toISOString(),
        httpStatus: submitRes.status,
        hypothesisTranscript: null,
        rawOutput: submitBody,
        errorMessage: "Speechmatics did not return a job id",
        diarizationScore: null,
      };
    }

    try {
      await pollUntil<true>(async () => {
        const statusRes = await fetch(`https://asr.api.speechmatics.com/v2/jobs/${jobId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const body = (await statusRes.json()) as SpeechmaticsJobStatusResponse;
        if (body.job?.status === "done") return true;
        if (body.job?.status === "rejected") {
          throw new Error("Speechmatics job was rejected");
        }
        return null;
      });

      const transcriptRes = await fetch(
        `https://asr.api.speechmatics.com/v2/jobs/${jobId}/transcript?format=json-v2`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      const transcriptBody = (await transcriptRes.json()) as SpeechmaticsTranscriptResponse;
      const parsed = parseSpeechmaticsTranscript(transcriptBody);

      return {
        status: "ok",
        submittedAt,
        finalAt: new Date().toISOString(),
        httpStatus: transcriptRes.status,
        hypothesisTranscript: parsed.transcript,
        rawOutput: transcriptBody,
        errorMessage: null,
        diarizationScore: parsed.diarizationScore,
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
