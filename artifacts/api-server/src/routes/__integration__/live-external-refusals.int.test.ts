// T-175: the reads that stand in front of a live Vapi call --
// GET /api/benchmark/assistants/:assistantId/transcriber and
// GET /api/benchmark/vapi/assistants -- held on the half that never leaves
// this machine: the refusals. Which Vapi account owns an assistant is not
// stored anywhere; it is inferred from the org label its imported calls
// carry, and every way that inference can come up empty must answer a
// sentence rather than guess an account or crash.
//
// Every assertion is written to hold whether or not a VAPI key is in the
// environment (the T-168 rule): the labels seeded here can match no
// configured account, so nothing here can reach the network.
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

describe("GET /api/benchmark/assistants/:assistantId/transcriber", () => {
  it("refuses when no imported call carries the assistant", async () => {
    const res = await request(app).get(`/api/benchmark/assistants/fx-unknown-${fx.suffix}/transcriber`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No imported call carries this assistant id/);
  });

  it("names the majority org label when it matches no configured account", async () => {
    const assistantId = `fx-assist-${fx.suffix}`;
    const majority = `fx-org-major-${fx.suffix}`;
    const minority = `fx-org-minor-${fx.suffix}`;
    await fx.call({ sourceAssistantId: assistantId, sourceAccountLabel: majority });
    await fx.call({ sourceAssistantId: assistantId, sourceAccountLabel: majority });
    await fx.call({ sourceAssistantId: assistantId, sourceAccountLabel: minority });

    const res = await request(app).get(`/api/benchmark/assistants/${assistantId}/transcriber`);
    expect(res.status).toBe(404);
    // The label most of the assistant's calls carry decides, and the
    // refusal quotes it so the operator knows which env var is missing.
    expect(res.body.error).toContain(majority);
    expect(res.body.error).not.toContain(minority);
  });

  it("refuses rather than guessing when the calls carry no org label at all", async () => {
    const assistantId = `fx-assist-nolabel-${fx.suffix}`;
    await fx.call({ sourceAssistantId: assistantId, sourceAccountLabel: null });

    const res = await request(app).get(`/api/benchmark/assistants/${assistantId}/transcriber`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/matches no configured Vapi account/);
  });
});

describe("GET /api/benchmark/vapi/assistants", () => {
  it("refuses an unknown account id before any request leaves the machine", async () => {
    const res = await request(app).get("/api/benchmark/vapi/assistants").query({ accountId: `fx-no-such-${fx.suffix}` });
    expect(res.status).toBe(400);
    // Two honest messages depending on this machine's environment: the id
    // is unknown among the configured accounts, or nothing is configured
    // at all. Both are refusals, and neither reaches Vapi.
    expect(res.body.error).toMatch(/Unknown Vapi account|No Vapi accounts are configured/);
  });
});
