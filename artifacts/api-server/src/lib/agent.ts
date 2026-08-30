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
import type { FailureClass } from "@workspace/stt-providers";
import { BamlClientFinishReasonError, BamlClientHttpError, BamlValidationError, ClientRegistry, Collector, setLogLevel } from "@boundaryml/baml";
import { b } from "../baml_client";
import TypeBuilder from "../baml_client/type_builder";
import type { JudgeVerdict } from "../baml_client/types";

// T-25: BAML ships its own stdout logger that prints every prompt and parsed
// answer at "info". pino is this server's one logger; keep BAML quiet unless
// an operator opts in with BAML_LOG=info/debug for a debugging session.
if (!process.env.BAML_LOG) setLogLevel("warn");

const API_KEY_ENV_VAR = "OPENAI_API_KEY";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
// Cheap model for the flag pass (runs on every scan, mostly finds nothing);
// a stronger model only for judging candidates (runs only when flags were
// found, and picking the "most sensible" transcript is the harder call).
// Both are easy to change in one place if the quality/cost tradeoff is wrong.
const FLAG_MODEL = "gpt-4o-mini";
export const JUDGE_MODEL = "gpt-4o";

// 2026-08-27, per Abhishek ("show the openai agent cost ... separately,
// estimated"): public per-1M-token pricing as of this writing, cents per
// 1,000 tokens. Same placeholder-and-flag-it convention as provider
// costPerMinute elsewhere in this codebase -- verify against OpenAI's
// current pricing page before trusting this for a real budget decision.
// T-01 (2026-08-28): denominated in MICRO-CENTS per 1,000 tokens (1 cent =
// 10,000 microcents), because the cents version of this table produced
// fractional values that an integer DB column rejected -- silently
// destroying every judgement the system made. See
// lib/db/src/schema/benchmark-agent-scans.ts for the full post-mortem.
// T-103 (2026-08-30): rates below verified on developers.openai.com/api/docs/pricing
// (standard tier, per 1M tokens): 4.1 $2/$8, 4.1-mini $0.40/$1.60, 5.2
// $1.75/$14, 5.5 $5/$30, 5.6-sol $4/$20, 4o $2.50/$10, 4o-mini $0.15/$0.60.
// $1 per 1M tokens = 1,000 microcents per 1K tokens.
const MODEL_COST_MICROCENTS_PER_1K_TOKENS: Record<string, { prompt: number; completion: number }> = {
  "gpt-4o-mini": { prompt: 150, completion: 600 },
  "gpt-4o": { prompt: 2_500, completion: 10_000 },
  "gpt-4.1": { prompt: 2_000, completion: 8_000 },
  "gpt-4.1-mini": { prompt: 400, completion: 1_600 },
  "gpt-5.2": { prompt: 1_750, completion: 14_000 },
  "gpt-5.5": { prompt: 5_000, completion: 30_000 },
  "gpt-5.6-sol": { prompt: 4_000, completion: 20_000 },
};

/** Models this file can price. Anything else records a null cost. */
export function pricedAgentModels(): string[] {
  return Object.keys(MODEL_COST_MICROCENTS_PER_1K_TOKENS);
}

/** Integer micro-cents, or null for a model we have no published rate for --
 * null means "not recorded", and must never be rendered as a confident 0. */
