// T-174: GET /api/benchmark/bulks/:bulkId/verdicts and its printable twin
// /verdict.html against the throwaway database. This is the artefact a
// decision gets made from and handed on (T-20 / T-32), so what is held here
// is what the ROUTE adds to the pure scorer: grouping the bulk's calls by
// org, resolving which provider row IS the production transcriber, and
// refusing to name a winner on this much evidence. The HTML must stay one
// self-contained file -- no scripts, no external assets -- because it is
// saved and mailed, not served.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import { SCORING_VERSION } from "@workspace/scoring";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

/** One bulk: two calls from an org whose production transcriber is on
 *  file, one call with no org label at all, and a challenger that reads
 *  them cleaner than production does. */
async function seedBulk() {
  // Names/models are what resolveProductionProviderId matches on, after
  // normalisation -- the call says "deepgram"/"nova-3", the row says
  // "Deepgram"/"Nova-3".
  const production = await fx.provider({ name: "Deepgram", model: "Nova-3" });
  const challenger = await fx.provider({ name: `fx challenger ${fx.suffix}`, model: "x" });
  const org = `fx-org-${fx.suffix}`;
  const inOrg = [
    await fx.call({ sourceAccountLabel: org, sourceAssistantId: `fx-a1-${fx.suffix}`, sourceTranscriberProvider: "deepgram", sourceTranscriberModel: "nova-3" }),
    await fx.call({ sourceAccountLabel: org, sourceAssistantId: `fx-a2-${fx.suffix}`, sourceTranscriberProvider: "deepgram", sourceTranscriberModel: "nova-3" }),
  ];
  const orphan = await fx.call({ sourceAccountLabel: null });
  const bulk = await fx.bulk({ providerIds: [production.id, challenger.id] });
  const run = await fx.run({
    bulkId: bulk.id,
    callIds: [...inOrg.map((c) => c.id), orphan.id],
    providerIds: [production.id, challenger.id],
    callCount: 3,
  });

  for (const call of inOrg) {
    const prodCell = await fx.result(run.id, call.id, production.id, { hypothesisTranscript: "alpha beta gamma delta" });
    await fx.score(prodCell.id, { peerFlagCount: 2 });
    const challengerCell = await fx.result(run.id, call.id, challenger.id, { hypothesisTranscript: "alpha beta gamma delta" });
    await fx.score(challengerCell.id, { peerFlagCount: 0 });
  }
  // The unlabelled call ran on one provider only.
  const lone = await fx.result(run.id, orphan.id, production.id, { hypothesisTranscript: "alpha beta" });
  await fx.score(lone.id, { peerFlagCount: 1 });

  return { bulk, org, production, challenger };
}

