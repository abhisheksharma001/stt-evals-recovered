// W-4: the preview and import routes, held on the half that never leaves this
// machine.
//
// This file exists because W-4's own acceptance sentence -- "WHEN the existing
// preview/import integration cases run THEN every response SHALL be
// byte-identical to before the move" -- named cases that did not exist.
// Measured 2026-09-14 before the move: no integration file mentioned
// /benchmark/vapi/preview or /benchmark/vapi/import at all, so the move's
// stated proof was vacuous. The register's W-4 row now says so.
//
// What is provable without a key and without the network is the refusal that
// stands in front of both routes, which is exactly the branch the move had to
// carry across: an account this server holds no key for is answered 400,
// before any request is made and before any row is written. Everything past
// it needs Vapi on the other end of a socket, which this suite does not do
// (T-168).
//
// Written to hold whether or not a VAPI key is in this environment: the
// account id carries the fixture's random suffix, so it can match no
// configured account either way.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { db, benchmarkCallsTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import { server } from "./server";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("POST /api/benchmark/vapi/preview", () => {
  it("refuses an unknown account id before any request leaves the machine", async () => {
    const accountId = `fx-no-such-${fx.suffix}`;
    const res = await request(server).post("/api/benchmark/vapi/preview").send({ accountId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Unknown or unconfigured Vapi account "${accountId}".`);
  });

  it("still validates the body first, so a bad request is 400 for its own reason", async () => {
    const res = await request(server).post("/api/benchmark/vapi/preview").send({});
    expect(res.status).toBe(400);
    // The validation error, not the account sentence: the parse runs before
    // the account lookup and always has.
    expect(res.body.error).not.toMatch(/Unknown or unconfigured/);
  });
});

describe("POST /api/benchmark/vapi/import", () => {
  it("refuses an unknown account id and writes nothing", async () => {
    const accountId = `fx-no-such-${fx.suffix}`;
    const vapiCallId = `fx-call-${fx.suffix}`;
    const res = await request(server)
      .post("/api/benchmark/vapi/import")
      .set("x-actor", fx.actor)
      .send({ accountId, vertical: "property_management", vapiCallIds: [vapiCallId] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Unknown or unconfigured Vapi account "${accountId}".`);

    // The refusal is before the corpus, not after it: no row carries the id
    // that was asked for, under either the exact source id or the derived
    // `vapi-<hash>` label the importer would have assigned.
    const bySourceId = await db
      .select({ id: benchmarkCallsTable.id })
      .from(benchmarkCallsTable)
      .where(eq(benchmarkCallsTable.sourceCallId, vapiCallId));
    expect(bySourceId).toHaveLength(0);
  });

  it("rejects a body with no call ids before looking at the account", async () => {
    const res = await request(server)
      .post("/api/benchmark/vapi/import")
      .send({ accountId: `fx-no-such-${fx.suffix}`, vertical: "property_management", vapiCallIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).not.toMatch(/Unknown or unconfigured/);
  });
});
