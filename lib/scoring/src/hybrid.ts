// Hybrid, gold-free quality flagging (2026-08-27, per Abhishek: "we don't
// need a gold transcript any more ... make agent system better ... use a
// hybrid system"). Everything here is deliberately gold-independent -- it
// only ever compares candidate providers' own outputs against EACH OTHER
// (and, where available, each provider's own confidence numbers), never
// against a human-corrected reference. This is what now feeds both (a) the
// automatic per-run flag count that drives Rankings, and (b) the Agent
// page's on-demand deep-dive, so the two surfaces never drift into two
// different notions of "flagged."
//
// Deliberately NOT an LLM call -- this file is pure and free to run on every
// cell of every bundle run. The LLM layer (lib/agent.ts, api-server-side)
// stays a separate, on-demand, paid step that reads THIS module's output
// rather than replacing it -- "hybrid" means cheap deterministic signal
// first, expensive judgment only where the deterministic layer already
// found something worth explaining.

import { diffWords, normalizeTranscript } from "./index";

export type HybridSeverity = "none" | "low" | "medium" | "high";

export function severityRank(severity: HybridSeverity): number {
  return { none: 0, low: 1, medium: 2, high: 3 }[severity];
}

function maxSeverity(a: HybridSeverity, b: HybridSeverity): HybridSeverity {
  return severityRank(b) > severityRank(a) ? b : a;
}

// --- Signal 1: cross-provider disagreement -----------------------------
//
// No gold means no "correct" side to diff against -- so instead every
// candidate is diffed against every OTHER candidate (pairwise, reusing the
// same word-alignment WER already uses), and a provider's disagreement rate
// is how much of its output nobody else agreed with. A provider that's
// consistently the outlier across every pair is the one worth flagging;
// one that mostly matches its peers isn't, even though nothing here can say
// which SIDE was actually right without a human listening to the audio.

export type CrossProviderDisagreement = {
  providerId: string;
  mismatchWords: number;
  comparedWords: number;
  disagreementRate: number; // 0..1, higher = more of an outlier vs its peers
};

export function computeCrossProviderDisagreement(
  candidates: { providerId: string; transcript: string }[],
): CrossProviderDisagreement[] {
  const tokenized = candidates.map((c) => ({
    providerId: c.providerId,
    words: normalizeTranscript(c.transcript).split(" ").filter(Boolean),
  }));

  if (tokenized.length < 2) {
    return tokenized.map((t) => ({
      providerId: t.providerId,
      mismatchWords: 0,
      comparedWords: 0,
      disagreementRate: 0,
    }));
  }

  const tally = new Map<string, { mismatchWords: number; comparedWords: number }>();
  for (const t of tokenized) tally.set(t.providerId, { mismatchWords: 0, comparedWords: 0 });

  // Every unordered pair once. Direction of the alignment (which side is
  // "reference") shifts sub/del/ins classification slightly but not the
  // total non-"ok" count in any way that matters here -- both sides of a
  // pair are blamed equally for whatever doesn't match, since there's no
  // ground truth to say which one is wrong.
  for (let i = 0; i < tokenized.length; i += 1) {
    for (let j = i + 1; j < tokenized.length; j += 1) {
      const a = tokenized[i]!;
      const b = tokenized[j]!;
      const diff = diffWords(a.words, b.words);
      const mismatches = diff.filter((op) => op.op !== "ok").length;
      tally.get(a.providerId)!.mismatchWords += mismatches;
      tally.get(a.providerId)!.comparedWords += diff.length;
      tally.get(b.providerId)!.mismatchWords += mismatches;
      tally.get(b.providerId)!.comparedWords += diff.length;
    }
  }

  return tokenized.map((t) => {
    const stat = tally.get(t.providerId)!;
    return {
      providerId: t.providerId,
      mismatchWords: stat.mismatchWords,
      comparedWords: stat.comparedWords,
      disagreementRate: stat.comparedWords === 0 ? 0 : stat.mismatchWords / stat.comparedWords,
    };
  });
}

// --- Signal 2: provider-native confidence ------------------------------
//
// 3 of 7 providers (AssemblyAI, Deepgram, Gladia) already return per-word
// confidence and it was never extracted or used (docs/backlog/good-to-have.md,
// "Deferred: confidence scores"). Thresholds below are AssemblyAI's own
// documented suggestion (0.4-0.5 for a single word) plus this project's own
// judgment call on what a "run" of consecutive bad words means (a much
// stronger signal of a real audio problem than one unusual name) -- neither
// has been validated against a human-labeled set, flagged here as a
// starting point, not a settled calibration.

