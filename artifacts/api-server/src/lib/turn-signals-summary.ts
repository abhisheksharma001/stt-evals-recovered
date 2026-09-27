// W-7: the pooled half of Layer 2's strip, kept free of the database so its
// rules can be held in a unit test (the sibling pattern of
// call-disagreement-aggregate.ts). A latency pools over every timed turn of
// every call that had one, and carries the two denominators the number must
// be read against; a null count is "not asked", a 0 is an answer.
import type { TurnLatency } from "./production-signals";

export type TurnSignalsCall = {
  callId: string;
  turns: TurnLatency[] | null;
  assistantInterruptions: number | null;
  toolCalls: number | null;
  endedReason: string | null;
  successEvaluation: string | null;
};

export type LatencyPool = { medianMs: number | null; turns: number; measuredCalls: number };
export type ValueCount = { value: string; calls: number };

export type TurnSignalsSummary = {
  totalCalls: number;
  stt: { transcriberLatency: LatencyPool };
  turnTaking: {
    endpointingLatency: LatencyPool;
    interruptedCalls: number;
    interruptions: number;
    interruptionsMeasuredCalls: number;
  };
  llm: { modelLatency: LatencyPool };
  voice: { voiceLatency: LatencyPool };
  outcome: {
    endedReasons: ValueCount[];
    endedReasonKnownCalls: number;
    successEvaluations: ValueCount[];
    successEvaluationKnownCalls: number;
  };
};

export type BulkTurnSignals = {
  bulkId: string;
  assistantId: string | null;
  calls: TurnSignalsCall[];
  summary: TurnSignalsSummary;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One latency pooled over every timed turn of every call that had one. */
function pool(calls: TurnSignalsCall[], pick: (t: TurnLatency) => number | null): LatencyPool {
  const values: number[] = [];
  let measuredCalls = 0;
  for (const call of calls) {
    const timed = (call.turns ?? []).map(pick).filter((v): v is number => v !== null);
    if (timed.length === 0) continue;
    measuredCalls += 1;
    values.push(...timed);
  }
  return { medianMs: median(values), turns: values.length, measuredCalls };
}

/** Distinct values with how many calls carried each; most calls first. */
function tally(values: (string | null)[]): ValueCount[] {
  const counts = new Map<string, number>();
  for (const v of values) if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts]
    .map(([value, calls]) => ({ value, calls }))
    .sort((a, b) => b.calls - a.calls || a.value.localeCompare(b.value));
}

export function summarizeTurnSignals(calls: TurnSignalsCall[]): TurnSignalsSummary {
  const interruptions = calls.map((c) => c.assistantInterruptions).filter((v): v is number => v !== null);
  return {
    totalCalls: calls.length,
    stt: { transcriberLatency: pool(calls, (t) => t.transcriberMs) },
    turnTaking: {
      endpointingLatency: pool(calls, (t) => t.endpointingMs),
      interruptedCalls: interruptions.filter((n) => n > 0).length,
      interruptions: interruptions.reduce((a, b) => a + b, 0),
      interruptionsMeasuredCalls: interruptions.length,
    },
    llm: { modelLatency: pool(calls, (t) => t.modelMs) },
    voice: { voiceLatency: pool(calls, (t) => t.voiceMs) },
    outcome: {
      endedReasons: tally(calls.map((c) => c.endedReason)),
      endedReasonKnownCalls: calls.filter((c) => c.endedReason !== null).length,
      successEvaluations: tally(calls.map((c) => c.successEvaluation)),
      successEvaluationKnownCalls: calls.filter((c) => c.successEvaluation !== null).length,
    },
  };
}

