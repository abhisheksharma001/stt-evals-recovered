import {
  ProviderConfigError,
  type ProviderAdapter,
  type ProviderTranscribeInput,
  type ProviderTranscribeResult,
  type ProviderModelOption,
} from "../types";
import { classifyProviderHttpStatus } from "../failure-class";

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

/** T-104: Deepgram lists its models live (GET /v1/models, verified
 *  2026-08-30: 443 STT entries, keyed by canonical_name + architecture).
 *  Deduped to one row per canonical name; "latest" = the general model of
 *  the highest nova generation. Flux models are streaming-only and appear
 *  under their own names. */
async function listDeepgramModels(): Promise<ProviderModelOption[]> {
  const apiKey = process.env[API_KEY_ENV_VAR];
  if (!apiKey) throw new ProviderConfigError(PROVIDER_ID, API_KEY_ENV_VAR);
  const res = await fetch("https://api.deepgram.com/v1/models", { headers: { Authorization: `Token ${apiKey}` } });
  if (!res.ok) throw new Error(`Deepgram /v1/models returned HTTP ${res.status}`);
  const body = (await res.json()) as { stt?: Array<{ canonical_name?: string; architecture?: string; version?: string }> };
  const byName = new Map<string, { architecture: string; version: string }>();
  for (const m of body.stt ?? []) {
    if (!m.canonical_name || !/^(nova|flux)/.test(m.canonical_name)) continue;
    if (!byName.has(m.canonical_name)) byName.set(m.canonical_name, { architecture: m.architecture ?? "", version: m.version ?? "" });
  }
  let topNova = 0;
  for (const name of byName.keys()) {
    const g = name.match(/^nova-(\d+)/);
    if (g) topNova = Math.max(topNova, Number(g[1]));
  }
  const verifiedAt = new Date().toISOString();
  return [...byName.entries()]
    // "nova-3-general" is what Deepgram accepts as plain "nova-3" (docs:
    // the -general suffix is the default variant), and "nova-3" is the id
    // this repo's rows have always used, so the alias is the api model here.
    .map(([name, m]) => [name.replace(/-general$/, ""), m, name] as const)
    .map(([apiModel, m, name]) => ({
      apiModel,
      label: name,
      latest: name === `nova-${topNova}-general`,
      legacyDefault: apiModel === "nova-3",
      source: "live" as const,
      verifiedAt,
      note: m.version ? `${m.architecture} ${m.version}` : m.architecture,
    }))
    .sort((a, b) => Number(b.latest) - Number(a.latest) || a.apiModel.localeCompare(b.apiModel));
}

export const deepgramAdapter: ProviderAdapter = {
  providerId: PROVIDER_ID,
  vendor: "deepgram",
  vendorLabel: "Deepgram",
  listModels: listDeepgramModels,
  apiKeyEnvVar: API_KEY_ENV_VAR,
  async transcribe(input: ProviderTranscribeInput): Promise<ProviderTranscribeResult> {
    const apiKey = process.env[API_KEY_ENV_VAR];
    if (!apiKey) throw new ProviderConfigError(PROVIDER_ID, API_KEY_ENV_VAR);

    const submittedAt = new Date().toISOString();
    const params = new URLSearchParams({
      // Falls back to the historical hardcoded model so existing provider
      // rows behave exactly as before; the catalog supplies the rest.
      model: input.model ?? "nova-3",
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
        failureClass: classifyProviderHttpStatus(res.status),
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