function costMicrocentsFor(model: string, promptTokens: number, completionTokens: number): number | null {
  const rates = MODEL_COST_MICROCENTS_PER_1K_TOKENS[model];
  if (!rates) return null; // unknown/custom model override -- don't guess a cost
  return Math.round((promptTokens / 1000) * rates.prompt + (completionTokens / 1000) * rates.completion);
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

type OpenAiUsage = { promptTokens: number; completionTokens: number; costMicrocents: number | null };

async function callOpenAi(params: {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
}): Promise<{ data: Record<string, unknown>; usage: OpenAiUsage }> {
  const apiKey = process.env[API_KEY_ENV_VAR];
  if (!apiKey) throw new AgentConfigError();

  // T-54: same shape as the provider path (run-executor.ts): 429 and 5xx
  // are retried with exponential back-off + jitter, up to 3 extra tries;
  // everything else fails fast. Bounded, so a hard outage still surfaces.
  let attempt = 0;
  for (;;) {
    try {
      return await fetchOpenAi(apiKey, params);
    } catch (err) {
      const status = err instanceof AgentRequestError ? err.httpStatus : null;
      const retryable = status === 429 || (status !== null && status >= 500);
      if (!retryable || attempt >= OPENAI_MAX_RETRIES) throw err;
      const delay = Math.min(8_000, 500 * 2 ** attempt) * (0.5 + Math.random());
      attempt += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

const OPENAI_MAX_RETRIES = 3;

async function fetchOpenAi(
  apiKey: string,
  params: Parameters<typeof callOpenAi>[0],
): Promise<{ data: Record<string, unknown>; usage: OpenAiUsage }> {
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
      costMicrocents: costMicrocentsFor(params.model, promptTokens, completionTokens),
    },
  };
}

// 2026-08-27: the blind "read one transcript, guess what sounds wrong" flag
// pass (flagTranscript) is retired -- it needed a single anchor transcript
// (gold or draft) to read, which no longer fits the gold-free hybrid model
// (lib/scoring/src/hybrid.ts compares candidates to each other instead).
// judgeCandidates below is unchanged in shape but is now always called with
// hybrid-derived flags instead of an LLM's own blind guess at what's wrong.
//
// T-25 (2026-08-29): the judge now runs through BAML (baml_src/judge.baml ->
// generated src/baml_client). Same signature, same return shape, same
// callers (lib/agent-verify.ts) -- only what is
// underneath changed:
//
//   * The pick is a TYPE. `PickedProvider` is a `@@dynamic` enum whose only
//     values are the candidate provider IDs of THIS call (added at runtime
//     through the TypeBuilder below), so the parser can only return one of
//     them. The old strict-JSON-schema enum silently came back empty on
//     10/10 historical scans and a regex over the reasoning prose had to
//     rescue the pick (`inferPickFromReasoning`, now deleted). An
//     unparseable answer is now a thrown BamlValidationError -> a
//     `judge_failed` scan row, never a guess.
//   * The prompt lives in a versioned, diffable .baml file instead of a TS
//     template literal.
//   * Cost capture is still ours: BAML's Collector reports token usage, the
//     MODEL_COST_MICROCENTS_PER_1K_TOKENS table above prices it.
//
// analyzeFailure (below) deliberately stays on the raw fetch path -- the
// PRD's rule is "judge only, behind the existing signature; migrate nothing
// else until a full bulk has been judged through BAML".
export async function judgeCandidates(params: {
  originalTranscript: string;
  flags: BenchmarkAgentFlag[];
  candidates: { providerId: string; providerName: string; transcript: string }[];
  // 2026-08-26: caller-supplied override, read from app_settings.agentModel
  // by the callers (this file stays DB-free, per the file header's
  // separation). Falls back to JUDGE_MODEL when omitted, empty, or the
  // caller passed a settings row with no override set.
  model?: string | null;
}): Promise<{
  pickedProviderId: string | null;
  reasoning: string;
  promptTokens: number | null;
  completionTokens: number | null;
  costMicrocents: number | null;
}> {
  if (params.candidates.length === 0) {
    return {
      pickedProviderId: null,
      reasoning: "No candidate transcripts were available to compare (every re-run provider failed).",
      promptTokens: null,
      completionTokens: null,
      costMicrocents: null,
    };
  }

  const apiKey = process.env[API_KEY_ENV_VAR];
  if (!apiKey) throw new AgentConfigError();
  const model = params.model?.trim() || JUDGE_MODEL;

  // The enum's values are exactly this call's candidate IDs, nothing else.
  const tb = new TypeBuilder();
  for (const c of params.candidates) {
    tb.PickedProvider.addValue(c.providerId).description(c.providerName);
  }

  // One client per call, so the model override from app_settings applies
  // without a shared mutable registry. The key is read here, at call time,
  // from the environment only.
  const clientRegistry = new ClientRegistry();
  // T-54: 429/5xx back off inside BAML (baml_src/retry.baml) before this
  // ever becomes a judge_failed scan row.
  clientRegistry.addLlmClient("Judge", "openai", { model, api_key: apiKey }, "JudgeRetry");
  clientRegistry.setPrimary("Judge");

  const collector = new Collector("judge");

  let verdict: JudgeVerdict;
  try {
    verdict = await b.withOptions({ tb, clientRegistry, collector }).JudgeCandidates(
      params.originalTranscript,
      params.flags.map((f) => ({ text: f.text, reason: f.reason })),
      params.candidates.map((c) => ({ providerId: c.providerId, providerName: c.providerName, transcript: c.transcript })),
    );
  } catch (err) {
    throw toAgentRequestError(err);
  }

  const usage = collector.last?.usage;
  const promptTokens = usage?.inputTokens ?? null;
  const completionTokens = usage?.outputTokens ?? null;
  const rawPick = String(verdict.pickedProviderId);
  return {
    // Belt and braces: the dynamic enum already guarantees membership, but
    // this function's contract is "null or a real candidate ID", and that
    // contract is enforced here, not trusted to a library.
    pickedProviderId: params.candidates.some((c) => c.providerId === rawPick) ? rawPick : null,
    reasoning: typeof verdict.reasoning === "string" ? verdict.reasoning : "",
    promptTokens,
    completionTokens,
    costMicrocents:
      promptTokens === null || completionTokens === null ? null : costMicrocentsFor(model, promptTokens, completionTokens),
  };
}

/** Maps BAML's error classes onto this file's existing AgentRequestError so
 * callers' `judge_failed` handling (agent-verify.ts) is
 * unchanged. Status codes: the provider's own for HTTP failures; 502 for
 * "the model answered but not with a valid pick" -- that is an upstream
 * answer we refuse, not a client mistake. */
function toAgentRequestError(err: unknown): Error {
  if (err instanceof BamlClientHttpError) {
    return new AgentRequestError(err.status_code, `OpenAI returned HTTP ${err.status_code}: ${err.message}`);
  }
  if (err instanceof BamlValidationError) {
    return new AgentRequestError(502, `judge output did not parse to a valid pick: ${err.message}`);
  }
  if (err instanceof BamlClientFinishReasonError) {
    return new AgentRequestError(502, `judge stopped early (finish_reason=${err.finish_reason ?? "unknown"}): ${err.message}`);
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
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
// needs an LLM call to diagnose. Matched before analyzeFailure ever runs, so
// a known cause is free and instant instead of a paid, repeated OpenAI call
// re-discovering the same fact on every cell that hits it.
//
// T-41: keyed on the stored `failureClass`, not on the error sentence. The
// class was decided at the throw site by the code holding the real HTTP
// status (T-06); reading the sentence again here to reach the same
// conclusion was a second, independent cause of record that a vendor
// rewording its error text would silently split from the first. Now there
// is one: the class says what happened, this table says what that means.
const KNOWN_FAILURE_BY_CLASS: Partial<
  Record<FailureClass, { diagnosis: string; suggestedFix: string }>
> = {
  retention_expired: {
    diagnosis:
      "This call's recording is older than Vapi's plan retains (14 days), so Vapi can no longer " +
      "issue a fresh download link for it -- this is permanent, not a transient failure, and every " +
      "provider hits it identically for this call.",
    suggestedFix:
      "Not retryable. Either upgrade the Vapi plan's retention window before this happens again, or " +
      "accept this call as permanently excluded from future runs. If it was ever transcribed " +
      "successfully before, that cached audio is reusable -- newly-imported calls won't be if left " +
      "unrun past day 14.",
  },
  audio_url_forbidden: {
    diagnosis:
      "This call's recording lives in the older Supabase \"archive\" storage bucket, and the link " +
      "Vapi hands back for it was never actually signed -- every provider gets an HTTP 403 straight " +
      "from Supabase. Confirmed as a bucket-level split, not a per-call or per-provider flake.",
    suggestedFix:
      "Not fixable from this app. Needs either Vapi support to fix the signing for this bucket, or " +
      "direct read access to the Supabase archive bucket as a workaround.",
  },
};

/**
 * The human-readable diagnosis + fix for a failure whose cause is already
 * known deterministically, or null when it is not (and an LLM analysis is
 * the next step). Driven by `failureClass` only. Error text is never read
 * here: T-40's backfill (run 2026-08-30, T-69) classified every legacy row
 * whose text named a cause; the 25 it left null say nothing a pattern could
 * use ("Gladia submit returned HTTP 400", "Deepgram returned HTTP 400").
 */
export function matchKnownFailure(cell: {
  failureClass: FailureClass | null;
  errorMessage: string | null;
}): { diagnosis: string; suggestedFix: string } | null {
  if (cell.failureClass === null) return null;
  return KNOWN_FAILURE_BY_CLASS[cell.failureClass] ?? null;
}

export async function analyzeFailure(params: {
  providerName: string;
  errorMessage: string;
  httpStatus: number | null;
  failureClass: FailureClass | null;
}): Promise<{ diagnosis: string; suggestedFix: string }> {
  const known = matchKnownFailure(params);
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
