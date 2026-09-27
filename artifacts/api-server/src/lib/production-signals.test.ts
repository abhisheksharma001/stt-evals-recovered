import { describe, expect, it } from "vitest";

import { readProductionSignals, readTurnLatencies } from "./production-signals";

// The shapes below are the ones counted on disk on 2026-09-06, trimmed to the
// fields this reader looks at. Every case is one rule from the module's own
// header -- if a rule changes, exactly one of these has to change with it.

describe("readProductionSignals", () => {
  it("reads all four signals from a fully populated artifact", () => {
    expect(
      readProductionSignals({
        performanceMetrics: {
          transcriberLatencyAverage: 378.3,
          endpointingLatencyAverage: 120.3,
          numAssistantInterrupted: 2,
          turnLatencies: [{}, {}],
        },
        messages: [
          { role: "bot" },
          { role: "tool_calls", toolCalls: [{ id: "a" }, { id: "b" }] },
          { role: "tool_call_result", toolCallId: "a" },
        ],
      }),
    ).toEqual({
      prodTranscriberLatencyMs: 378.3,
      prodEndpointingLatencyMs: 120.3,
      prodAssistantInterruptions: 2,
      prodToolCalls: 2,
    });
  });

  it("reads a zero latency as not measured, not as a fast call", () => {
    // 23 of the 100 saved artifacts look like this; 21 of them have the empty
    // turnLatencies array below, which is what a zero really means.
    const signals = readProductionSignals({
      performanceMetrics: {
        transcriberLatencyAverage: 0,
        endpointingLatencyAverage: 0,
        turnLatencies: [],
      },
      messages: [],
    });
    expect(signals.prodTranscriberLatencyMs).toBeNull();
    expect(signals.prodEndpointingLatencyMs).toBeNull();
  });

  it("reads an absent interruption count as unknown and a reported zero as zero", () => {
    // 53 of the 100 have no numAssistantInterrupted at all. Storing 0 for
    // those would report a calm call on evidence nobody collected.
    expect(readProductionSignals({ performanceMetrics: {} }).prodAssistantInterruptions).toBeNull();
    expect(
      readProductionSignals({ performanceMetrics: { numAssistantInterrupted: 0 } }).prodAssistantInterruptions,
    ).toBe(0);
  });

  it("counts tool invocations, not tool-call messages", () => {
    // Corpus-wide: 116 messages carrying 119 entries. Counting messages
    // would lose the three calls made in a batch.
    expect(
      readProductionSignals({
        messages: [
          { role: "tool_calls", toolCalls: [{ id: "a" }, { id: "b" }, { id: "c" }] },
          { role: "tool_calls", toolCalls: [{ id: "d" }] },
        ],
      }).prodToolCalls,
    ).toBe(4);
  });

  it("separates a call with no tool calls from a call whose messages were not saved", () => {
    expect(readProductionSignals({ messages: [{ role: "bot" }] }).prodToolCalls).toBe(0);
    expect(readProductionSignals({ messages: null }).prodToolCalls).toBeNull();
  });

  it("returns every signal null for an artifact that is not an object", () => {
    for (const artifact of [null, undefined, "", [], 7]) {
      expect(readProductionSignals(artifact)).toEqual({
        prodTranscriberLatencyMs: null,
        prodEndpointingLatencyMs: null,
        prodAssistantInterruptions: null,
        prodToolCalls: null,
      });
    }
  });
});

// W-7: the per-turn reader. Same zero rule per field as the averages: a 0
// is a turn Vapi did not time, and an empty array is a call it did not time.
describe("readTurnLatencies", () => {
  it("reads the five numbers per turn and nulls a 0 in any one of them", () => {
    expect(
      readTurnLatencies({
        performanceMetrics: {
          turnLatencies: [
            { modelLatency: 410, voiceLatency: 220, transcriberLatency: 300, endpointingLatency: 120, turnLatency: 1050 },
            { modelLatency: 390, voiceLatency: 0, transcriberLatency: 280, endpointingLatency: 0, turnLatency: 670 },
          ],
        },
        messages: [{ role: "user", message: "never read" }],
      }),
    ).toEqual([
      { modelMs: 410, voiceMs: 220, transcriberMs: 300, endpointingMs: 120, turnMs: 1050 },
      { modelMs: 390, voiceMs: null, transcriberMs: 280, endpointingMs: null, turnMs: 670 },
    ]);
  });

  it("is null, not [], for an empty array, a missing block, or a non-object", () => {
    expect(readTurnLatencies({ performanceMetrics: { turnLatencies: [] } })).toBeNull();
    expect(readTurnLatencies({ performanceMetrics: { transcriberLatencyAverage: 0 } })).toBeNull();
    expect(readTurnLatencies({})).toBeNull();
    expect(readTurnLatencies("not an artifact")).toBeNull();
  });
});