describe("GET /api/benchmark/bulks/:bulkId/verdicts", () => {
  it("groups by org, resolves production, and refuses a winner on two calls", async () => {
    const { bulk, org, production, challenger } = await seedBulk();

    const res = await request(app).get(`/api/benchmark/bulks/${bulk.id}/verdicts`);
    expect(res.status).toBe(200);
    expect(res.body.bulkId).toBe(bulk.id);
    expect(res.body.providers.map((p: { id: string }) => p.id).sort()).toEqual([production.id, challenger.id].sort());

    // Scoped to one bulk, so the group list is exactly ours: the
    // unlabelled group sorts first, the org second.
    expect(res.body.groups.map((g: { clientLabel: string | null }) => g.clientLabel)).toEqual([null, org]);

    const [orphanGroup, orgGroup] = res.body.groups;
    expect(orgGroup).toMatchObject({
      callCount: 2,
      assistantIds: [`fx-a1-${fx.suffix}`, `fx-a2-${fx.suffix}`],
      // What production actually ran on these calls, and on how many.
      production: { vendor: "deepgram", model: "nova-3", coverage: 2, total: 2 },
    });
    expect(orgGroup.verdict).toMatchObject({
      // Two calls shared by the top two: under the five-call floor, so the
      // leader is named but no winner is.
      decision: "too_few_calls",
      winnerProviderId: null,
      leaderProviderId: challenger.id,
      runnerUpProviderId: production.id,
      productionProviderId: production.id,
      productionIsLeader: false,
      evidenceCalls: 2,
      provisional: true,
    });
    expect(orgGroup.verdict.vsProductionPct).toBeGreaterThan(0);
    expect(orgGroup.verdict.sentence).toMatch(/Need 5/);
    expect(orgGroup.verdict.rates).toHaveLength(2);

    // One provider ran the unlabelled call: there is nothing to compare,
    // and the route says so instead of crowning it.
    expect(orphanGroup).toMatchObject({ callCount: 1, assistantIds: [null] });
    expect(orphanGroup.verdict).toMatchObject({
      decision: "insufficient",
      winnerProviderId: null,
      leaderProviderId: production.id,
    });
    expect(orphanGroup.verdict.sentence).toMatch(/nothing to compare/);
  });

  // M-8a: production (Flux) is streaming-only, never has cells of its own,
  // and resolveProductionProviderId is only handed the providers that RAN --
  // so `vsProductionPct` is null on every real bulk and always has been. What
  // production does have on every call is the Vapi draft. Its "User:" turns
  // are its transcript of the customer channel, and they go in as a
  // non-voting candidate: measured against the pack, never joining it.
  it("measures production's own draft against the candidates on a customer-channel bulk", async () => {
    const providers = [
      await fx.provider({ name: `fx-p1-${fx.suffix}`, model: "x" }),
      await fx.provider({ name: `fx-p2-${fx.suffix}`, model: "x" }),
      await fx.provider({ name: `fx-p3-${fx.suffix}`, model: "x" }),
    ];
    const org = `fx-cust-org-${fx.suffix}`;
    // The three candidates agree exactly; production's caller turn differs on
    // its last word, so 1 of its 4 compared words is a mismatch.
    const calls = [
      await fx.call({ sourceAccountLabel: org, draftTranscript: "AI: hello there\nUser: alpha beta gamma epsilon" }),
      await fx.call({ sourceAccountLabel: org, draftTranscript: "AI: hello there\nUser: alpha beta gamma epsilon" }),
    ];
    const bulk = await fx.bulk({
      providerIds: providers.map((p) => p.id),
      selectionCriteria: { resolvedCallIds: [], requireCustomerAudio: true },
    });
    const run = await fx.run({ bulkId: bulk.id, callIds: calls.map((c) => c.id), providerIds: providers.map((p) => p.id), callCount: 2 });
    for (const call of calls) {
      for (const provider of providers) {
        const cell = await fx.result(run.id, call.id, provider.id, {
          hypothesisTranscript: "alpha beta gamma delta",
          audioSource: "customer",
        });
        await fx.score(cell.id, { peerFlagCount: 0 });
      }
    }

    const res = await request(app).get(`/api/benchmark/bulks/${bulk.id}/verdicts`);
    expect(res.status).toBe(200);
    const group = res.body.groups.find((g: { clientLabel: string | null }) => g.clientLabel === org);

    // 1 mismatched word of 4 compared, pooled over both calls.
    expect(group.productionDisagreement).toMatchObject({ rate: 0.25, leaderRate: 0, calls: 2, totalCalls: 2 });
    // The candidates agreed with each other exactly, and production being
    // scored did not move that -- the whole reason it does not vote.
    expect(group.productionDisagreement.leaderProviderId).toBe([...providers.map((p) => p.id)].sort()[0]);

    // Production is measured, never ranked. Nothing in the table is it.
    const rateIds = group.verdict.rates.map((r: { providerId: string }) => r.providerId);
    expect(rateIds.sort()).toEqual([...providers.map((p) => p.id)].sort());
    expect(JSON.stringify(res.body)).not.toContain("__production__");
  });

  it("gives no production number at all on a mono bulk, rather than a flattering one", async () => {
    // The same seed on the mono mix. There the candidates transcribed BOTH
    // speakers and production's draft turns are the caller alone, so any
    // comparison would read as disagreement for the assistant's turns being
    // absent -- a number that says nothing about production. Null is the
    // honest answer, and null is not zero.
    const providers = [
      await fx.provider({ name: `fx-m1-${fx.suffix}`, model: "x" }),
      await fx.provider({ name: `fx-m2-${fx.suffix}`, model: "x" }),
      await fx.provider({ name: `fx-m3-${fx.suffix}`, model: "x" }),
    ];
    const org = `fx-mono-org-${fx.suffix}`;
    const call = await fx.call({ sourceAccountLabel: org, draftTranscript: "AI: hello there\nUser: alpha beta gamma epsilon" });
    const bulk = await fx.bulk({ providerIds: providers.map((p) => p.id) });
    const run = await fx.run({ bulkId: bulk.id, callIds: [call.id], providerIds: providers.map((p) => p.id), callCount: 1 });
    for (const provider of providers) {
      const cell = await fx.result(run.id, call.id, provider.id, { hypothesisTranscript: "alpha beta gamma delta" });
      await fx.score(cell.id, { peerFlagCount: 0 });
    }

    const res = await request(app).get(`/api/benchmark/bulks/${bulk.id}/verdicts`);
    expect(res.status).toBe(200);
    const group = res.body.groups.find((g: { clientLabel: string | null }) => g.clientLabel === org);
    // Present and null -- the field is required by the contract, so a reader
    // can tell "no answer" from "the key is missing because it is old".
    expect(group).toHaveProperty("productionDisagreement", null);
  });

  it("answers 404 for an unknown bulk and a sentence for a malformed id", async () => {
    const unknown = await request(app).get("/api/benchmark/bulks/00000000-0000-4000-8000-000000000000/verdicts");
    expect(unknown.status).toBe(404);

    const malformed = await request(app).get("/api/benchmark/bulks/not-a-uuid/verdicts");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/bulkId/);
  });
});

