// T-177: the bulk-template CRUD -- GET/POST/DELETE /api/benchmark/bulk-templates
// -- against the throwaway database. A template is a saved bulk recipe, so
// what it stores and what it refuses IS the feature: an unfrozen criteria
// blob, a duration band resolved once at save time, a name that must stay
// unique, and a delete that is undoable only from the audit trail. Launch
// is deliberately absent: it spends provider money.
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

const auditFor = async (entityId: string) => {
  const res = await request(app).get("/api/benchmark/audit-log").query({ entityType: "bulk_template", entityId });
  expect(res.status).toBe(200);
  return res.body as { action: string; actorLabel: string; beforeState: unknown }[];
};

const create = (name: string, body: Record<string, unknown> = {}) =>
  request(app)
    .post("/api/benchmark/bulk-templates")
    .set("x-actor", fx.actor)
    .send({ name, criteria: { vertical: "trucking" }, providerIds: [`fx-${fx.suffix}-p`], ...body });

describe("bulk templates", () => {
  it("saves a recipe with its resolved band, lists it by name, and audits the save", async () => {
    const second = await create(`fx-tpl-b-${fx.suffix}`, { shardSize: 10, minDurationSeconds: 30, maxDurationSeconds: 90 });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({
      name: `fx-tpl-b-${fx.suffix}`,
      // The request says `criteria`; the row and the response say
      // `selectionCriteria` -- checked against the response, not memory.
      selectionCriteria: { vertical: "trucking" },
      providerIds: [`fx-${fx.suffix}-p`],
      shardSize: 10,
      minDurationSeconds: 30,
      maxDurationSeconds: 90,
    });

    // Saved second, sorts first: the list is by name, not by age.
    const first = await create(`fx-tpl-a-${fx.suffix}`);
    expect(first.status).toBe(201);
    // Defaults land on the row, not on the caller: shard size 50.
    expect(first.body.shardSize).toBe(50);

    const list = await request(app).get("/api/benchmark/bulk-templates");
    expect(list.status).toBe(200);
    const mine = list.body
      .map((t: { id: string }) => t.id)
      .filter((id: string) => [first.body.id, second.body.id].includes(id));
    expect(mine).toEqual([first.body.id, second.body.id]);

    const rows = await auditFor(second.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "create", actorLabel: fx.actor });
  });

  it("refuses a duplicate name and an upside-down duration band", async () => {
    const name = `fx-tpl-dup-${fx.suffix}`;
    expect((await create(name)).status).toBe(201);

    const duplicate = await create(name);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toContain(name);

    const band = await create(`fx-tpl-band-${fx.suffix}`, { minDurationSeconds: 120, maxDurationSeconds: 30 });
    expect(band.status).toBe(400);
    expect(band.body.error).toMatch(/must be >= minDurationSeconds/);
  });

  it("deletes once, keeps the before-state in the audit trail, then 404s", async () => {
    const made = await create(`fx-tpl-del-${fx.suffix}`);
    expect(made.status).toBe(201);

    const deleted = await request(app)
      .delete(`/api/benchmark/bulk-templates/${made.body.id}`)
      .set("x-actor", fx.actor);
    expect(deleted.status).toBe(204);

    const list = await request(app).get("/api/benchmark/bulk-templates");
    expect(list.body.map((t: { id: string }) => t.id)).not.toContain(made.body.id);

    // T-50: the recipe is gone, but what it was is still recoverable.
    const rows = await auditFor(made.body.id);
    expect(rows.map((r) => r.action)).toEqual(["delete", "create"]);
    expect((rows[0].beforeState as { name: string }).name).toBe(`fx-tpl-del-${fx.suffix}`);

    const again = await request(app).delete(`/api/benchmark/bulk-templates/${made.body.id}`);
    expect(again.status).toBe(404);

    const malformed = await request(app).delete("/api/benchmark/bulk-templates/not-a-uuid");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/templateId/);
  });
});
