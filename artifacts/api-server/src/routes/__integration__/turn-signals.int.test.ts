// W-7: GET /api/benchmark/bulks/:bulkId/turn-signals against the throwaway
// database and ONE synthetic artifact on disk. What is held: a call without
// a saved artifact is "not timed", not a row of zeros; the assistant scope is
// the verdict's own seam; and nothing textual from the artifact -- which is
// seeded WITH `messages` and `transcript` on purpose -- reaches the response.
// The artifact file carries a random fixture uuid and is removed in afterAll.
import fs from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import { artifactCachePathFor, ensureAudioCacheDir } from "../../lib/audio-cache";
import { server } from "./server";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();
const written: string[] = [];

afterAll(async () => {
  await Promise.all(written.map((p) => fs.rm(p, { force: true })));
  await fx.cleanup();
  await pool.end();
});

async function seed() {
  const a1 = `fx-ts-a1-${fx.suffix}`;
  const a2 = `fx-ts-a2-${fx.suffix}`;
  const timed = await fx.call({ sourceAssistantId: a1 });
  const untimed = await fx.call({ sourceAssistantId: a1 });
  const other = await fx.call({
    sourceAssistantId: a2,
    prodAssistantInterruptions: 2,
    prodToolCalls: 0,
    sourceEndedReason: "customer-ended-call",
    sourceSuccessEvaluation: "true",
  });
  const provider = await fx.provider();
  const bulk = await fx.bulk({ providerIds: [provider.id] });
  await fx.run({ bulkId: bulk.id, callIds: [timed.id, untimed.id, other.id], providerIds: [provider.id], callCount: 3 });

  await ensureAudioCacheDir();
  const artifactPath = artifactCachePathFor(timed.id);
  written.push(artifactPath);
  await fs.writeFile(
    artifactPath,
    JSON.stringify({
      messages: [{ role: "user", message: "SYNTHETIC-WORDS-MUST-NOT-LEAVE" }],
      transcript: "SYNTHETIC-TRANSCRIPT-MUST-NOT-LEAVE",
      performanceMetrics: {
        turnLatencies: [
          { modelLatency: 100, voiceLatency: 50, transcriberLatency: 300, endpointingLatency: 100, turnLatency: 600 },
          { modelLatency: 200, voiceLatency: 0, transcriberLatency: 400, endpointingLatency: 120, turnLatency: 700 },
          { modelLatency: 300, voiceLatency: 70, transcriberLatency: 500, endpointingLatency: 140, turnLatency: 800 },
        ],
      },
    }),
  );
  return { a1, a2, timed, untimed, other, bulk };
}

describe("GET /api/benchmark/bulks/:bulkId/turn-signals", () => {
  it("reads turns off the saved artifact, leaves an unsaved call untimed, and pools with denominators", async () => {
    const { a1, timed, untimed, other, bulk } = await seed();

    const res = await request(server).get(`/api/benchmark/bulks/${bulk.id}/turn-signals`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bulkId: bulk.id, assistantId: null });
    expect(res.body.calls).toHaveLength(3);

    const byId = Object.fromEntries(res.body.calls.map((c: { callId: string }) => [c.callId, c]));
    expect(byId[timed.id].turns).toHaveLength(3);
    expect(byId[timed.id].turns[1]).toEqual({ modelMs: 200, voiceMs: null, transcriberMs: 400, endpointingMs: 120, turnMs: 700 });
    expect(byId[untimed.id]).toMatchObject({ turns: null, assistantInterruptions: null, toolCalls: null, endedReason: null });
    expect(byId[other.id]).toMatchObject({ turns: null, assistantInterruptions: 2, toolCalls: 0, endedReason: "customer-ended-call", successEvaluation: "true" });

    // "timed on 1 of 3": the two untimed calls are not two zeros.
    expect(res.body.summary.totalCalls).toBe(3);
    expect(res.body.summary.llm.modelLatency).toEqual({ medianMs: 200, turns: 3, measuredCalls: 1 });
    expect(res.body.summary.voice.voiceLatency).toEqual({ medianMs: 60, turns: 2, measuredCalls: 1 });
    expect(res.body.summary.turnTaking).toMatchObject({
      endpointingLatency: { medianMs: 120, turns: 3, measuredCalls: 1 },
      interruptedCalls: 1,
      interruptions: 2,
      interruptionsMeasuredCalls: 1,
    });
    expect(res.body.summary.outcome).toEqual({
      endedReasons: [{ value: "customer-ended-call", calls: 1 }],
      endedReasonKnownCalls: 1,
      successEvaluations: [{ value: "true", calls: 1 }],
      successEvaluationKnownCalls: 1,
    });

    // Numbers and enums only.
    expect(res.text).not.toContain("MUST-NOT-LEAVE");
    expect(res.text).not.toContain("messages");
    expect(res.text).not.toContain("transcript");

    // Scoped to one agent through the verdict's seam.
    const one = await request(server).get(`/api/benchmark/bulks/${bulk.id}/turn-signals`).query({ assistantId: a1 });
    expect(one.status).toBe(200);
    expect(one.body.assistantId).toBe(a1);
    expect(one.body.calls.map((c: { callId: string }) => c.callId).sort()).toEqual([timed.id, untimed.id].sort());
    expect(one.body.summary).toMatchObject({ totalCalls: 2, turnTaking: { interruptionsMeasuredCalls: 0 } });

    const none = await request(server).get(`/api/benchmark/bulks/${bulk.id}/turn-signals`).query({ assistantId: "fx-nobody" });
    expect(none.status).toBe(400);
    expect(none.body.error).toContain("fx-nobody");
  });

  it("answers 404 for an unknown bulk and a sentence for a malformed id", async () => {
    const missing = await request(server).get("/api/benchmark/bulks/00000000-0000-4000-8000-000000000000/turn-signals");
    expect(missing.status).toBe(404);
    const malformed = await request(server).get("/api/benchmark/bulks/not-a-uuid/turn-signals");
    expect(malformed.status).toBe(400);
    expect(typeof malformed.body.error).toBe("string");
  });
});
