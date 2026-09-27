import { describe, expect, it } from "vitest";

import { summarizeTurnSignals, type TurnSignalsCall } from "./turn-signals-summary";

// W-7: the pooled strip. What is held is the acceptance line -- "timed on 7
// of 10" is two denominators, and the three untimed calls contribute nothing,
// not three zeros -- and that a reported 0 interruptions is a measurement
// while a null is not.
function call(over: Partial<TurnSignalsCall>): TurnSignalsCall {
  return { callId: "c", turns: null, assistantInterruptions: null, toolCalls: null, endedReason: null, successEvaluation: null, ...over };
}
const turn = (modelMs: number | null, voiceMs: number | null = null) => ({ modelMs, voiceMs, transcriberMs: null, endpointingMs: null, turnMs: null });

describe("summarizeTurnSignals", () => {
  it("pools a latency over every timed turn and counts only the calls that had one", () => {
    const calls = [
      call({ callId: "a", turns: [turn(100), turn(300), turn(200)] }),
      call({ callId: "b", turns: [turn(null, 50)] }), // timed voice, not model
      call({ callId: "c", turns: null }),
    ];
    const s = summarizeTurnSignals(calls);
    expect(s.totalCalls).toBe(3);
    expect(s.llm.modelLatency).toEqual({ medianMs: 200, turns: 3, measuredCalls: 1 });
    expect(s.voice.voiceLatency).toEqual({ medianMs: 50, turns: 1, measuredCalls: 1 });
    expect(s.stt.transcriberLatency).toEqual({ medianMs: null, turns: 0, measuredCalls: 0 });
  });

  it("takes the median of an even pool as the mean of the middle two", () => {
    expect(summarizeTurnSignals([call({ turns: [turn(100), turn(400)] })]).llm.modelLatency.medianMs).toBe(250);
  });

  it("keeps a reported 0 interruptions as measured and a null as not asked", () => {
    const s = summarizeTurnSignals([
      call({ assistantInterruptions: 3 }),
      call({ assistantInterruptions: 0 }),
      call({ assistantInterruptions: null }),
    ]);
    expect(s.turnTaking).toMatchObject({ interruptedCalls: 1, interruptions: 3, interruptionsMeasuredCalls: 2 });
  });

  it("tallies outcomes most-calls-first and counts only the calls that have one", () => {
    const s = summarizeTurnSignals([
      call({ endedReason: "customer-ended-call", successEvaluation: "true" }),
      call({ endedReason: "assistant-ended-call", successEvaluation: null }),
      call({ endedReason: "customer-ended-call", successEvaluation: "false" }),
      call({}),
    ]);
    expect(s.outcome).toEqual({
      endedReasons: [
        { value: "customer-ended-call", calls: 2 },
        { value: "assistant-ended-call", calls: 1 },
      ],
      endedReasonKnownCalls: 3,
      successEvaluations: [
        { value: "false", calls: 1 },
        { value: "true", calls: 1 },
      ],
      successEvaluationKnownCalls: 2,
    });
  });
});
