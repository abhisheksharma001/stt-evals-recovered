// T-178: the write routes on a single call -- POST /api/benchmark/calls,
// PATCH /api/benchmark/calls/:callId (R-21's gold guard) and POST /api/benchmark/calls/:callId/attest-deid
// against the throwaway database. The create is the manual way a call
// enters the corpus (import is the other, and it needs a live Vapi). The
// attestation is the FR-C3 compliance gate: two DISTINCT people must say a
// call is de-identified, and "Bob" then "bob" must not be two people --
// exactly the hole found while auditing this route on 2026-08-24.
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

describe("POST /api/benchmark/calls", () => {
  it("lands runnable, rounds the duration, and audits the creation", async () => {
    const res = await request(server)
      .post("/api/benchmark/calls")
      .set("x-actor", fx.actor)
      .send({
        label: `fx-created-${fx.suffix}`,
        vertical: "rush",
        // Vapi reports fractional seconds; the column is an integer.
        durationSeconds: 30.7,
        entityNotes: `notes ${fx.suffix}`,
      });
    expect(res.status).toBe(201);
    fx.adoptCall(res.body.id);
    expect(res.body).toMatchObject({
      label: `fx-created-${fx.suffix}`,
      vertical: "rush",
      durationSeconds: 31,
      // The de-id gate was removed 2026-08-27: a call is runnable the
      // moment it exists, not after a review step that gates nothing.
      status: "ready_to_run",
      hardCases: [],
      entityReferences: [],
      entityNotes: `notes ${fx.suffix}`,
    });

    const audit = await request(server)
      .get("/api/benchmark/audit-log")
      .query({ entityType: "call", entityId: res.body.id });
    expect(audit.body).toHaveLength(1);
    expect(audit.body[0]).toMatchObject({ action: "create", actorLabel: fx.actor });
  });

  it("refuses a call with no label and an unknown vertical, naming the field", async () => {
    const noLabel = await request(server).post("/api/benchmark/calls").send({ vertical: "rush", durationSeconds: 30 });
    expect(noLabel.status).toBe(400);
    expect(noLabel.body.error).toMatch(/label/);

    const badVertical = await request(server)
      .post("/api/benchmark/calls")
      .send({ label: `fx-bad-${fx.suffix}`, vertical: "banking", durationSeconds: 30 });
    expect(badVertical.status).toBe(400);
    expect(badVertical.body.error).toMatch(/vertical/);
  });
});

