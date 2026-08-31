// T-164: GET /api/benchmark/bulks against the throwaway database. The
// Bulks page's top-level list: status filter and newest-first order are
// query logic, and the row shape crosses serializeBulk. Containment on
// this suite's own rows -- the bulks table is shared state.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();
let olderCompleteId: string;
let newerRunningId: string;

type BulkRow = { id: string; name: string; status: string; providerIds: string[]; shardSize: number };

async function listBulks(query: Record<string, string> = {}) {
  const res = await request(app).get("/api/benchmark/bulks").query(query);
  expect(res.status).toBe(200);
  return res.body as BulkRow[];
}

beforeAll(async () => {
  olderCompleteId = (
    await fx.bulk({
      status: "complete",
      providerIds: ["fx-list-provider"],
      createdAt: new Date(Date.now() - 2_000),
    })
  ).id;
  newerRunningId = (await fx.bulk({ status: "running" })).id;
});

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("GET /api/benchmark/bulks", () => {
  it("lists both seeded bulks newest first, with the serialized row shape", async () => {
    const rows = await listBulks();
    const mine = rows.filter((r) => [olderCompleteId, newerRunningId].includes(r.id));
    expect(mine.map((r) => r.id)).toEqual([newerRunningId, olderCompleteId]);

    const older = mine[1]!;
    expect(older).toMatchObject({
      id: olderCompleteId,
      status: "complete",
      providerIds: ["fx-list-provider"],
      shardSize: 50,
      minDurationSeconds: 0,
      maxDurationSeconds: null,
      launchedByLabel: null,
      notes: null,
    });
    expect(older.name).toContain(fx.suffix);
  });

  it("status filter narrows to exactly that status", async () => {
    const running = await listBulks({ status: "running" });
    expect(running.map((r) => r.id)).toContain(newerRunningId);
    expect(running.map((r) => r.id)).not.toContain(olderCompleteId);

    const complete = await listBulks({ status: "complete" });
    expect(complete.map((r) => r.id)).toContain(olderCompleteId);
    expect(complete.map((r) => r.id)).not.toContain(newerRunningId);
  });

  it("an unknown status answers a sentence, not the whole list", async () => {
    const res = await request(app).get("/api/benchmark/bulks").query({ status: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/);
  });
});