export type ConfidenceSpan = {
  words: string[];
  startIndex: number;
  avgConfidence: number;
  severity: HybridSeverity;
};

const SINGLE_WORD_CONFIDENCE_THRESHOLD = 0.5;
const RUN_CONFIDENCE_THRESHOLD = 0.6;
const MIN_RUN_LENGTH = 2;

export function flagLowConfidenceSpans(
  words: { word: string; confidence: number }[],
): ConfidenceSpan[] {
  const spans: ConfidenceSpan[] = [];
  let run: { word: string; confidence: number }[] = [];

  const flush = (startIndex: number) => {
    if (run.length === 0) return;
    const avgConfidence = run.reduce((sum, w) => sum + w.confidence, 0) / run.length;
    if (run.length >= MIN_RUN_LENGTH && avgConfidence < RUN_CONFIDENCE_THRESHOLD) {
      spans.push({ words: run.map((w) => w.word), startIndex, avgConfidence, severity: "high" });
    } else if (run.length === 1 && run[0]!.confidence < SINGLE_WORD_CONFIDENCE_THRESHOLD) {
      spans.push({ words: run.map((w) => w.word), startIndex, avgConfidence, severity: "low" });
    }
    run = [];
  };

  words.forEach((w, i) => {
    if (w.confidence < RUN_CONFIDENCE_THRESHOLD) {
      run.push(w);
    } else {
      flush(i - run.length);
    }
  });
  flush(words.length - run.length);

  return spans;
}

// --- Signal 3: domain-entity extraction & cross-check -------------------
//
// This is the actual entity-accuracy goal from the PRD (RO/unit/VIN/phone
// numbers), done gold-free: extract the same entity types from every
// candidate and flag when candidates disagree on the VALUE, not just the
// wording -- a wrong VIN or phone number is exactly the class of error raw
// word-diff treats the same as a filler-word swap. Regex-based, not NER --
// real false positives/negatives are expected and acceptable for a first
// pass (this is a flag for a human to check, not an automated verdict).

export type ExtractedEntityType = "phone_number" | "vin" | "reference_number";

export type ExtractedEntity = {
  type: ExtractedEntityType;
  value: string; // normalized (for comparison)
  raw: string; // as it appeared in the transcript
};

