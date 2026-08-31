// T-162: GET /api/benchmark/words-to-watch against the throwaway database.
// The list is pure query logic over spans -- which runs are in scope (one
// bulk vs every finished bulk), latest run per call, the assistant filter --
// none of it visible to the compile check. Bulk mode is fully scoped to this
// suite's own bulk, so exact counts are safe there; the all-time tests
// assert containment only, because they sweep every finished bulk in the
// shared database. Disputed words carry a letters-only suffix (hex digits
// would land in the number-canonicalisation path) so containment can never
// collide with anyone else's data.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();
// Letters-only tag for made-up words: "zebragh..." never collides and never
// reads as a number to canonicalTranscript.
const ws = fx.suffix.replace(/\d/g, (d) => "ghijklmnop"[Number(d)]!);

/** A Deepgram-shaped raw response (seconds), one word per second -- spans
 *  need at least one candidate with word timings (the reference is the
 *  clock), and extraction is vendor-keyed (T-110), so span providers here
 *  carry deepgram-prefixed ids. An adapter only ever fires inside run
 *  execution, which no read route touches. */
function deepgramRaw(transcript: string): string {
  const words = transcript.split(/\s+/).filter(Boolean);
  return JSON.stringify({
    results: {
      channels: [{ alternatives: [{ words: words.map((word, i) => ({ word, start: i, end: i + 0.5 })) }] }],
    },
  });
}

let timedProviderCount = 0;
async function timedProvider() {
  return fx.provider({ id: `deepgram-fxw${timedProviderCount++}-${fx.suffix}` });
}

/** An ok cell whose transcript also carries timings. */
async function timedResult(runId: string, callId: string, providerId: string, transcript: string) {
  return fx.result(runId, callId, providerId, { hypothesisTranscript: transcript, rawOutput: deepgramRaw(transcript) });
}

type WatchWord = {
  heardAs: string;
  kind: string;
  noMajority: boolean;
  calls: number;
  spans: number;
  alternatives: { text: string; count: number; providerIds: string[] }[];
  exampleCallIds: string[];
};
type WordsToWatchBody = {
  bulkId: string | null;
  bulksCovered: number;
  assistantId: string | null;
  callsScanned: number;
  callsWithSpans: number;
  words: WatchWord[];
};

async function getWords(query: Record<string, string> = {}) {
  const res = await request(app).get("/api/benchmark/words-to-watch").query(query);
  expect(res.status).toBe(200);
  return res.body as WordsToWatchBody;
}

/** All reading texts behind a word row, heardAs included. */
const readingsOf = (w: WatchWord) => [w.heardAs, ...w.alternatives.map((a) => a.text)];

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("GET /api/benchmark/words-to-watch", () => {
  it("bulk mode: a real split surfaces, a convention split does not (batch-7 canonical rule)", async () => {
    const bulk = await fx.bulk({ status: "complete" });
    const run = await fx.run({ bulkId: bulk.id, purpose: "batch" });
    const call = await fx.call();
    const p1 = await timedProvider();
    const p2 = await timedProvider();
    // One real disagreement (zebra vs zefra) and one convention pair
    // ("four" vs "4") in the same transcripts. The convention pair must not
    // become a span at all -- canonicalTranscript folds it before comparing.
    await timedResult(run.id, call.id, p1.id, `my code is zebra${ws} four`);
    await timedResult(run.id, call.id, p2.id, `my code is zefra${ws} 4`);

    const body = await getWords({ bulkId: bulk.id });
    expect(body.bulkId).toBe(bulk.id);
    expect(body.bulksCovered).toBe(1);
    expect(body.callsScanned).toBe(1);
    expect(body.callsWithSpans).toBe(1);
    // Scoped to this bulk only, so the exact count holds: one word, not two.
    expect(body.words).toHaveLength(1);
    const word = body.words[0]!;
    expect(readingsOf(word).sort()).toEqual([`zebra${ws}`, `zefra${ws}`]);
    expect(word.kind).toBe("word");
    // Two providers, one reading each: a tie, so no majority anywhere.
    expect(word.noMajority).toBe(true);
    expect(word.calls).toBe(1);
    expect(word.exampleCallIds).toContain(call.id);
  });

  it("all-time: only a call's latest run counts, and an unfinished bulk's runs do not count at all", async () => {
    const call = await fx.call();
    const p1 = await timedProvider();
    const p2 = await timedProvider();

    const olderBulk = await fx.bulk({ status: "complete" });
    const olderRun = await fx.run({
      bulkId: olderBulk.id,
      purpose: "batch",
      createdAt: new Date(Date.now() - 60_000),
    });
    await timedResult(olderRun.id, call.id, p1.id, `stale${ws} reading`);
    await timedResult(olderRun.id, call.id, p2.id, `stalf${ws} reading`);

    const newerBulk = await fx.bulk({ status: "partial" });
    const newerRun = await fx.run({ bulkId: newerBulk.id, purpose: "batch" });
    await timedResult(newerRun.id, call.id, p1.id, `fresh${ws} reading`);
    await timedResult(newerRun.id, call.id, p2.id, `fresg${ws} reading`);

    const runningBulk = await fx.bulk({ status: "running" });
    const runningRun = await fx.run({ bulkId: runningBulk.id, purpose: "batch" });
    await timedResult(runningRun.id, call.id, p1.id, `moving${ws} reading`);
    await timedResult(runningRun.id, call.id, p2.id, `movinh${ws} reading`);

    const body = await getWords();
    expect(body.bulkId).toBeNull();
    const texts = body.words.flatMap(readingsOf);
    // The call ran in two finished bulks; only its newest run's split shows.
    expect(texts).toContain(`fresh${ws}`);
    expect(texts).not.toContain(`stale${ws}`);
    // The running bulk's split joins the list only once that bulk settles.
    expect(texts).not.toContain(`moving${ws}`);
  });

  it("assistantId narrows to that assistant's calls", async () => {
    const bulk = await fx.bulk({ status: "complete" });
    const run = await fx.run({ bulkId: bulk.id, purpose: "batch" });
    const mineId = `fx-asst-words-${fx.suffix}`;
    const mine = await fx.call({ sourceAssistantId: mineId });
    const other = await fx.call({ sourceAssistantId: `fx-asst-other-${fx.suffix}` });
    const p1 = await timedProvider();
    const p2 = await timedProvider();
    await timedResult(run.id, mine.id, p1.id, `wanted${ws} split`);
    await timedResult(run.id, mine.id, p2.id, `wantef${ws} split`);
    await timedResult(run.id, other.id, p1.id, `unwanted${ws} split`);
    await timedResult(run.id, other.id, p2.id, `unwantef${ws} split`);

    const body = await getWords({ bulkId: bulk.id, assistantId: mineId });
    expect(body.assistantId).toBe(mineId);
    expect(body.callsScanned).toBe(1);
    const texts = body.words.flatMap(readingsOf);
    expect(texts).toContain(`wanted${ws}`);
    expect(texts).not.toContain(`unwanted${ws}`);
  });

  it("answers 404 for an unknown bulk and a sentence for a malformed bulkId", async () => {
    const missing = await request(app)
      .get("/api/benchmark/words-to-watch")
      .query({ bulkId: "00000000-0000-4000-8000-000000000000" });
    expect(missing.status).toBe(404);

    const malformed = await request(app).get("/api/benchmark/words-to-watch").query({ bulkId: "not-a-uuid" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/bulkId/);
  });
});
