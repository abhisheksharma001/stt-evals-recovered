import { describe, expect, it } from "vitest";
import { CEILING_CENTS, MAX_LIVE_BULKS, callFor, gate, planFor } from "./import-public-set";

const seven = [
  { id: "assemblyai-universal", costPerMinute: 0.006 },
  { id: "cartesia-ink-whisper", costPerMinute: 0.0022 },
  { id: "deepgram-nova", costPerMinute: 0.0043 },
  { id: "deepgram-nova-3", costPerMinute: 0.0043 },
  { id: "elevenlabs-scribe", costPerMinute: 0.0065 },
  { id: "gladia-solaria-3", costPerMinute: 0.0102 },
  { id: "openai-gpt-4o-transcribe", costPerMinute: 0.006 },
];

describe("planFor", () => {
  it("prices the exact minutes and shows the rounded minutes beside them", () => {
    // 1,000 clips at the set's mean of 9.5933 s = 159.9 min; a 0.4 s
    // fraction rounds down per call, so the rounded sum is smaller.
    const durations = Array.from({ length: 1000 }, () => 9.4);
    const plan = planFor(durations, seven);
    expect(plan.clips).toBe(1000);
    expect(plan.exactMinutes).toBeCloseTo(156.67, 2);
    expect(plan.roundedMinutes).toBeCloseTo(150, 2);
    expect(plan.perMinute).toBeCloseTo(0.0395, 6);
    expect(plan.estimateCents).toBe(Math.round(156.6667 * 0.0395 * 100));
  });
});

describe("gate", () => {
  const ok = { apply: true, goSpend: true, estimateCents: 632, liveBulks: 3, bulkExists: false, readyProviders: 7 };

  it("is a dry run unless --apply and --go-spend are both given", () => {
    expect(gate({ ...ok, apply: false, goSpend: false }).action).toBe("dry-run");
    expect(gate({ ...ok, apply: true, goSpend: false }).action).toBe("dry-run");
    expect(gate({ ...ok, apply: false, goSpend: true }).action).toBe("dry-run");
    expect(gate(ok).action).toBe("go");
  });

  it("refuses above the D-15 ceiling, even with both flags", () => {
    const g = gate({ ...ok, estimateCents: CEILING_CENTS + 1 });
    expect(g.action).toBe("refuse");
    expect(g.reason).toMatch(/ceiling/);
    expect(gate({ ...ok, estimateCents: CEILING_CENTS }).action).toBe("go");
  });

  it("refuses a second run and a bulk that would evict a client's", () => {
    expect(gate({ ...ok, bulkExists: true }).reason).toMatch(/one run/);
    expect(gate({ ...ok, liveBulks: MAX_LIVE_BULKS }).reason).toMatch(/evict/);
    expect(gate({ ...ok, liveBulks: MAX_LIVE_BULKS - 1 }).action).toBe("go");
    expect(gate({ ...ok, readyProviders: 0 }).action).toBe("refuse");
  });

  it("refuses before it dry-runs: a too-expensive plan is never reported as a dry run", () => {
    expect(gate({ ...ok, apply: false, goSpend: false, estimateCents: 900 }).action).toBe("refuse");
  });
});

describe("callFor", () => {
  it("gives every clip an audioObjectPath, so the executor does not refuse it (W-12a3)", () => {
    const body = callFor({
      sampleId: "0a1b2c3d-sample",
      durationSeconds: 9.4,
      transcription: "hello there",
      audioUrl: "https://example.invalid/clip.wav",
    });
    // The marker names the source; it is never fetched (the audio is in the cache).
    expect(body.audioObjectPath).toBe("hf://datasets/pipecat-ai/stt-benchmark-data/0a1b2c3d-sample");
    expect(body.sourceProvider).toBe("pipecat");
    expect(body.sourceCallId).toBe("0a1b2c3d-sample");
    expect(body.goldTranscript).toBe("hello there");
  });
});