const PHONE_RE = /\b(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})\b/g;
// Real VIN spec: 17 chars, excludes I/O/Q (easily confused with 1/0). A
// length-17 alphanumeric run that's ALL letters or ALL digits is almost
// never an actual VIN mention -- just this pattern matching noise -- so
// require at least one of each before counting it as a candidate VIN.
const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/gi;
// A number right after one of the domain keywords the PRD's own entity list
// names (RO, unit, work order, load number) -- deliberately narrow rather
// than "any number," which would flag every duration and dollar amount too.
const REFERENCE_RE = /\b(?:ro|unit|work\s*order|load(?:\s*number)?|order)[\s#:-]*([a-z0-9-]{2,12})\b/gi;

export function extractEntities(transcript: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  for (const m of transcript.matchAll(PHONE_RE)) {
    entities.push({ type: "phone_number", value: m[1]!.replace(/[-.\s]/g, ""), raw: m[1]! });
  }
  for (const m of transcript.matchAll(VIN_RE)) {
    const value = m[1]!.toUpperCase();
    if (/[A-Z]/.test(value) && /\d/.test(value)) {
      entities.push({ type: "vin", value, raw: m[1]! });
    }
  }
  for (const m of transcript.matchAll(REFERENCE_RE)) {
    entities.push({ type: "reference_number", value: m[1]!.toUpperCase(), raw: m[0] });
  }
  return entities;
}

export type EntityMismatch = {
  type: ExtractedEntityType;
  valuesByProvider: Record<string, string[]>;
};

/** Only returns actual disagreements -- providers that agree, or that never
 * mentioned an entity of that type at all, produce nothing here. */
export function computeEntityMismatches(
  candidates: { providerId: string; transcript: string }[],
): EntityMismatch[] {
  const byType = new Map<ExtractedEntityType, Map<string, Set<string>>>();
  for (const c of candidates) {
    for (const entity of extractEntities(c.transcript)) {
      if (!byType.has(entity.type)) byType.set(entity.type, new Map());
      const perProvider = byType.get(entity.type)!;
      if (!perProvider.has(c.providerId)) perProvider.set(c.providerId, new Set());
      perProvider.get(c.providerId)!.add(entity.value);
    }
  }

  const mismatches: EntityMismatch[] = [];
  for (const [type, perProvider] of byType) {
    if (perProvider.size < 2) continue; // need 2+ providers to even compare
    const valuesByProvider: Record<string, string[]> = {};
    const signatures = new Set<string>();
    for (const [providerId, values] of perProvider) {
      const sorted = [...values].sort();
      valuesByProvider[providerId] = sorted;
      signatures.add(sorted.join("|"));
    }
    if (signatures.size > 1) mismatches.push({ type, valuesByProvider });
  }
  return mismatches;
}

// --- Combine into one per-provider result --------------------------------

export type HybridFlagResult = {
  flagCount: number;
  flagSeverity: HybridSeverity;
  crossProviderDisagreement: CrossProviderDisagreement | null;
  lowConfidenceSpans: ConfidenceSpan[];
  entityMismatches: EntityMismatch[];
};

// >15% of a provider's words disagreeing with its peers is a real signal,
// not normalization/formatting noise (contractions, filler words already
// get folded out by normalizeTranscript before this ever runs).
const DISAGREEMENT_FLAG_THRESHOLD = 0.15;
const DISAGREEMENT_HIGH_THRESHOLD = 0.35;

export function combineHybridFlags(params: {
  disagreement: CrossProviderDisagreement | null;
  confidenceSpans: ConfidenceSpan[];
  entityMismatches: EntityMismatch[]; // pre-filtered to ones this provider participated in
}): HybridFlagResult {
  let flagCount = 0;
  let flagSeverity: HybridSeverity = "none";

  if (params.disagreement && params.disagreement.disagreementRate > DISAGREEMENT_FLAG_THRESHOLD) {
    flagCount += 1;
    flagSeverity = maxSeverity(
      flagSeverity,
      params.disagreement.disagreementRate > DISAGREEMENT_HIGH_THRESHOLD ? "high" : "medium",
    );
  }

  flagCount += params.confidenceSpans.length;
  for (const span of params.confidenceSpans) flagSeverity = maxSeverity(flagSeverity, span.severity);

  flagCount += params.entityMismatches.length;
  // A wrong VIN/phone/RO number is always high-stakes for this tool's
  // actual purpose (PRD G2) regardless of how small it looks as "one word."
  if (params.entityMismatches.length > 0) flagSeverity = maxSeverity(flagSeverity, "high");

  return {
    flagCount,
    flagSeverity,
    crossProviderDisagreement: params.disagreement,
    lowConfidenceSpans: params.confidenceSpans,
    entityMismatches: params.entityMismatches,
  };
}

// --- Ranking composite (replaces the gold-based one in index.ts) --------
//
// FR-S8's composite used to weight entity/alphanumeric accuracy heaviest,
// with WER/latency/cost as secondary. Without a gold transcript there's no
// accuracy metric left at all -- flags (how much a provider disagreed with
// its peers, how often its own confidence was low, how often its entities
// didn't match) become the primary signal instead, with latency/cost as the
// same secondary tie-breakers they always were. Same shape/weighting style
// as RANKING_WEIGHTS in index.ts, deliberately not merged with it -- that
// one is kept only for historical runs scored before this change.
export const HYBRID_RANKING_WEIGHTS = {
  flags: 0.70,
  latency: 0.15,
  cost: 0.15,
} as const;

export type HybridCompositeInput = {
  // avgFlagCount + avgFlagSeverityScore (severityRank 0..3), averaged across
  // a provider's cells -- one blended "how much went wrong" number rather
  // than two separately-weighted ones, so a provider with a few high-
  // severity flags and one with many low-severity flags can still be
  // compared on the same scale.
  flagBadness: number | null;
  latencyFinalMs: number | null;
  costPerMinute: number | null;
  maxFlagBadness: number;
  maxLatencyFinalMs: number;
  maxCostPerMinute: number;
};

/** Returns null when there's no evidence at all (every cell failed) --
 * callers should surface that as "insufficient evidence," same convention
 * as the old compositeScore(). */
export function hybridCompositeScore(input: HybridCompositeInput): number | null {
  if (input.flagBadness === null) return null;

  const flagComponent =
    input.maxFlagBadness <= 0 ? 1 : 1 - Math.min(input.flagBadness / input.maxFlagBadness, 1);
  const latencyComponent =
    input.latencyFinalMs === null || input.maxLatencyFinalMs <= 0
      ? 1
      : 1 - Math.min(input.latencyFinalMs / input.maxLatencyFinalMs, 1);
  const costComponent =
    input.costPerMinute === null || input.maxCostPerMinute <= 0
      ? 1
      : 1 - Math.min(input.costPerMinute / input.maxCostPerMinute, 1);

  return (
    HYBRID_RANKING_WEIGHTS.flags * flagComponent +
    HYBRID_RANKING_WEIGHTS.latency * latencyComponent +
    HYBRID_RANKING_WEIGHTS.cost * costComponent
  );
}
