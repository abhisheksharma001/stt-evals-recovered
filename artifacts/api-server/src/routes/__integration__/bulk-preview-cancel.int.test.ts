// T-181: POST /api/benchmark/bulks/preview and POST /api/benchmark/bulks/:bulkId/cancel
// against the throwaway database. The preview is the number a person reads
// BEFORE spending money, and T-14's promise is that nothing is dropped
// silently: every in-scope call is either selected or in exactly one named
// exclusion bucket. Cancel is the only way to stop a bulk that is already
// moving. Neither spends anything.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

/** M-16: a draft whose customer says exactly `count` words and whose
 *  assistant says a great many more, so a count that accidentally reads the
 *  whole transcript cannot pass. */
function draftWithCustomerWords(count: number): string {
  return [
    `AI: ${"thanks for calling and holding ".repeat(20).trim()}`,
    `User: ${Array.from({ length: count }, (_, i) => `word${i}`).join(" ")}`,
    `AI: ${"understood let me check that for you ".repeat(20).trim()}`,
  ].join("\n");
}

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("POST /api/benchmark/bulks/preview", () => {
  it("names why each call missed and prices only the ones that made it", async () => {
    // Scoped by an account label no other suite uses, so this pool is
    // exactly these three calls.
    const accountLabel = `fx-acct-${fx.suffix}`;
    await fx.call({ durationSeconds: 60, sourceAccountLabel: accountLabel });
    await fx.call({ durationSeconds: 5, sourceAccountLabel: accountLabel });
    await fx.call({ durationSeconds: 600, sourceAccountLabel: accountLabel });
    // costPerMinute is dollars; one minute at $0.50 is 50 cents.
    const provider = await fx.provider({ costPerMinute: 0.5 });

    const res = await request(app)
      .post("/api/benchmark/bulks/preview")
      .send({
        // M-5: this case is about the duration band, not the audio
        // channel -- said out loud so the new customer-channel default
        // does not silently empty it. M-16 adds a floor on customer words
        // with exactly the same problem, and the same answer: a fixture
        // call has no draft, so every one of them has 0 customer words.
        criteria: { accountLabel, requireCustomerAudio: false, minCustomerWords: 0 },
        providerIds: [provider.id],
        minDurationSeconds: 30,
        maxDurationSeconds: 300,
      });
    expect(res.status).toBe(200);
    expect(res.body.inScopeCount).toBe(3);
    expect(res.body.matchedCount).toBe(1);
    // Stable order: biggest bucket first, ties alphabetical, so the same
    // corpus reads the same way twice.
    expect(res.body.excluded).toEqual([
      { bucket: "longer than 300s", count: 1 },
      { bucket: "shorter than 30s", count: 1 },
    ]);
    // T-14's invariant: nothing is dropped silently.
    const excludedTotal = res.body.excluded.reduce((s: number, e: { count: number }) => s + e.count, 0);
    expect(res.body.matchedCount + excludedTotal).toBe(res.body.inScopeCount);

    // Only the selected call is priced -- the 5s and 600s calls cost
    // nothing because they will not run.
    expect(res.body.estimate.sttCostCents).toBe(50);
    expect(res.body.estimate.totalCostCents).toBe(50 + (res.body.estimate.agentCostCents ?? 0));
    expect(res.body.estimate.overThreshold).toBe(false);
    expect(res.body.costThresholdCents).toBeGreaterThan(0);
  });

  // M-16: the customer-word floor. Its whole point is that the seconds band
  // cannot see it -- both calls here sit inside the same duration band and
  // only one of them is a conversation.
  it("names the calls the customer barely spoke on, and does not touch the ones they did", async () => {
    const accountLabel = `fx-words-${fx.suffix}`;
    const talkative = await fx.call({
      durationSeconds: 90,
      sourceAccountLabel: accountLabel,
      draftTranscript: draftWithCustomerWords(40),
    });
    await fx.call({
      durationSeconds: 90,
      sourceAccountLabel: accountLabel,
      draftTranscript: draftWithCustomerWords(5),
    });

    const send = (criteria: Record<string, unknown>) =>
      request(app)
        .post("/api/benchmark/bulks/preview")
        .send({
          criteria: { accountLabel, requireCustomerAudio: false, ...criteria },
          providerIds: [],
          minDurationSeconds: 30,
          maxDurationSeconds: 300,
        });

    const floored = await send({ minCustomerWords: 20 });
    expect(floored.status).toBe(200);
    expect(floored.body.inScopeCount).toBe(2);
    expect(floored.body.matchedCount).toBe(1);
    expect(floored.body.excluded).toEqual([{ bucket: "fewer than 20 customer words", count: 1 }]);

    // Both calls are 90s, so the band alone cannot tell them apart: drop the
    // floor and the quiet call comes straight back. This is the "prove it by
    // breaking it" half, run as a test rather than trusted.
    const unfloored = await send({ minCustomerWords: 0 });
    expect(unfloored.status).toBe(200);
    expect(unfloored.body.matchedCount).toBe(2);
    expect(unfloored.body.excluded).toEqual([]);

    // And a floor nobody clears empties the selection by name rather than
    // silently -- what a `vertical: trucking` bulk will actually see.
    const impossible = await send({ minCustomerWords: 500 });
    expect(impossible.body.matchedCount).toBe(0);
    expect(impossible.body.excluded).toEqual([
      { bucket: "fewer than 500 customer words", count: 2 },
    ]);

    // A hand-picked call still skips the floor, exactly as it skips the band.
    const picked = await request(app)
      .post("/api/benchmark/bulks/preview")
      .send({
        criteria: { callIds: [talkative.id], requireCustomerAudio: false, minCustomerWords: 500 },
        providerIds: [],
      });
    expect(picked.body.matchedCount).toBe(1);
  });

  it("does not second-guess a hand-picked call against the band", async () => {
    // A call named by id is in because a person said so: the window, band
    // and outcome filters are skipped for it by design.
    const shorty = await fx.call({ durationSeconds: 5 });

    const res = await request(app)
      .post("/api/benchmark/bulks/preview")
      .send({ criteria: { callIds: [shorty.id], requireCustomerAudio: false }, providerIds: [], minDurationSeconds: 30, maxDurationSeconds: 300 });
    expect(res.status).toBe(200);
    expect(res.body.inScopeCount).toBe(1);
    expect(res.body.matchedCount).toBe(1);
    expect(res.body.excluded).toEqual([]);
  });

  it("prices nothing when no provider is picked, and refuses an upside-down band", async () => {
    const call = await fx.call({ durationSeconds: 60 });

    const noProviders = await request(app)
      .post("/api/benchmark/bulks/preview")
      .send({ criteria: { callIds: [call.id], requireCustomerAudio: false }, providerIds: [] });
    expect(noProviders.status).toBe(200);
    expect(noProviders.body.matchedCount).toBe(1);
    // No providers picked yet is "unknown", not "free".
    expect(noProviders.body.estimate).toBeNull();

    const band = await request(app)
      .post("/api/benchmark/bulks/preview")
      .send({ criteria: { callIds: [call.id], requireCustomerAudio: false }, providerIds: [], minDurationSeconds: 120, maxDurationSeconds: 30 });
    expect(band.status).toBe(400);
    expect(band.body.error).toMatch(/must be >= minDurationSeconds/);
  });
});

