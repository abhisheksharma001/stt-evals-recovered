// The transcript-quality agent (requested by Abhishek 2026-08-25): reads a
// call's current best transcript looking for spans that sound wrong, and --
// when it finds any -- judges which candidate transcript (from re-running
// the call through the other STT providers) reads most sensibly. This file
// is ONLY the two OpenAI calls; the orchestration (spawning the re-run,
// storing results, the human-approval gate before anything touches
// goldTranscript) lives in routes/agent.ts, same separation as
// lib/run-executor.ts vs routes/benchmark.ts.
//
// Follows this repo's existing convention (see lib/stt-providers/src/adapters)
// of raw fetch against the provider's REST API rather than an SDK dependency.

import type { BenchmarkAgentFlag } from "@workspace/db";

const API_KEY_ENV_VAR = "OPENAI_API_KEY";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
// Cheap model for the flag pass (runs on every scan, mostly finds nothing);
// a stronger model only for judging candidates (runs only when flags were
// found, and picking the "most sensible" transcript is the harder call).
// Both are easy to change in one place if the quality/cost tradeoff is wrong.
const FLAG_MODEL = "gpt-4o-mini";
const JUDGE_MODEL = "gpt-4o";

export class AgentConfigError extends Error {
  constructor() {
    super(`${API_KEY_ENV_VAR} is not configured.`);
    this.name = "AgentConfigError";
  }
}

export class AgentRequestError extends Error {
  readonly httpStatus: number;
  constructor(httpStatus: number, message: string) {
    super(message);
    this.name = "AgentRequestError";
    this.httpStatus = httpStatus;
  }
}

async function callOpenAi(params: {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const apiKey = process.env[API_KEY_ENV_VAR];
  if (!apiKey) throw new AgentConfigError();

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: params.schemaName,
          strict: true,
          schema: params.schema,
        },
      },
    }),
  });

  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };

  if (!res.ok) {
    throw new AgentRequestError(res.status, body.error?.message ?? `OpenAI returned HTTP ${res.status}`);
  }

  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new AgentRequestError(res.status, "OpenAI response had no content");

  return JSON.parse(content) as Record<string, unknown>;
}

