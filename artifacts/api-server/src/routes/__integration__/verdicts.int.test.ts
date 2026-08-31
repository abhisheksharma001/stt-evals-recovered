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

  it("answers 404 for an unknown bulk and a sentence for a malformed id", async () => {
    const unknown = await request(app).get("/api/benchmark/bulks/00000000-0000-4000-8000-000000000000/verdict.html");
    expect(unknown.status).toBe(404);

    const malformed = await request(app).get("/api/benchmark/bulks/not-a-uuid/verdict.html");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/bulkId/);
  });
});
