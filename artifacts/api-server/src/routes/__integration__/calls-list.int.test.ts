// T-160: GET /api/benchmark/calls against the throwaway database. The
// corpus list feeds Corpus and every picker; its filters and its newest-
// first order are query logic the compile check cannot see. Assertions are
// containment on this suite's own rows -- the corpus is shared state.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import { ensureAudioCacheDir } from "../../lib/audio-cache";
import { server } from "./server";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();
let rushId: string;
let archivedId: string;
let truckingId: string;
let measuredId: string;
let ranOkId: string;
let ranFailedId: string;

// M-6: the cache flags are read off this directory, so proving them means
// putting real files in it. Written under the seeded calls' own uuids and
// removed in afterAll, so nothing here touches the rescued corpus audio
// that shares the directory.
const CACHE_DIR = path.join(process.cwd(), "audio-cache");
const cacheFiles: string[] = [];

async function listCalls(query: Record<string, string> = {}) {
  const res = await request(server).get("/api/benchmark/calls").query(query);
  expect(res.status).toBe(200);
  return res.body as {
    id: string;
    vertical: string;
    status: string;
    audioCached: boolean;
    customerAudioCached: boolean;
    prodTranscriberLatencyMs: number | null;
    prodEndpointingLatencyMs: number | null;
    prodAssistantInterruptions: number | null;
    prodToolCalls: number | null;
    benchmarked: boolean;
  }[];
}

beforeAll(async () => {
  rushId = (await fx.call({ vertical: "rush", status: "ready_to_run" })).id;
  archivedId = (await fx.call({ vertical: "rush", status: "archived" })).id;
  truckingId = (await fx.call({ vertical: "trucking", status: "ready_to_run" })).id;
  // M-7a: one call carrying production's own measurements, with a stored 0
  // in each of the two columns where 0 is a real answer -- the assistant was
  // never interrupted, no tool was called. The trucking call above carries
  // none of the four, which is the pair this suite needs: a zero that
  // survives the round trip and a null that is not turned into one.
  measuredId = (
    await fx.call({
      vertical: "trucking",
      status: "ready_to_run",
      prodTranscriberLatencyMs: 378.5,
      prodEndpointingLatencyMs: 120.25,
      prodAssistantInterruptions: 0,
      prodToolCalls: 0,
    })
  ).id;

  // Two calls a run has touched, against the four above that nothing has.
  // The second one's only cell FAILED, and it still counts as run: the call
  // went through a run and what came back is that run's answer. Reading
  // this off scored `ok` cells -- or off agent scans, which cover 124 of the
  // 131 run calls live -- would call it untouched and hide it in the very
  // filter a reader opens to ask "which calls did the results come from?".
  const provider = await fx.provider();
  const run = await fx.run();
  ranOkId = (await fx.call({ vertical: "rush", status: "ready_to_run" })).id;
  ranFailedId = (await fx.call({ vertical: "rush", status: "ready_to_run" })).id;
  await fx.result(run.id, ranOkId, provider.id, { status: "ok" });
  await fx.result(run.id, ranFailedId, provider.id, { status: "provider_timeout" });

  // Three states, on purpose: the rush call has both files (an M-6 import),
  // the archived one has only the mono mix (imported before M-6, or rescued
  // after its channels expired), the trucking one has neither. Without the
  // middle case the two flags could be read off the same set and no test
  // would notice.
  await ensureAudioCacheDir();
  const seedCacheFiles = async (callId: string, suffixes: string[]) => {
    for (const suffix of suffixes) {
      const file = path.join(CACHE_DIR, `${callId}.${suffix}`);
      await fs.writeFile(file, "bytes");
      cacheFiles.push(file);
    }
  };
  await seedCacheFiles(rushId, ["audio", "customer.audio"]);
  await seedCacheFiles(archivedId, ["audio"]);
});

afterAll(async () => {
  await Promise.all(cacheFiles.map((f) => fs.rm(f, { force: true })));
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
    const res = await request(server).get("/api/benchmark/calls").query({ vertical: "haulage" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vertical/);
  });

  it("decorates a seeded call with audioCached: false -- no bytes on this disk", async () => {
    const rows = await listCalls({ vertical: "trucking" });
    const mine = rows.find((r) => r.id === truckingId);
    expect(mine?.audioCached).toBe(false);
    // M-6: no mono file means no customer file either, and the response says
    // so rather than leaving the field off.
    expect(mine?.customerAudioCached).toBe(false);
  });

  it("reports customerAudioCached per call, from that call's own file", async () => {
    const rows = await listCalls();
    const withChannel = rows.find((r) => r.id === rushId);
    const monoOnly = rows.find((r) => r.id === archivedId);
    expect(withChannel?.audioCached).toBe(true);
    expect(withChannel?.customerAudioCached).toBe(true);
    // The one that separates the two flags: cached audio, no caller channel.
    // Reading customerAudioCached off the mono set would pass every other
    // assertion in this file and fail this one.
    expect(monoOnly?.audioCached).toBe(true);
    expect(monoOnly?.customerAudioCached).toBe(false);
  });

  it("says whether a run has transcribed the call, counting a failed cell as run", async () => {
    const rows = await listCalls();
    // Every one of these is `ready_to_run`, which is why the flag has to
    // exist at all: on the live corpus 2026-09-09 all 376 calls carried that
    // status and 131 had been run, and nothing in the response separated
    // them.
    expect(rows.find((r) => r.id === ranOkId)?.status).toBe("ready_to_run");
    expect(rows.find((r) => r.id === truckingId)?.status).toBe("ready_to_run");

    expect(rows.find((r) => r.id === ranOkId)?.benchmarked).toBe(true);
    // The one that separates "a run touched it" from "it scored": this call's
    // only cell timed out.
    expect(rows.find((r) => r.id === ranFailedId)?.benchmarked).toBe(true);
    // And a call no run has ever named says false, not undefined -- the
    // filter reads it as an answer.
    expect(rows.find((r) => r.id === truckingId)?.benchmarked).toBe(false);
    expect(rows.find((r) => r.id === measuredId)?.benchmarked).toBe(false);
  });

  it("carries production's own measurements, keeping a stored 0 apart from a null", async () => {
    const rows = await listCalls({ vertical: "trucking" });
    const measured = rows.find((r) => r.id === measuredId);
    const unmeasured = rows.find((r) => r.id === truckingId);

    expect(measured?.prodTranscriberLatencyMs).toBeCloseTo(378.5, 1);
    expect(measured?.prodEndpointingLatencyMs).toBeCloseTo(120.25, 2);
    // Both stored as 0 by a real reading, and both must arrive as 0. A
    // serializer using `?? null` here would erase the answer.
    expect(measured?.prodAssistantInterruptions).toBe(0);
    expect(measured?.prodToolCalls).toBe(0);

    // And the call nobody measured stays unmeasured. `toBeNull` and not
    // `toBeFalsy`: 0 is falsy, and telling a client "0 ms" about a call Vapi
    // never timed is the whole failure this step exists to prevent.
    expect(unmeasured?.prodTranscriberLatencyMs).toBeNull();
    expect(unmeasured?.prodEndpointingLatencyMs).toBeNull();
    expect(unmeasured?.prodAssistantInterruptions).toBeNull();
    expect(unmeasured?.prodToolCalls).toBeNull();
  });
});
