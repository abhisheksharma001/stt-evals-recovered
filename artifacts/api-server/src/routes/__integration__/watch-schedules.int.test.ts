// W-2: the watch-schedule CRUD -- GET/POST/PATCH
// /api/benchmark/watch-schedules -- against the throwaway database.
//
// A schedule is the policy row: which template, which Vapi account and agent,
// how many calls a day, and the two spend ceilings. What it REFUSES is the
// feature, because every field it stores is an instruction to spend money
// later: a sample size past 500, an account that is not configured, a
// template that does not exist.
//
// Nothing here launches anything, and nothing here talks to Vapi. The account
// this suite uses is a fake env var it sets itself, so the pass/fail does not
// depend on what happens to be in the operator's environment and no real key
// is ever read.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import { server } from "./server";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

// `listVapiAccounts()` derives an account id from the env-var NAME:
// VAPI_API_KEY_<LABEL> -> <label>, lowercased, underscores to dashes. The
// VALUE only has to be non-empty to make the account exist; it is never used
// by any route under test here.
const ACCOUNT_ENV = `VAPI_API_KEY_FXW2_${fx.suffix.toUpperCase()}`;
const ACCOUNT_ID = `fxw2-${fx.suffix}`;

beforeAll(() => {
  process.env[ACCOUNT_ENV] = "fixture-account-not-a-real-key";
});

afterAll(async () => {
  delete process.env[ACCOUNT_ENV];
  await fx.cleanup();
  await pool.end();
});

const auditFor = async (entityId: string) => {
  const res = await request(server)
    .get("/api/benchmark/audit-log")
    .query({ entityType: "watch_schedule", entityId });
  expect(res.status).toBe(200);
  return res.body as { action: string; actorLabel: string; beforeState: unknown; afterState: unknown }[];
};

/** A saved template to hang schedules off. Created through its own route so
 *  the fixture's cleanup finds it by actor. */
const makeTemplate = async (name: string): Promise<string> => {
  const res = await request(server)
    .post("/api/benchmark/bulk-templates")
    .set("x-actor", fx.actor)
    .send({ name, criteria: { vertical: "trucking" }, providerIds: [`fx-${fx.suffix}-p`] });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const create = (body: Record<string, unknown>) =>
  request(server).post("/api/benchmark/watch-schedules").set("x-actor", fx.actor).send(body);

const schedulesFor = async (templateId: string) => {
  const res = await request(server).get("/api/benchmark/watch-schedules");
  expect(res.status).toBe(200);
  return (res.body as { id: string; templateId: string }[]).filter((s) => s.templateId === templateId);
};

describe("watch schedules", () => {
  it("saves a policy with the column defaults, lists it, and audits the save", async () => {
    const templateId = await makeTemplate(`fx-w2-tpl-${fx.suffix}`);

    const made = await create({ templateId, accountId: ACCOUNT_ID, vertical: "trucking" });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      templateId,
      accountId: ACCOUNT_ID,
      vertical: "trucking",
      // Not sent, so the column's own defaults land on the row -- and null
      // assistantId means "every agent on this account", not "no agent".
      assistantId: null,
      sampleSize: 10,
      dailyCapCents: 100,
      monthlyCapCents: 3000,
      hourLocal: 3,
      enabled: true,
      createdByLabel: fx.actor,
    });

    expect((await schedulesFor(templateId)).map((s) => s.id)).toEqual([made.body.id]);

    const rows = await auditFor(made.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "create", actorLabel: fx.actor });
  });

  it("refuses a sample size past 500 and writes no row", async () => {
    const templateId = await makeTemplate(`fx-w2-tpl-max-${fx.suffix}`);

    const tooBig = await create({ templateId, accountId: ACCOUNT_ID, vertical: "rush", sampleSize: 501 });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toMatch(/sampleSize/);
    // The acceptance says "and no row SHALL exist" -- a 400 that still wrote
    // would leave a policy nobody agreed to.
    expect(await schedulesFor(templateId)).toEqual([]);

    // The boundary itself is allowed: 500 is a ceiling, not a wall one short.
    const atTheLine = await create({ templateId, accountId: ACCOUNT_ID, vertical: "rush", sampleSize: 500 });
    expect(atTheLine.status).toBe(201);
    expect(atTheLine.body.sampleSize).toBe(500);
  });

  it("refuses an unconfigured account by naming the known ids, and an unknown template", async () => {
    const templateId = await makeTemplate(`fx-w2-tpl-acct-${fx.suffix}`);

    const badAccount = await create({ templateId, accountId: "not-a-configured-account", vertical: "trucking" });
    expect(badAccount.status).toBe(400);
    expect(badAccount.body.error).toContain("not-a-configured-account");
    // Names ids and nothing else: an id comes from an env-var NAME, so it is
    // safe to say; the key's value, its prefix and its fingerprint are not.
    expect(badAccount.body.error).toContain(ACCOUNT_ID);
    expect(badAccount.body.error).not.toContain("fixture-account-not-a-real-key");
    expect(badAccount.body.error).not.toContain(ACCOUNT_ENV);
    expect(await schedulesFor(templateId)).toEqual([]);

    // A template that does not exist gets the sentence, not the FK violation.
    const ghost = await create({
      templateId: "00000000-0000-4000-8000-000000000000",
      accountId: ACCOUNT_ID,
      vertical: "trucking",
    });
    expect(ghost.status).toBe(400);
    expect(ghost.body.error).toMatch(/does not exist/);
  });

  it("patches only what was sent, keeps the before-state, and 404s on a schedule that is gone", async () => {
    const templateId = await makeTemplate(`fx-w2-tpl-patch-${fx.suffix}`);
    const made = await create({
      templateId,
      accountId: ACCOUNT_ID,
      vertical: "trucking",
      assistantId: "asst-fixture-1",
      sampleSize: 25,
    });
    expect(made.status).toBe(201);

    const patched = await request(server)
      .patch(`/api/benchmark/watch-schedules/${made.body.id}`)
      .set("x-actor", fx.actor)
      .send({ enabled: false, dailyCapCents: 250 });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      enabled: false,
      dailyCapCents: 250,
      // Untouched by a patch that never mentioned them.
      assistantId: "asst-fixture-1",
      sampleSize: 25,
      monthlyCapCents: 3000,
    });

    // `assistantId: null` is a real instruction -- widen back to every agent
    // on the account -- and must not read as "field not sent".
    const widened = await request(server)
      .patch(`/api/benchmark/watch-schedules/${made.body.id}`)
      .set("x-actor", fx.actor)
      .send({ assistantId: null });
    expect(widened.status).toBe(200);
    expect(widened.body.assistantId).toBeNull();
    expect(widened.body.enabled).toBe(false);

    const rows = await auditFor(made.body.id);
    expect(rows.map((r) => r.action)).toEqual(["update", "update", "create"]);
    expect((rows[0].beforeState as { assistantId: string }).assistantId).toBe("asst-fixture-1");

    const badAccount = await request(server)
      .patch(`/api/benchmark/watch-schedules/${made.body.id}`)
      .set("x-actor", fx.actor)
      .send({ accountId: "still-not-configured" });
    expect(badAccount.status).toBe(400);
    expect(badAccount.body.error).toContain(ACCOUNT_ID);

    const missing = await request(server)
      .patch("/api/benchmark/watch-schedules/00000000-0000-4000-8000-000000000000")
      .send({ enabled: true });
    expect(missing.status).toBe(404);

    const malformed = await request(server)
      .patch("/api/benchmark/watch-schedules/not-a-uuid")
      .send({ enabled: true });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/scheduleId/);
  });
});