describe("POST /api/benchmark/bulks/:bulkId/cancel", () => {
  it("cancels the bulk and its queued shards, then refuses to cancel again", async () => {
    const bulk = await fx.bulk({ status: "running" });
    const queued = await fx.run({ bulkId: bulk.id, status: "queued", purpose: "batch" });

    const res = await request(app).post(`/api/benchmark/bulks/${bulk.id}/cancel`).set("x-actor", fx.actor);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: bulk.id, status: "cancelled" });
    expect(res.body.completedAt).not.toBeNull();

    // A shard that had not started is stopped with it; nothing is left
    // queued to wake up later and spend money.
    const detail = await request(app).get(`/api/benchmark/bulks/${bulk.id}`);
    expect(detail.body.runs.find((r: { id: string }) => r.id === queued.id).status).toBe("cancelled");

    const again = await request(app).post(`/api/benchmark/bulks/${bulk.id}/cancel`).set("x-actor", fx.actor);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already cancelled/);
  });

  it("answers 404 for an unknown bulk and a sentence for a malformed id", async () => {
    const unknown = await request(app).post("/api/benchmark/bulks/00000000-0000-4000-8000-000000000000/cancel");
    expect(unknown.status).toBe(404);

    const malformed = await request(app).post("/api/benchmark/bulks/not-a-uuid/cancel");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/bulkId/);
  });
});

describe("POST /api/benchmark/bulks with a selection that matches nothing", () => {
  it("refuses with the buckets that emptied it, and creates nothing", async () => {
    // M-3b. The real 2026-09-04 case in miniature: a saved template asking
    // for a window the corpus has moved out from under. Every call here is
    // out of band, so the launch is refused before anything is created --
    // this test cannot spend, and the provider id belongs to no adapter.
    const accountLabel = `fx-empty-${fx.suffix}`;
    await fx.call({ durationSeconds: 5, sourceAccountLabel: accountLabel });
    await fx.call({ durationSeconds: 5, sourceAccountLabel: accountLabel });
    await fx.call({ durationSeconds: 600, sourceAccountLabel: accountLabel });
    const provider = await fx.provider({ costPerMinute: 0.5 });

    const res = await request(app)
      .post("/api/benchmark/bulks")
      .set("x-actor", fx.actor)
      .send({
        name: `empty selection ${fx.suffix}`,
        // M-5: still a 400, but it has to be the BAND that empties this,
        // not the audio channel -- the assertion below names the filter.
        // M-16: the band already fires first for all three of these calls,
        // so the floor changes nothing here; stated anyway, so the comment
        // above stays true by construction rather than by ordering luck.
        criteria: { accountLabel, requireCustomerAudio: false, minCustomerWords: 0 },
        providerIds: [provider.id],
        minDurationSeconds: 30,
        maxDurationSeconds: 300,
      });

    expect(res.status).toBe(400);
    // The whole point of M-3b: the sentence says which filter did it and how
    // many it took, not just that the answer was empty.
    expect(res.body.error).toBe(
      "no corpus calls matched: 0 of 3 in scope (shorter than 30s 2, longer than 300s 1)",
    );

    // Refused means refused: no bulk row was left behind under that name.
    const list = await request(app).get("/api/benchmark/bulks");
    expect(list.status).toBe(200);
    expect(list.body.find((b: { name: string }) => b.name === `empty selection ${fx.suffix}`)).toBeUndefined();
  });
});