// R-21: the labelled set is one call. Until this guard existed,
// {"goldTranscript":""} was an ordinary accepted request that emptied it.
describe("PATCH /api/benchmark/calls/:callId -- the gold clear guard", () => {
  const GOLD = "the unit number is two zero four and the gate code is nine one one";

  const patch = (callId: string, body: Record<string, unknown>) =>
    request(server).patch(`/api/benchmark/calls/${callId}`).set("x-actor", fx.actor).send(body);

  it("refuses to empty a gold that has text, and leaves the text where it was", async () => {
    const call = await fx.call({ goldTranscript: GOLD });

    const res = await patch(call.id, { goldTranscript: "" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/confirmClearGold/);

    // The refusal is only worth anything if the row is untouched. Read it
    // back rather than trusting the status code.
    const after = await request(server).get(`/api/benchmark/calls/${call.id}`);
    expect(after.body.goldTranscript).toBe(GOLD);
  });

  it("counts whitespace as empty -- a gold of spaces is a gold that is gone", async () => {
    const call = await fx.call({ goldTranscript: GOLD });
    const res = await patch(call.id, { goldTranscript: "   \n  " });
    expect(res.status).toBe(409);

    const after = await request(server).get(`/api/benchmark/calls/${call.id}`);
    expect(after.body.goldTranscript).toBe(GOLD);
  });

  it("clears it when the caller says so, and the old text survives in the trail", async () => {
    const call = await fx.call({ goldTranscript: GOLD });

    const res = await patch(call.id, { goldTranscript: "", confirmClearGold: true });
    expect(res.status).toBe(200);
    expect(res.body.goldTranscript).toBe("");
    // The flag is a request flag. It must not appear on the row it authorised.
    expect(res.body).not.toHaveProperty("confirmClearGold");

    const audit = await request(server)
      .get("/api/benchmark/audit-log")
      .query({ entityType: "call", entityId: call.id });
    expect(audit.body[0].beforeState.goldTranscript).toBe(GOLD);
    expect(audit.body[0].afterState.goldTranscript).toBe("");
  });

  it("does not stand between a gold and a better gold", async () => {
    const call = await fx.call({ goldTranscript: GOLD });
    const res = await patch(call.id, { goldTranscript: `${GOLD} please` });
    expect(res.status).toBe(200);
    expect(res.body.goldTranscript).toBe(`${GOLD} please`);
  });

  it("asks nothing when there was no gold to lose", async () => {
    const call = await fx.call();
    expect(call.goldTranscript).toBeNull();
    const res = await patch(call.id, { goldTranscript: "" });
    expect(res.status).toBe(200);
  });

  it("leaves a request that never mentions gold alone", async () => {
    const call = await fx.call({ goldTranscript: GOLD });
    const res = await patch(call.id, { status: "gold_in_review" });
    expect(res.status).toBe(200);
    expect(res.body.goldTranscript).toBe(GOLD);
  });
});

describe("POST /api/benchmark/calls/:callId/attest-deid", () => {
  it("takes two distinct approvers and refuses the same person twice, whatever the casing", async () => {
    const call = await fx.call();
    const attest = (approverLabel: string) =>
      request(server).post(`/api/benchmark/calls/${call.id}/attest-deid`).send({ approverLabel });

    const first = await attest(`Bob-${fx.suffix}`);
    expect(first.status).toBe(200);
    expect(first.body.deIdAttestedByLabel).toBe(`Bob-${fx.suffix}`);
    expect(first.body.deIdSecondApproverLabel).toBeNull();

    // The same person in different clothes: case-folded on both sides, or
    // one person could satisfy a two-person gate on their own.
    const sameName = await attest(`bob-${fx.suffix}`);
    expect(sameName.status).toBe(409);
    expect(sameName.body.error).toMatch(/same approver/);

    const second = await attest(`Ann-${fx.suffix}`);
    expect(second.status).toBe(200);
    expect(second.body.deIdSecondApproverLabel).toBe(`Ann-${fx.suffix}`);

    const third = await attest(`Cara-${fx.suffix}`);
    expect(third.status).toBe(409);
    expect(third.body.error).toMatch(/already has two/);

    // Both attestations are in the trail under the approver's own name,
    // newest first.
    const audit = await request(server)
      .get("/api/benchmark/audit-log")
      .query({ entityType: "call", entityId: call.id });
    expect(audit.body.map((r: { action: string }) => r.action)).toEqual(["attest_deid_second", "attest_deid_first"]);
    expect(audit.body[1].actorLabel).toBe(`Bob-${fx.suffix}`);
  });

  it("answers 404 for an unknown call", async () => {
    const res = await request(server)
      .post("/api/benchmark/calls/00000000-0000-4000-8000-000000000000/attest-deid")
      .send({ approverLabel: `Bob-${fx.suffix}` });
    expect(res.status).toBe(404);
  });

  // R-53. The contract's `minLength: 2` counts characters, and two spaces are
  // two characters -- so a blank approver reached the handler, was trimmed to
  // "", and was stored as the person who attested that a caller's recording
  // carries no PII. That is the one field on this route that matters.
  it("refuses a blank approver and attests nothing", async () => {
    const call = await fx.call();
    const attest = (approverLabel: string) =>
      request(server).post(`/api/benchmark/calls/${call.id}/attest-deid`).send({ approverLabel });

    const spaces = await attest("   ");
    expect(spaces.status).toBe(400);
    expect(spaces.body.error).toMatch(/approverLabel is blank/);

    const tab = await attest("\t\n");
    expect(tab.status).toBe(400);

    // "" never gets that far -- the contract's minLength stops it -- but it
    // must still be a 400 and must still attest nothing.
    const empty = await attest("");
    expect(empty.status).toBe(400);

    const after = await request(server).get(`/api/benchmark/calls/${call.id}`);
    expect(after.body.deIdAttestedByLabel).toBeNull();
    expect(after.body.deIdAttestedAt).toBeNull();

    const audit = await request(server)
      .get("/api/benchmark/audit-log")
      .query({ entityType: "call", entityId: call.id });
    expect(audit.body).toEqual([]);

    // A real name still works right after -- the refusal left no state behind.
    const real = await attest(`  Bob-${fx.suffix}  `);
    expect(real.status).toBe(200);
    expect(real.body.deIdAttestedByLabel).toBe(`Bob-${fx.suffix}`);
  });
});
