// Scoring version. Bump this whenever normalization or metric behavior
// changes -- every stored Score row references the version that produced
// it, so a re-score run can tell whether it reproduced the original
// (NFR-6, FR-S7, FR-REP3).
export const SCORING_VERSION = "v1";

export type EntityType =
  | "ro_number"
  | "unit_number"
  | "vin"
  | "phone_number"
  | "name"
  | "address"
  | "load_number"
  | "city";

export type EntityReference = {
  type: EntityType;
  value: string;
};

export type ScoreInput = {
  callId: string;
  vertical: "rush" | "property_management" | "trucking";
  providerId: string;
  goldTranscript: string;
  hypothesisTranscript: string;
  entities: EntityReference[];
  latencyFirstPartialMs?: number | null;
  latencyFinalMs?: number | null;
  costPerMinute?: number | null;
  diarizationScore?: number | null;
};

export type EditCounts = {
  substitutions: number;
  deletions: number;
  insertions: number;
  referenceWords: number;
};

// One aligned word pair from the edit-distance backtrack. "ok"/"sub" always
// carry both ref and hyp (equal for "ok"); "del" is a gold word the provider
// missed entirely (hyp null); "ins" is a word the provider added that isn't
// in gold (ref null). This is the same alignment WER has always computed
// internally -- previously the backtrack only counted operations and threw
// the actual word pairs away. Surfacing it lets a reviewer see exactly which
// words a provider got wrong, not just how many.
export type WordDiffOp = {
  op: "ok" | "sub" | "del" | "ins";
  ref: string | null;
  hyp: string | null;
};

export type EntityScoreResult = EntityReference & {
  normalized: string;
  exactMatch: boolean;
};

export type ScoreOutput = {
  callId: string;
  vertical: ScoreInput["vertical"];
  providerId: string;
  normalizationVersion: string;
  scoringVersion: string;
  wer: number | null;
  edits: EditCounts;
  entityAccuracy: number | null;
  alphanumericAccuracy: number | null;
  entityResults: EntityScoreResult[];
  wordDiff: WordDiffOp[];
  latencyFirstPartialMs: number | null;
  latencyFinalMs: number | null;
  costPerMinute: number | null;
  diarizationScore: number | null;
};

