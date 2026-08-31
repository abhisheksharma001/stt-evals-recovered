// T-170: GET /api/benchmark/agent/scans and GET /api/benchmark/audit-log
// against the throwaway database. Both are plain filtered lists, which is
// exactly why they go untested: a broken filter still answers 200 with the
// wrong rows. Assertions are containment on this suite's own rows.
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

describe("GET /api/benchmark/agent/scans", () => {
  it("callId narrows to that call's scans, newest first", async () => {
    const mine = await fx.call();
    const other = await fx.call();
    const olderScan = await fx.scan(mine.id, { status: "clean", createdAt: new Date(Date.now() - 60_000) });
    const newerScan = await fx.scan(mine.id, { status: "flagged", agentPickReasoning: "newer" });
    const otherScan = await fx.scan(other.id, { status: "clean" });

    const res = await request(app).get("/api/benchmark/agent/scans").query({ callId: mine.id });
    expect(res.status).toBe(200);
    expect(res.body.map((s: { id: string }) => s.id)).toEqual([newerScan.id, olderScan.id]);
    expect(res.body.map((s: { id: string }) => s.id)).not.toContain(otherScan.id);
    expect(res.body[0]).toMatchObject({ callId: mine.id, status: "flagged" });

    const all = await request(app).get("/api/benchmark/agent/scans");
    expect(all.status).toBe(200);
    const allIds = all.body.map((s: { id: string }) => s.id);
    expect(allIds).toContain(otherScan.id);
  });

  it("a malformed callId answers a sentence", async () => {
    const res = await request(app).get("/api/benchmark/agent/scans").query({ callId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/callId/);
  });
});

describe("GET /api/benchmark/audit-log", () => {
  it("entityType and entityId narrow independently and combine, newest first", async () => {
    const entityA = `fx-entity-a-${fx.suffix}`;
    const entityB = `fx-entity-b-${fx.suffix}`;
    const callOnA = await fx.audit({
      entityType: "call",
      entityId: entityA,
      occurredAt: new Date(Date.now() - 60_000),
    });
    const callOnB = await fx.audit({ entityType: "call", entityId: entityB });
    const providerOnA = await fx.audit({ entityType: "provider", entityId: entityA });
    const mineIds = [callOnA.id, callOnB.id, providerOnA.id];
    const mineOf = (body: { id: string }[]) => body.map((r) => r.id).filter((id) => mineIds.includes(id));

    const unfiltered = await request(app).get("/api/benchmark/audit-log");
    expect(unfiltered.status).toBe(200);
    expect(mineOf(unfiltered.body).sort()).toEqual([...mineIds].sort());

    const byType = await request(app).get("/api/benchmark/audit-log").query({ entityType: "call" });
    // Newest first: callOnB was written after callOnA.
    expect(mineOf(byType.body)).toEqual([callOnB.id, callOnA.id]);

    const byId = await request(app).get("/api/benchmark/audit-log").query({ entityId: entityA });
    expect(mineOf(byId.body)).toEqual([providerOnA.id, callOnA.id]);

    const combined = await request(app)
      .get("/api/benchmark/audit-log")
      .query({ entityType: "call", entityId: entityA });
    expect(mineOf(combined.body)).toEqual([callOnA.id]);
    // The row answers its audit fields, before/after state included.
    const row = combined.body.find((r: { id: string }) => r.id === callOnA.id);
    expect(row).toMatchObject({ entityType: "call", entityId: entityA, action: "fixture" });
  });
});