export async function flagTranscript(
  transcript: string,
  vertical: string,
): Promise<BenchmarkAgentFlag[]> {
  const result = await callOpenAi({
    model: FLAG_MODEL,
    system:
      "You review call-center transcripts for a speech-to-text benchmarking tool. " +
      "Read the transcript and flag any word or short phrase that reads as likely " +
      "mis-transcribed: nonsensical in context, grammatically broken in a way that " +
      "suggests a wrong word substitution, or inconsistent with the surrounding " +
      "conversation (e.g. a name, number, or address that doesn't fit the sentence). " +
      "Do NOT flag disfluencies, filler words, informal grammar, or things that are " +
      "merely awkward but plausible as real speech -- only flag things that likely " +
      "represent a transcription error. If the transcript reads cleanly, return no flags. " +
      `This call is from the "${vertical}" vertical.`,
    user: transcript,
    schemaName: "transcript_flags",
    schema: {
      type: "object",
      properties: {
        flags: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The exact flagged word or short phrase, verbatim from the transcript." },
              reason: { type: "string", description: "One sentence: why this looks like a transcription error." },
            },
            required: ["text", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["flags"],
      additionalProperties: false,
    },
  });

  const flags = result.flags;
  if (!Array.isArray(flags)) return [];
  return flags.filter(
    (f): f is BenchmarkAgentFlag =>
      typeof f === "object" && f !== null && typeof f.text === "string" && typeof f.reason === "string",
  );
}

export async function judgeCandidates(params: {
  originalTranscript: string;
  flags: BenchmarkAgentFlag[];
  candidates: { providerId: string; providerName: string; transcript: string }[];
  // 2026-08-26: caller-supplied override, read from app_settings.agentModel
  // by routes/agent.ts (this file stays DB-free, per the file header's
  // "ONLY the two OpenAI calls" separation). Falls back to JUDGE_MODEL when
  // omitted, empty, or the caller passed a settings row with no override set.
  model?: string | null;
}): Promise<{ pickedProviderId: string | null; reasoning: string }> {
  if (params.candidates.length === 0) {
    return { pickedProviderId: null, reasoning: "No candidate transcripts were available to compare (every re-run provider failed)." };
  }

  const candidateIds = params.candidates.map((c) => c.providerId);
  const result = await callOpenAi({
    model: params.model?.trim() || JUDGE_MODEL,
    system:
      "You are comparing several speech-to-text providers' transcripts of the same call, " +
      "after another pass flagged specific spans in an earlier transcript as likely wrong. " +
      "Pick whichever candidate transcript reads most sensibly given the full conversation's " +
      "context -- especially around the flagged spans. This is your best guess from text alone, " +
      "not a certainty: a human will review your pick against the actual audio before it is " +
      "trusted as correct, so explain your reasoning clearly rather than just asserting an answer.",
    user: JSON.stringify({
      originalTranscript: params.originalTranscript,
      flaggedSpans: params.flags,
      candidates: params.candidates.map((c) => ({ providerId: c.providerId, providerName: c.providerName, transcript: c.transcript })),
    }),
    schemaName: "candidate_pick",
    schema: {
      type: "object",
      properties: {
        pickedProviderId: { type: "string", enum: candidateIds },
        reasoning: { type: "string", description: "Why this candidate is most sensible, referencing the flagged spans specifically." },
      },
      required: ["pickedProviderId", "reasoning"],
      additionalProperties: false,
    },
  });

  const pickedProviderId = typeof result.pickedProviderId === "string" ? result.pickedProviderId : null;
  const reasoning = typeof result.reasoning === "string" ? result.reasoning : "";
  return {
    pickedProviderId: candidateIds.includes(pickedProviderId ?? "") ? pickedProviderId : null,
    reasoning,
  };
}

// 2026-08-26, per Abhishek: a raw errorMessage (an HTTP status, a vendor
// error string) isn't enough to act on when reviewing a run's failed
// cells. On-demand only (routes/results.ts's analyze-failure route) --
// this never runs automatically on every failure, same reasoning as the
// flag/judge pass above. Cheap model: this is a short classification task
// over a single error string, not the harder "which transcript reads best"
// judgment call.
export async function analyzeFailure(params: {
  providerName: string;
  errorMessage: string;
  httpStatus: number | null;
}): Promise<{ diagnosis: string; suggestedFix: string }> {
  const result = await callOpenAi({
    model: FLAG_MODEL,
    system:
      "You are helping an operator of a speech-to-text benchmarking tool understand why one " +
      "provider's transcription attempt failed for one call. Given the provider name, the HTTP " +
      "status (if any), and the raw error message, give a short plain-English diagnosis of the " +
      "likely cause, and a concrete, actionable suggested fix (e.g. \"rotate the API key\", " +
      "\"the audio file may be corrupt -- re-import this call\", \"this looks like a transient " +
      "rate limit -- retry the cell\"). Do not guess wildly beyond what the error text supports; " +
      "say so plainly if the cause is genuinely ambiguous from the error alone.",
    user: JSON.stringify({
      providerName: params.providerName,
      httpStatus: params.httpStatus,
      errorMessage: params.errorMessage,
    }),
    schemaName: "failure_analysis",
    schema: {
      type: "object",
      properties: {
        diagnosis: { type: "string", description: "One or two sentences: the likely cause." },
        suggestedFix: { type: "string", description: "One or two sentences: a concrete next step." },
      },
      required: ["diagnosis", "suggestedFix"],
      additionalProperties: false,
    },
  });

  return {
    diagnosis: typeof result.diagnosis === "string" ? result.diagnosis : "Could not determine a diagnosis.",
    suggestedFix: typeof result.suggestedFix === "string" ? result.suggestedFix : "No suggested fix available.",
  };
}