const punctuation = /[^\p{L}\p{N}\s'-]/gu;
const entitySeparators = /[\s\-().,/\\]+/g;
// B-88 (verified wave-2): NFKC does not fold typographic quotes/dashes to
// ASCII, so identical speech transcribed with ’ vs ' split words — one word
// became sub+ins, inflating WER up to 2x on affected transcripts. Fold
// before punctuation stripping.
const quoteFold = /[\u2018\u2019\u201B\u02BC]/gu;
const dashFold = /[\u2013\u2014\u2015\u2212]/gu;

export function normalizeTranscript(value: string): string {
  return value
    .normalize("NFKC")
    .replace(quoteFold, "'")
    .replace(dashFold, "-")
    .toLocaleLowerCase("en-US")
    .replace(punctuation, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeEntity(value: string): string {
  return value
    .normalize("NFKC")
    .replace(quoteFold, "'")
    .replace(dashFold, "-")
    .toLocaleUpperCase("en-US")
    .replace(entitySeparators, "")
    .replace(/[^A-Z0-9]/g, "");
}

function alignWords(
  reference: string[],
  hypothesis: string[],
): { counts: EditCounts; ops: WordDiffOp[] } {
  const rows = reference.length + 1;
  const cols = hypothesis.length + 1;
  const distance = Array.from({ length: rows }, () =>
    Array<number>(cols).fill(0),
  );
  const operation = Array.from({ length: rows }, () =>
    Array<"ok" | "sub" | "del" | "ins">(cols).fill("ok"),
  );

  for (let row = 1; row < rows; row += 1) {
    distance[row][0] = row;
    operation[row][0] = "del";
  }
  for (let col = 1; col < cols; col += 1) {
    distance[0][col] = col;
    operation[0][col] = "ins";
  }

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      if (reference[row - 1] === hypothesis[col - 1]) {
        distance[row][col] = distance[row - 1][col - 1];
        operation[row][col] = "ok";
        continue;
      }

      const candidates = [
        { cost: distance[row - 1][col - 1] + 1, op: "sub" as const, priority: 0 },
        { cost: distance[row - 1][col] + 1, op: "del" as const, priority: 1 },
        { cost: distance[row][col - 1] + 1, op: "ins" as const, priority: 2 },
      ].sort((left, right) =>
        left.cost === right.cost
          ? left.priority - right.priority
          : left.cost - right.cost,
      );
      distance[row][col] = candidates[0].cost;
      operation[row][col] = candidates[0].op;
    }
  }

  let row = reference.length;
  let col = hypothesis.length;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  const opsReversed: WordDiffOp[] = [];

  while (row > 0 || col > 0) {
    const op = operation[row][col];
    if (op === "ok" || op === "sub") {
      substitutions += op === "sub" ? 1 : 0;
      opsReversed.push({ op, ref: reference[row - 1], hyp: hypothesis[col - 1] });
      row -= 1;
      col -= 1;
    } else if (op === "del") {
      deletions += 1;
      opsReversed.push({ op, ref: reference[row - 1], hyp: null });
      row -= 1;
    } else {
      insertions += 1;
      opsReversed.push({ op, ref: null, hyp: hypothesis[col - 1] });
      col -= 1;
    }
  }

  return {
    counts: { substitutions, deletions, insertions, referenceWords: reference.length },
    ops: opsReversed.reverse(),
  };
}

export function editCounts(reference: string[], hypothesis: string[]): EditCounts {
  return alignWords(reference, hypothesis).counts;
}

/** The word-by-word diff between gold and a provider's transcript --
 * exposes exactly which words were substituted, dropped, or added, in
 * order. Used by the Review/Results UI to highlight specific mismatches
 * instead of only showing an aggregate WER number. */
export function diffWords(reference: string[], hypothesis: string[]): WordDiffOp[] {
  return alignWords(reference, hypothesis).ops;
}

export function scoreEntities(entities: EntityReference[], hypothesis: string) {
  const normalizedHypothesis = normalizeEntity(hypothesis);
  const results: EntityScoreResult[] = entities.map((entity) => {
    const normalized = normalizeEntity(entity.value);
    return {
      ...entity,
      normalized,
      exactMatch: normalized.length > 0 && normalizedHypothesis.includes(normalized),
    };
  });
  const correct = results.filter((entity) => entity.exactMatch).length;
  const alphanumeric = results.filter(
    (entity) => /[A-Z]/.test(entity.normalized) && /\d/.test(entity.normalized),
  );
  const alphanumericCorrect = alphanumeric.filter((entity) => entity.exactMatch).length;

  return {
    results,
    accuracy: results.length === 0 ? null : correct / results.length,
    alphanumericAccuracy:
      alphanumeric.length === 0 ? null : alphanumericCorrect / alphanumeric.length,
  };
}

export function score(input: ScoreInput): ScoreOutput {
  const gold = normalizeTranscript(input.goldTranscript).split(" ").filter(Boolean);
  const hypothesis = normalizeTranscript(input.hypothesisTranscript)
    .split(" ")
    .filter(Boolean);
  const aligned = alignWords(gold, hypothesis);
  const edits = aligned.counts;
  const entity = scoreEntities(input.entities, input.hypothesisTranscript);
  const errors = edits.substitutions + edits.deletions + edits.insertions;

  return {
    callId: input.callId,
    vertical: input.vertical,
    providerId: input.providerId,
    normalizationVersion: "v1",
    scoringVersion: SCORING_VERSION,
    wer: edits.referenceWords === 0 ? null : errors / edits.referenceWords,
    edits,
    entityAccuracy: entity.accuracy,
    alphanumericAccuracy: entity.alphanumericAccuracy,
    entityResults: entity.results,
    wordDiff: aligned.ops,
    latencyFirstPartialMs: input.latencyFirstPartialMs ?? null,
    latencyFinalMs: input.latencyFinalMs ?? null,
    costPerMinute: input.costPerMinute ?? null,
    diarizationScore: input.diarizationScore ?? null,
  };
}

// Composite ranking score (FR-S8). Weights are an open decision (PRD OD-1) --
// this default weighting follows the plan's stated logic (docs/logic-register.md,
// docs/task-graph.mmd RANK-01): entity/alphanumeric accuracy outweighs raw WER
// because a wrong VIN or RO number breaks downstream automation even when WER
// looks fine; cost and latency are tie-breakers, not primary drivers.
// Every raw metric is still published alongside this number so the weights
// never hide a tradeoff (RANK-01 logic note).
export const RANKING_WEIGHTS = {
  entityAccuracy: 0.40,
  alphanumericAccuracy: 0.25,
  wer: 0.20,
  latency: 0.10,
  cost: 0.05,
} as const;

export type CompositeInput = {
  wer: number | null;
  entityAccuracy: number | null;
  alphanumericAccuracy: number | null;
  latencyFinalMs: number | null;
  costPerMinute: number | null;
  maxLatencyFinalMs: number;
  maxCostPerMinute: number;
};

// Returns null when there isn't enough evidence (missing entity or WER data)
// to compute a defensible composite -- callers should surface that as
// "insufficient evidence" rather than silently ranking on partial data.
export function compositeScore(input: CompositeInput): number | null {
  if (input.wer === null || input.entityAccuracy === null) return null;

  const werComponent = 1 - Math.min(input.wer, 1);
  const entityComponent = input.entityAccuracy;
  const alphanumericComponent = input.alphanumericAccuracy ?? input.entityAccuracy;
  const latencyComponent =
    input.latencyFinalMs === null || input.maxLatencyFinalMs <= 0
      ? 1
      : 1 - Math.min(input.latencyFinalMs / input.maxLatencyFinalMs, 1);
  const costComponent =
    input.costPerMinute === null || input.maxCostPerMinute <= 0
      ? 1
      : 1 - Math.min(input.costPerMinute / input.maxCostPerMinute, 1);

  return (
    RANKING_WEIGHTS.entityAccuracy * entityComponent +
    RANKING_WEIGHTS.alphanumericAccuracy * alphanumericComponent +
    RANKING_WEIGHTS.wer * werComponent +
    RANKING_WEIGHTS.latency * latencyComponent +
    RANKING_WEIGHTS.cost * costComponent
  );
}
