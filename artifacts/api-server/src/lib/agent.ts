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

// 2026-08-27, per Abhishek ("show the openai agent cost ... separately,
// estimated"): public per-1M-token pricing as of this writing, cents per
// 1,000 tokens. Same placeholder-and-flag-it convention as provider
// costPerMinute elsewhere in this codebase -- verify against OpenAI's
// current pricing page before trusting this for a real budget decision.
const MODEL_COST_CENTS_PER_1K_TOKENS: Record<string, { prompt: number; completion: number }> = {
  "gpt-4o-mini": { prompt: 0.0015, completion: 0.006 },
  "gpt-4o": { prompt: 0.25, completion: 1.0 },
};

function costCentsFor(model: string, promptTokens: number, completionTokens: number): number | null {
  const rates = MODEL_COST_CENTS_PER_1K_TOKENS[model];
  if (!rates) return null; // unknown/custom model override -- don't guess a cost
  return (promptTokens / 1000) * rates.prompt + (completionTokens / 1000) * rates.completion;
}

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

type OpenAiUsage = { promptTokens: number; completionTokens: number; costCents: number | null };

async function callOpenAi(params: {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
}): Promise<{ data: Record<string, unknown>; usage: OpenAiUsage }> {
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
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  if (!res.ok) {
    throw new AgentRequestError(res.status, body.error?.message ?? `OpenAI returned HTTP ${res.status}`);
  }

  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new AgentRequestError(res.status, "OpenAI response had no content");

  const promptTokens = body.usage?.prompt_tokens ?? 0;
  const completionTokens = body.usage?.completion_tokens ?? 0;
  return {
    data: JSON.parse(content) as Record<string, unknown>,
    usage: {
      promptTokens,
      completionTokens,
      costCents: costCentsFor(params.model, promptTokens, completionTokens),
    },
  };
}

// 2026-08-27: the blind "read one transcript, guess what sounds wrong" flag
// pass (flagTranscript) is retired -- it needed a single anchor transcript
// (gold or draft) to read, which no longer fits the gold-free hybrid model
// (lib/scoring/src/hybrid.ts compares candidates to each other instead).
// judgeCandidates below is unchanged in shape but is now always called with
// hybrid-derived flags instead of an LLM's own blind guess at what's wrong.
export async function judgeCandidates(params: {
  originalTranscript: string;
  flags: BenchmarkAgentFlag[];
  candidates: { providerId: string; providerName: string; transcript: string }[];
  // 2026-08-26: caller-supplied override, read from app_settings.agentModel
  // by routes/agent.ts (this file stays DB-free, per the file header's
  // "ONLY the two OpenAI calls" separation). Falls back to JUDGE_MODEL when
  // omitted, empty, or the caller passed a settings row with no override set.
  model?: string | null;
}): Promise<{
  pickedProviderId: string | null;
  reasoning: string;
  promptTokens: number | null;
  completionTokens: number | null;
  costCents: number | null;
}> {
  if (params.candidates.length === 0) {
    return {
      pickedProviderId: null,
      reasoning: "No candidate transcripts were available to compare (every re-run provider failed).",
      promptTokens: null,
      completionTokens: null,
      costCents: null,
    };
  }

  const candidateIds = params.candidates.map((c) => c.providerId);
  const { data: result, usage } = await callOpenAi({
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
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    costCents: usage.costCents,
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
// 2026-08-27 (technical-fixes FIX-5): two known, deterministic failure causes
// currently account for over half of all live failures (Vapi's 14-day
// retention window, and the Supabase archive-bucket 403 -- see
// docs/backlog/good-to-have.md and docs/PRD-technical-fixes.md). Neither
// needs an LLM call to diagnose; the error text itself already says exactly
// what's wrong, every time. Matched before analyzeFailure ever runs, so a
// known cause is free and instant instead of a paid, repeated OpenAI call
// re-discovering the same fact on every cell that hits it.
export function matchKnownFailure(
  errorMessage: string,
): { diagnosis: string; suggestedFix: string } | null {
  if (errorMessage.includes("retention window")) {
    return {
      diagnosis:
        "This call's recording is older than Vapi's plan retains (14 days), so Vapi can no longer " +
        "issue a fresh download link for it -- this is permanent, not a transient failure, and every " +
        "provider hits it identically for this call.",
      suggestedFix:
        "Not retryable. Either upgrade the Vapi plan's retention window before this happens again, or " +
        "accept this call as permanently excluded from future runs. If it was ever transcribed " +
        "successfully before, that cached audio is reusable -- newly-imported calls won't be if left " +
        "unrun past day 14.",
    };
  }
  if (errorMessage.includes("storage.supabase.co") || errorMessage.includes("archive/")) {
    return {
      diagnosis:
        "This call's recording lives in the older Supabase \"archive\" storage bucket, and the link " +
        "Vapi hands back for it was never actually signed -- every provider gets an HTTP 403 straight " +
        "from Supabase. Confirmed as a bucket-level split, not a per-call or per-provider flake.",
      suggestedFix:
        "Not fixable from this app. Needs either Vapi support to fix the signing for this bucket, or " +
        "direct read access to the Supabase archive bucket as a workaround.",
    };
  }
  return null;
}

export async function analyzeFailure(params: {
  providerName: string;
  errorMessage: string;
  httpStatus: number | null;
}): Promise<{ diagnosis: string; suggestedFix: string }> {
  const known = matchKnownFailure(params.errorMessage);
  if (known) return known;

  const { data: result } = await callOpenAi({
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
