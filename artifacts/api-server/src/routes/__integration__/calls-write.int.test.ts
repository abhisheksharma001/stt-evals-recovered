// T-178: POST /api/benchmark/calls and POST /api/benchmark/calls/:callId/attest-deid
// against the throwaway database. The create is the manual way a call
// enters the corpus (import is the other, and it needs a live Vapi). The
// attestation is the FR-C3 compliance gate: two DISTINCT people must say a
// call is de-identified, and "Bob" then "bob" must not be two people --
// exactly the hole found while auditing this route on 2026-08-24.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("POST /api/benchmark/calls", () => {
  it("lands runnable, rounds the duration, and audits the creation", async () => {
    const res = await request(app)
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

    const audit = await request(app)
      .get("/api/benchmark/audit-log")
      .query({ entityType: "call", entityId: res.body.id });
    expect(audit.body).toHaveLength(1);
    expect(audit.body[0]).toMatchObject({ action: "create", actorLabel: fx.actor });
  });

  it("refuses a call with no label and an unknown vertical, naming the field", async () => {
    const noLabel = await request(app).post("/api/benchmark/calls").send({ vertical: "rush", durationSeconds: 30 });
    expect(noLabel.status).toBe(400);
    expect(noLabel.body.error).toMatch(/label/);

    const badVertical = await request(app)
      .post("/api/benchmark/calls")
      .send({ label: `fx-bad-${fx.suffix}`, vertical: "banking", durationSeconds: 30 });
    expect(badVertical.status).toBe(400);
    expect(badVertical.body.error).toMatch(/vertical/);
  });
});

describe("POST /api/benchmark/calls/:callId/attest-deid", () => {
  it("takes two distinct approvers and refuses the same person twice, whatever the casing", async () => {
    const call = await fx.call();
    const attest = (approverLabel: string) =>
      request(app).post(`/api/benchmark/calls/${call.id}/attest-deid`).send({ approverLabel });

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
    const audit = await request(app)
      .get("/api/benchmark/audit-log")
      .query({ entityType: "call", entityId: call.id });
    expect(audit.body.map((r: { action: string }) => r.action)).toEqual(["attest_deid_second", "attest_deid_first"]);
    expect(audit.body[1].actorLabel).toBe(`Bob-${fx.suffix}`);
  });

  it("answers 404 for an unknown call", async () => {
    const res = await request(app)
      .post("/api/benchmark/calls/00000000-0000-4000-8000-000000000000/attest-deid")
      .send({ approverLabel: `Bob-${fx.suffix}` });
    expect(res.status).toBe(404);
  });
});
