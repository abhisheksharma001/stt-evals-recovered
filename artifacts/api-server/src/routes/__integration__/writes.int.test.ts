// T-176: the three writes that change stored state without spending a
// cent -- PATCH /api/benchmark/calls/:callId, PATCH /api/benchmark/settings
// and the agent-scan approve / reject decisions -- against the throwaway
// database. Batch 16 swept these routes for how they refuse bad input;
// what was never held is that a good request actually lands AND leaves the
// append-only audit row NFR-5 promises. Nothing here touches run
// execution, so no provider adapter can fire.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { APP_SETTINGS_ID, appSettingsTable, db, pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

// The settings row is a shared singleton, so this suite puts it back.
let originalSettings: { activeProviderId: string | null; agentModel: string | null } | null = null;

const auditFor = async (entityType: string, entityId: string) => {
  const res = await request(app).get("/api/benchmark/audit-log").query({ entityType, entityId });
  expect(res.status).toBe(200);
  return res.body as { action: string; actorLabel: string; beforeState: unknown; afterState: unknown }[];
};

beforeAll(async () => {
  const res = await request(app).get("/api/benchmark/settings");
  originalSettings = res.body;
});

afterAll(async () => {
  if (originalSettings) {
    await db
      .update(appSettingsTable)
      .set({ activeProviderId: originalSettings.activeProviderId, agentModel: originalSettings.agentModel })
      .where(eq(appSettingsTable.id, APP_SETTINGS_ID));
  }
  await fx.cleanup();
  await pool.end();
});

describe("PATCH /api/benchmark/calls/:callId", () => {
  it("lands the change and writes the before/after audit row", async () => {
    const call = await fx.call({ status: "needs_review", entityNotes: null });

    const res = await request(app)
      .patch(`/api/benchmark/calls/${call.id}`)
      .set("x-actor", fx.actor)
      .send({ status: "ready_to_run", entityNotes: `checked ${fx.suffix}`, hardCases: ["accent"] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: call.id,
      status: "ready_to_run",
      entityNotes: `checked ${fx.suffix}`,
      hardCases: ["accent"],
    });

    // Persisted, not just echoed.
    const reread = await request(app).get(`/api/benchmark/calls/${call.id}`);
    expect(reread.body).toMatchObject({ status: "ready_to_run", hardCases: ["accent"] });

    // NFR-5: the transition is recoverable from the audit trail alone --
    // who, what it was, what it became.
    const rows = await auditFor("call", call.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "update", actorLabel: fx.actor });
    expect((rows[0].beforeState as { status: string }).status).toBe("needs_review");
    expect((rows[0].afterState as { status: string }).status).toBe("ready_to_run");
  });

  it("answers 404 for an unknown call, 400 for a malformed id, and writes nothing", async () => {
    const unknown = await request(app)
      .patch("/api/benchmark/calls/00000000-0000-4000-8000-000000000000")
      .set("x-actor", fx.actor)
      .send({ status: "archived" });
    expect(unknown.status).toBe(404);
    expect(await auditFor("call", "00000000-0000-4000-8000-000000000000")).toEqual([]);

    const malformed = await request(app).patch("/api/benchmark/calls/not-a-uuid").send({ status: "archived" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/callId/);
  });
});

describe("PATCH /api/benchmark/settings", () => {
  it("sets a known provider, clears with null, and audits both", async () => {
    const provider = await fx.provider();

    const set = await request(app)
      .patch("/api/benchmark/settings")
      .set("x-actor", fx.actor)
      .send({ activeProviderId: provider.id });
    expect(set.status).toBe(200);
    expect(set.body.activeProviderId).toBe(provider.id);

    // An empty agentModel means "no override", which is null, not "".
    const cleared = await request(app)
      .patch("/api/benchmark/settings")
      .set("x-actor", fx.actor)
      .send({ activeProviderId: null, agentModel: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ activeProviderId: null, agentModel: null });

    const rows = (await auditFor("app_settings", APP_SETTINGS_ID)).filter((r) => r.actorLabel === fx.actor);
    expect(rows).toHaveLength(2);
    expect(rows[0].action).toBe("update");
  });

  it("refuses a body that changes nothing and an unknown provider id", async () => {
    const nothing = await request(app).patch("/api/benchmark/settings").set("x-actor", fx.actor).send({});
    expect(nothing.status).toBe(400);
    expect(nothing.body.error).toMatch(/Name at least one setting/);

    // A body whose only field is a typo is the same case: zod strips it.
    const typo = await request(app).patch("/api/benchmark/settings").set("x-actor", fx.actor).send({ judgeModel: "x" });
    expect(typo.status).toBe(400);

    const unknown = await request(app)
      .patch("/api/benchmark/settings")
      .set("x-actor", fx.actor)
      .send({ activeProviderId: `fx-no-such-${fx.suffix}` });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain(`fx-no-such-${fx.suffix}`);
  });
});

describe("POST /api/benchmark/agent/scans/:scanId/approve | reject", () => {
  it("records the decision once and refuses to decide it twice", async () => {
    const call = await fx.call();
    const flagged = await fx.scan(call.id, { status: "flagged", agentPickReasoning: "reads better" });

    const approved = await request(app)
      .post(`/api/benchmark/agent/scans/${flagged.id}/approve`)
      .send({ approverLabel: fx.actor });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ id: flagged.id, status: "approved", decidedByLabel: fx.actor });
    expect(approved.body.decidedAt).not.toBeNull();

    // Approve is an acknowledgment, not a gold write: the decision is in
    // the audit trail and nowhere else.
    const rows = await auditFor("agent_scan", flagged.id);
    expect(rows.map((r) => r.action)).toEqual(["approved"]);

    // Already decided: neither route may quietly overwrite it.
    const again = await request(app)
      .post(`/api/benchmark/agent/scans/${flagged.id}/approve`)
      .send({ approverLabel: fx.actor });
    expect(again.status).toBe(409);
    const rejectAfter = await request(app)
      .post(`/api/benchmark/agent/scans/${flagged.id}/reject`)
      .send({ approverLabel: fx.actor });
    expect(rejectAfter.status).toBe(409);
    expect(rejectAfter.body.error).toMatch(/already decided/);
  });

  it("refuses to approve a scan that found nothing, and 404s an unknown scan", async () => {
    const call = await fx.call();
    const clean = await fx.scan(call.id, { status: "clean" });

    const res = await request(app)
      .post(`/api/benchmark/agent/scans/${clean.id}/approve`)
      .send({ approverLabel: fx.actor });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not awaiting a decision/);

    const unknown = await request(app)
      .post("/api/benchmark/agent/scans/00000000-0000-4000-8000-000000000000/approve")
      .send({ approverLabel: fx.actor });
    expect(unknown.status).toBe(404);
  });
});
