// T-160: GET /api/benchmark/calls against the throwaway database. The
// corpus list feeds Corpus and every picker; its filters and its newest-
// first order are query logic the compile check cannot see. Assertions are
// containment on this suite's own rows -- the corpus is shared state.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();
let rushId: string;
let archivedId: string;
let truckingId: string;

async function listCalls(query: Record<string, string> = {}) {
  const res = await request(app).get("/api/benchmark/calls").query(query);
  expect(res.status).toBe(200);
  return res.body as { id: string; vertical: string; status: string; audioCached: boolean }[];
}

beforeAll(async () => {
  rushId = (await fx.call({ vertical: "rush", status: "ready_to_run" })).id;
  archivedId = (await fx.call({ vertical: "rush", status: "archived" })).id;
  truckingId = (await fx.call({ vertical: "trucking", status: "ready_to_run" })).id;
});

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("GET /api/benchmark/calls", () => {
  it("unfiltered list contains all three seeded calls, newest first", async () => {
    const rows = await listCalls();
    const mine = rows.filter((r) => [rushId, archivedId, truckingId].includes(r.id));
    // Insert order was rush, archived, trucking -- newest first reverses it.
    expect(mine.map((r) => r.id)).toEqual([truckingId, archivedId, rushId]);
  });

  it("vertical and status filters narrow independently and combine", async () => {
    const rush = await listCalls({ vertical: "rush" });
    expect(rush.some((r) => r.id === rushId)).toBe(true);
    expect(rush.some((r) => r.id === truckingId)).toBe(false);
    expect(rush.every((r) => r.vertical === "rush")).toBe(true);

    const archived = await listCalls({ status: "archived" });
    expect(archived.some((r) => r.id === archivedId)).toBe(true);
    expect(archived.some((r) => r.id === rushId)).toBe(false);

    const both = await listCalls({ vertical: "rush", status: "ready_to_run" });
    expect(both.some((r) => r.id === rushId)).toBe(true);
    expect(both.some((r) => r.id === archivedId)).toBe(false);
  });

  it("rejects an unknown vertical with a sentence, not silently returning everything", async () => {
    const res = await request(app).get("/api/benchmark/calls").query({ vertical: "haulage" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vertical/);
  });

  it("decorates a seeded call with audioCached: false -- no bytes on this disk", async () => {
    const rows = await listCalls({ vertical: "trucking" });
    const mine = rows.find((r) => r.id === truckingId);
    expect(mine?.audioCached).toBe(false);
  });
});
