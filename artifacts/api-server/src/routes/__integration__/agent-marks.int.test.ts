// U-1: /api/benchmark/agent-marks against the throwaway database.
//
// The two rules worth a suite are the ones the OpenAPI contract cannot
// express: a note that is only whitespace, and an action pair that does not
// make sense (numerals carrying a value, keyterm carrying none). Both would
// otherwise be stored happily and only fail much later, in U-2, when
// something tries to turn the mark into a change.
//
// The third is the FK: a mark outlives the call that prompted it
// (`onDelete: "set null"`), which is the opposite of what benchmark_agent_scans
// does on the same column, so it is worth proving rather than trusting.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { agentMarksTable, benchmarkCallsTable, db, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import { server } from "./server";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

const post = (body: Record<string, unknown>) =>
  request(server).post("/api/benchmark/agent-marks").set("x-actor", fx.actor).send(body);

describe("POST /api/benchmark/agent-marks", () => {
  it("stores a note with no action at all, and GET returns it", async () => {
    const call = await fx.call();
    const created = await post({
      assistantId: `asst-${fx.suffix}`,
      callId: call.id,
      span: "four one three",
      note: "the numbers come back different every time",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      assistantId: `asst-${fx.suffix}`,
      callId: call.id,
      span: "four one three",
      note: "the numbers come back different every time",
      actionType: null,
      actionValue: null,
      status: "open",
      createdByLabel: fx.actor,
    });

    const listed = await request(server)
      .get("/api/benchmark/agent-marks")
      .query({ assistantId: `asst-${fx.suffix}` });
    expect(listed.status).toBe(200);
    expect(listed.body.map((m: { id: string }) => m.id)).toEqual([created.body.id]);
  });

  it("refuses a note that is only whitespace", async () => {
    const res = await post({ note: "   \n  " });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/needs a note/);
  });

  it("refuses a numerals mark that carries a value", async () => {
    const res = await post({ note: "turn digits on", actionType: "numerals", actionValue: "413" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/numerals/);
  });

  it("refuses a keyterm mark that carries no value", async () => {
    const res = await post({ note: "boost this", actionType: "keyterm" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/actionValue/);
  });

  it("accepts a keyterm mark with a value, and a numerals mark without one", async () => {
    const keyterm = await post({ note: "the street name", actionType: "keyterm", actionValue: "Edison Hills" });
    expect(keyterm.status).toBe(201);
    expect(keyterm.body).toMatchObject({ actionType: "keyterm", actionValue: "Edison Hills" });

    const numerals = await post({ note: "spelled digits everywhere", actionType: "numerals" });
    expect(numerals.status).toBe(201);
    expect(numerals.body).toMatchObject({ actionType: "numerals", actionValue: null });
  });

  it("takes the assistant from the call when the body does not name one", async () => {
    // U-1b: the comparison view holds the disputed span but not the
    // assistant, so the server derives the basket key rather than trusting a
    // client that cannot know it.
    const assistantId = `asst-derived-${fx.suffix}`;
    const call = await fx.call({ sourceAssistantId: assistantId });
    const mark = await post({ callId: call.id, span: "Edison Hills", note: "street name, every time" });
    expect(mark.status).toBe(201);
    expect(mark.body.assistantId).toBe(assistantId);

    const listed = await request(server).get("/api/benchmark/agent-marks").query({ assistantId });
    expect(listed.body.map((m: { id: string }) => m.id)).toEqual([mark.body.id]);
  });

  it("leaves the assistant null when the call was imported without one", async () => {
    const call = await fx.call({ sourceAssistantId: null });
    const mark = await post({ callId: call.id, note: "no agent on file for this one" });
    expect(mark.status).toBe(201);
    expect(mark.body.assistantId).toBeNull();

    const unassigned = await request(server)
      .get("/api/benchmark/agent-marks")
      .query({ assistantId: "__unassigned__" });
    expect(unassigned.body.map((m: { id: string }) => m.id)).toContain(mark.body.id);
  });

  it("an explicitly sent assistantId wins over the call's own", async () => {
    const call = await fx.call({ sourceAssistantId: `asst-on-call-${fx.suffix}` });
    const chosen = `asst-chosen-${fx.suffix}`;
    const mark = await post({ callId: call.id, assistantId: chosen, note: "filed elsewhere on purpose" });
    expect(mark.status).toBe(201);
    expect(mark.body.assistantId).toBe(chosen);
  });

  it("refuses a callId that names no call", async () => {
    const res = await post({ note: "orphan", callId: "00000000-0000-4000-8000-000000000000" });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/benchmark/agent-marks", () => {
  it("__unassigned__ reaches exactly the marks with no assistant, which assistantId filters cannot", async () => {
    const assigned = await post({ assistantId: `asst-b-${fx.suffix}`, note: "has an agent" });
    const unassigned = await post({ note: "no agent on file" });
    expect(assigned.status).toBe(201);
    expect(unassigned.status).toBe(201);

    const byAssistant = await request(server)
      .get("/api/benchmark/agent-marks")
      .query({ assistantId: `asst-b-${fx.suffix}` });
    expect(byAssistant.body.map((m: { id: string }) => m.id)).toEqual([assigned.body.id]);

    const none = await request(server).get("/api/benchmark/agent-marks").query({ assistantId: "__unassigned__" });
    const ids = none.body.map((m: { id: string }) => m.id);
    expect(ids).toContain(unassigned.body.id);
    expect(ids).not.toContain(assigned.body.id);
  });

  it("status narrows to dismissed once a mark is dismissed", async () => {
    const assistantId = `asst-c-${fx.suffix}`;
    const kept = await post({ assistantId, note: "still to do" });
    const dropped = await post({ assistantId, note: "changed my mind" });

    const patched = await request(server)
      .patch(`/api/benchmark/agent-marks/${dropped.body.id}`)
      .set("x-actor", fx.actor)
      .send({ status: "dismissed" });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe("dismissed");

    const open = await request(server).get("/api/benchmark/agent-marks").query({ assistantId, status: "open" });
    expect(open.body.map((m: { id: string }) => m.id)).toEqual([kept.body.id]);
  });
});

describe("PATCH /api/benchmark/agent-marks/:markId", () => {
  it("validates the pair the row ends up with, not the half that was sent", async () => {
    const mark = await post({ note: "boost it", actionType: "keyterm", actionValue: "Parkville" });
    expect(mark.status).toBe(201);

    // Clearing the value of an existing keyterm mark is as broken as
    // creating one without it -- and the body alone does not say so.
    const cleared = await request(server)
      .patch(`/api/benchmark/agent-marks/${mark.body.id}`)
      .set("x-actor", fx.actor)
      .send({ actionValue: null });
    expect(cleared.status).toBe(400);
    expect(cleared.body.error).toMatch(/actionValue/);

    // The same applies the other way: switching an existing valued mark to
    // numerals leaves a value behind.
    const switched = await request(server)
      .patch(`/api/benchmark/agent-marks/${mark.body.id}`)
      .set("x-actor", fx.actor)
      .send({ actionType: "numerals" });
    expect(switched.status).toBe(400);
    expect(switched.body.error).toMatch(/numerals/);
  });

  it("refuses to mark a mark applied -- only something that wrote may claim that", async () => {
    const mark = await post({ note: "not applied by hand" });
    const res = await request(server)
      .patch(`/api/benchmark/agent-marks/${mark.body.id}`)
      .set("x-actor", fx.actor)
      .send({ status: "applied" });
    expect(res.status).toBe(400);

    const after = await request(server).get("/api/benchmark/agent-marks").query({ callId: undefined });
    const row = after.body.find((m: { id: string }) => m.id === mark.body.id);
    expect(row.status).toBe("open");
  });

  it("answers 404 for a mark that is not there", async () => {
    const res = await request(server)
      .patch("/api/benchmark/agent-marks/00000000-0000-4000-8000-000000000000")
      .set("x-actor", fx.actor)
      .send({ note: "nobody" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/benchmark/agent-marks/:markId", () => {
  it("removes the mark and then answers 404", async () => {
    const mark = await post({ note: "delete me" });
    const first = await request(server)
      .delete(`/api/benchmark/agent-marks/${mark.body.id}`)
      .set("x-actor", fx.actor);
    expect(first.status).toBe(204);

    const second = await request(server)
      .delete(`/api/benchmark/agent-marks/${mark.body.id}`)
      .set("x-actor", fx.actor);
    expect(second.status).toBe(404);
  });
});

describe("GET /api/benchmark/agent-marks/preview", () => {
  it("refuses an assistant no imported call carries, without reaching Vapi", async () => {
    // The account behind an assistant is derived from its calls' org label,
    // so with no calls there is nothing to look up and nothing to ask Vapi.
    // This is the branch a test can exercise; the live read is not.
    const res = await request(server)
      .get("/api/benchmark/agent-marks/preview")
      .query({ assistantId: `asst-nothing-${fx.suffix}` });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Vapi account is unknown/);
  });

  it("needs an assistantId at all", async () => {
    const res = await request(server).get("/api/benchmark/agent-marks/preview");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assistantId/);
  });

  it("`preview` is a path, never a mark id -- the literal route wins", async () => {
    // PATCH and DELETE take a :markId in the same position. If the literal
    // GET were registered after them the preview would still work, but a
    // future GET on :markId would swallow it; asserting the 404 sentence
    // here pins which handler answered.
    const res = await request(server).get("/api/benchmark/agent-marks/preview").query({ assistantId: "preview" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Vapi account is unknown/);
  });
});

describe("the FK", () => {
  it("a mark outlives the call it was made on, keeping its note", async () => {
    const call = await fx.call();
    const mark = await post({ callId: call.id, note: "survives the call", assistantId: `asst-d-${fx.suffix}` });
    expect(mark.body.callId).toBe(call.id);

    await db.delete(benchmarkCallsTable).where(eq(benchmarkCallsTable.id, call.id));

    const [row] = await db.select().from(agentMarksTable).where(eq(agentMarksTable.id, mark.body.id));
    expect(row).toBeDefined();
    expect(row.callId).toBeNull();
    expect(row.note).toBe("survives the call");
  });
});
