// M-18: GET /api/benchmark/proxy-agreement against the throwaway database.
//
// The arithmetic is unit-tested in proxy-agreement-aggregate.test.ts. What
// can only go wrong here is the QUERY -- which calls count as labelled and
// which cells count as scored -- so that is all this file holds. Four ways
// to get it wrong, each with a seed that changes the answer if the filter
// is missing: a gold that is just the draft copied back, an agent-scan
// cell, a failed cell, and a call whose gold nobody scored.
//
// The endpoint is all-time and unscoped, so the figures are the whole test
// database's. The first case asserts the baseline is empty; if another file
// ever leaks a labelled call, this fails loudly rather than quietly
// averaging a stranger into the result.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import { server } from "./server";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("GET /api/benchmark/proxy-agreement", () => {
  it("answers zeros and nulls when nobody has written a gold transcript", async () => {
    const res = await request(server).get("/api/benchmark/proxy-agreement");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ labelledCalls: 0, n: 0, top1Agreement: null, kendallTau: null });
  });

  it("counts a human gold, ignores a copied one, and ranks over ok batch cells only", async () => {
    const run = await fx.run({ purpose: "batch" });
    // Agent scans re-transcribe a call to judge it and never feed a
    // ranking, so their cells must not move this figure.
    const agentRun = await fx.run({ purpose: "agent_scan" });
    const p1 = await fx.provider();
    const p2 = await fx.provider();
    const p3 = await fx.provider();
    const p4 = await fx.provider();

    // --- a call where the two orderings agree exactly -> tau +1, shared top-1
    const agree = await fx.call({ goldTranscript: "a person wrote this one", draftTranscript: "vapi wrote this" });
    for (const [provider, wer, flags] of [
      [p1, 0.1, 1],
      [p2, 0.2, 2],
      [p3, 0.3, 3],
    ] as const) {
      const cell = await fx.result(run.id, agree.id, provider.id);
      await fx.score(cell.id, { wer, peerFlagCount: flags });
    }
    // Best WER, worst flags, and FAILED. Counted, it would drag this call's
    // tau from +1 to 0.
    const failed = await fx.result(run.id, agree.id, p4.id, { status: "failed", failureClass: "provider_timeout" });
    await fx.score(failed.id, { wer: 0.001, peerFlagCount: 99 });
    // Same call, same provider, an agent-scan run. Counted, it would pull
    // p1's mean WER from 0.10 to 1.55 and make p1 the WORST of the three.
    const scan = await fx.result(agentRun.id, agree.id, p1.id);
    await fx.score(scan.id, { wer: 3.0, peerFlagCount: 1 });

    // --- a call where they are exactly opposed -> tau -1, no shared top-1
    const disagree = await fx.call({ goldTranscript: "also written by a person", draftTranscript: "vapi again" });
    for (const [provider, wer, flags] of [
      [p1, 0.1, 2],
      [p2, 0.2, 1],
    ] as const) {
      const cell = await fx.result(run.id, disagree.id, provider.id);
      await fx.score(cell.id, { wer, peerFlagCount: flags });
    }

    // --- gold identical to the draft: not a person's work. WER against it
    // measures agreement with Vapi, so the call is not labelled at all.
    const copied = await fx.call({ goldTranscript: "identical text", draftTranscript: "identical text" });
    for (const [provider, wer, flags] of [
      [p1, 0.9, 1],
      [p2, 0.1, 9],
    ] as const) {
      const cell = await fx.result(run.id, copied.id, provider.id);
      await fx.score(cell.id, { wer, peerFlagCount: flags });
    }

    // --- labelled, but nothing rankable: one has only an agent-scan cell,
    // the other only one provider. Both count as labelled and neither
    // contributes -- the gap between the two numbers is the point.
    const scannedOnly = await fx.call({ goldTranscript: "labelled but only scanned", draftTranscript: "draft" });
    const scannedCell = await fx.result(agentRun.id, scannedOnly.id, p1.id);
    await fx.score(scannedCell.id, { wer: 0.4, peerFlagCount: 4 });

    const oneProvider = await fx.call({ goldTranscript: "labelled, one provider ran", draftTranscript: "draft" });
    const loneCell = await fx.result(run.id, oneProvider.id, p1.id);
    await fx.score(loneCell.id, { wer: 0.4, peerFlagCount: 4 });

    const res = await request(server).get("/api/benchmark/proxy-agreement");
    expect(res.status).toBe(200);
    // Four labelled calls; the copied gold is not one of them.
    expect(res.body.labelledCalls).toBe(4);
    // Two of the four could be ranked two ways.
    expect(res.body.n).toBe(2);
    // (+1 from `agree`, -1 from `disagree`) / 2. Any of the four filters
    // missing moves this off zero.
    expect(res.body.kendallTau).toBeCloseTo(0, 10);
    // Shared top-1 on one of the two.
    expect(res.body.top1Agreement).toBeCloseTo(0.5, 10);
  });
});