describe("GET /api/benchmark/bulks/:bulkId/verdict.html", () => {
  it("is one self-contained, dated, stamped document", async () => {
    const { bulk } = await seedBulk();

    const res = await request(app).get(`/api/benchmark/bulks/${bulk.id}/verdict.html`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    // Saved as a file, named for the bulk and the day it was produced.
    expect(res.headers["content-disposition"]).toMatch(
      new RegExp(`^inline; filename="stt-verdict-${bulk.name}-\\d{4}-\\d{2}-\\d{2}\\.html"$`),
    );
    expect(res.headers["cache-control"]).toBe("no-store");

    const html = res.text;
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // Everything needed to argue with it later: which bulk, which build,
    // which scoring rules, and the same numbers the JSON answers.
    expect(html).toContain(bulk.id);
    expect(html).toContain(`scoring ${SCORING_VERSION}`);
    expect(html).toContain("Deepgram");
    expect(html).toContain("not enough calls");
    // Self-contained: nothing to fetch, nothing to run.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("http");
  });

  // S-9: the settled path, composed. Every other test that asserts verdict
  // copy hands a literal HeadlineVerdict straight to the renderer; this one
  // makes the scorer produce `decision: "winner"` out of stored cells and
  // asserts the wording that actually reaches a client.
  it("renders a settled verdict end-to-end, in the wording M-9/M-9b left", async () => {
    const leader = await fx.provider({ name: `fx lead ${fx.suffix}`, model: "x" });
    const runnerUp = await fx.provider({ name: `fx runner ${fx.suffix}`, model: "x" });
    const org = `fx-settled-org-${fx.suffix}`;
    // Six calls: one over MIN_SHARED_CALLS_FOR_VERDICT, so a noise floor gets
    // drawn at all. No sourceTranscriberProvider on them, so production is
    // unknown here and the settled sentence carries no production clause --
    // production resolution is the first test in this file, not this one.
    const calls: Awaited<ReturnType<Fixtures["call"]>>[] = [];
    for (let i = 0; i < 6; i++) calls.push(await fx.call({ sourceAccountLabel: org }));
    const bulk = await fx.bulk({ providerIds: [leader.id, runnerUp.id] });
    const run = await fx.run({
      bulkId: bulk.id,
      callIds: calls.map((c) => c.id),
      providerIds: [leader.id, runnerUp.id],
      callCount: calls.length,
    });
    // The same transcript on every cell, so both providers are measured over
    // the same words on the same call. The runner-up is worse on EVERY call,
    // not on average: the noise floor is a paired bootstrap that resamples
    // calls with replacement, so a gap present in every pair survives every
    // resample and the 95% interval never reaches zero. That is what makes
    // this seed settle deterministically instead of by the bootstrap's luck.
    const transcript =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon";
    const leaderFlags = [1, 0, 1, 2, 1, 0];
    const runnerUpFlags = [4, 5, 3, 6, 4, 5];
    for (const [i, call] of calls.entries()) {
      const leaderCell = await fx.result(run.id, call.id, leader.id, { hypothesisTranscript: transcript });
      await fx.score(leaderCell.id, { peerFlagCount: leaderFlags[i] });
      const runnerUpCell = await fx.result(run.id, call.id, runnerUp.id, { hypothesisTranscript: transcript });
      await fx.score(runnerUpCell.id, { peerFlagCount: runnerUpFlags[i] });
    }

    // Precondition, and the whole reason this test is not vacuous: if the seed
    // ever drifts back under the five-call floor, the page renders "Nothing
    // decided" and every assertion below passes for the wrong reason.
    const json = await request(app).get(`/api/benchmark/bulks/${bulk.id}/verdicts`);
    expect(json.status).toBe(200);
    expect(json.body.groups).toHaveLength(1);
    expect(json.body.groups[0].verdict).toMatchObject({
      decision: "winner",
      winnerProviderId: leader.id,
      runnerUpProviderId: runnerUp.id,
    });

    const res = await request(app).get(`/api/benchmark/bulks/${bulk.id}/verdict.html`);
    expect(res.status).toBe(200);
    const html = res.text;
    // The row tag, exactly. The legend sentence also contains the word
    // "fewest", so a bare toContain("fewest") would still hold with the tag
    // renamed -- which is the thing this assertion exists to catch.
    expect(html).toContain('<span class="tag">fewest</span>');

    // `.chip.winner` in the stylesheet and class="chip winner" on the chip are
    // the decision ENUM, code and not copy; both come out before the wording
    // is judged, the same seam the M-9b unit guards use.
    const visible = html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/class="[^"]*"/g, "");
    expect(visible).toContain(`${leader.name} has the least disagreement`);
    expect(visible).toContain("1 decided");
    expect(visible).not.toMatch(/winner/i);
    expect(visible).not.toMatch(/\bwins\b/i);
  });

  it("answers 404 for an unknown bulk and a sentence for a malformed id", async () => {
    const unknown = await request(app).get("/api/benchmark/bulks/00000000-0000-4000-8000-000000000000/verdict.html");
    expect(unknown.status).toBe(404);

    const malformed = await request(app).get("/api/benchmark/bulks/not-a-uuid/verdict.html");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/bulkId/);
  });
});
