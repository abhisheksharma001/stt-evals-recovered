// M-5: which channel readCellAudioSource picks, and what it says it picked.
// The whole step rests on this preference and on the answer being recorded,
// so both are asserted here against real files rather than a mock -- the
// preference IS a filesystem question.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cacheCallSidecars, customerAudioPathFor, getOrCacheAudioBytes, isCustomerAudioCached, listCachedCallIds, listCachedCustomerCallIds, readCellAudioSource } from "./audio-cache";
import type { VapiCall } from "./vapi";

// audio-cache.ts computes its directory from process.cwd(); vitest runs
// from the api-server package root, the same place the server runs from.
const CACHE_DIR = path.join(process.cwd(), "audio-cache");
const written: string[] = [];

// Real uuid-shaped ids that no corpus call uses, so nothing this file
// writes or deletes can touch the rescued audio in the same directory.
const BOTH = "00000000-0000-4000-8000-00000000be01";
const MONO_ONLY = "00000000-0000-4000-8000-00000000be02";

async function write(name: string, body: string): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, name);
  await fs.writeFile(file, body);
  written.push(file);
}

afterAll(async () => {
  await Promise.all(written.map((f) => fs.rm(f, { force: true })));
});

describe("readCellAudioSource", () => {
  it("reads the customer channel when it exists, and says so", async () => {
    await write(`${BOTH}.audio`, "mono-bytes");
    await write(`${BOTH}.customer.audio`, "customer-bytes");

    const audio = await readCellAudioSource(BOTH, { preferCustomer: true });
    expect(audio.source).toBe("customer");
    expect(audio.bytes.toString()).toBe("customer-bytes");
  });

  it("falls back to the mono mix when there is no customer channel, and says THAT", async () => {
    await write(`${MONO_ONLY}.audio`, "mono-bytes");

    const audio = await readCellAudioSource(MONO_ONLY, { preferCustomer: true });
    expect(audio.source).toBe("mono");
    expect(audio.bytes.toString()).toBe("mono-bytes");
  });

  it("reads the mono mix untouched when the caller does not want the customer channel", async () => {
    // A bulk saved before M-5 must keep producing the numbers it produced,
    // which means reading the same bytes it read -- even for a call whose
    // customer channel has since been rescued.
    await write(`${BOTH}.audio`, "mono-bytes");
    await write(`${BOTH}.customer.audio`, "customer-bytes");

    const audio = await readCellAudioSource(BOTH, { preferCustomer: false });
    expect(audio.source).toBe("mono");
    expect(audio.bytes.toString()).toBe("mono-bytes");
  });

  it("rejects when neither channel is on disk", async () => {
    await expect(
      readCellAudioSource("00000000-0000-4000-8000-00000000be03", { preferCustomer: true }),
    ).rejects.toThrow();
  });

  it("customerAudioPathFor names the file beside the mono mix", () => {
    expect(customerAudioPathFor(BOTH)).toBe(path.join(CACHE_DIR, `${BOTH}.customer.audio`));
  });
});

describe("the cached-id listings", () => {
  it("counts a call once, not once per channel file it has", async () => {
    // The bug this asserts against: `.customer.audio` and
    // `.assistant.audio` both end in ".audio", so a suffix match returned
    // `<uuid>.customer` and `<uuid>.assistant` as if they were call ids.
    await write(`${BOTH}.audio`, "mono-bytes");
    await write(`${BOTH}.customer.audio`, "customer-bytes");
    await write(`${BOTH}.assistant.audio`, "assistant-bytes");

    const ids = await listCachedCallIds();
    expect(ids.has(BOTH)).toBe(true);
    expect(ids.has(`${BOTH}.customer`)).toBe(false);
    expect(ids.has(`${BOTH}.assistant`)).toBe(false);
  });

  it("lists the calls that have a customer channel, and only those", async () => {
    await write(`${BOTH}.audio`, "mono-bytes");
    await write(`${BOTH}.customer.audio`, "customer-bytes");
    await write(`${MONO_ONLY}.audio`, "mono-bytes");

    const ids = await listCachedCustomerCallIds();
    expect(ids.has(BOTH)).toBe(true);
    expect(ids.has(MONO_ONLY)).toBe(false);
  });
});

// M-6: the importer's sidecar save. Real files again, for the same reason
// as above -- "did the caller-only channel end up on disk" is a filesystem
// question, and a mock would only prove the function called itself.
//
// Audio is fetched through fetchAudioBytes, which is global fetch: a data:
// URL is a real fetch of known bytes, with no network and no stub.
const dataUrl = (body: string) => `data:application/octet-stream;base64,${Buffer.from(body).toString("base64")}`;

const FULL = "00000000-0000-4000-8000-00000000be11";
const NO_CUSTOMER = "00000000-0000-4000-8000-00000000be12";
const BAD_URL = "00000000-0000-4000-8000-00000000be13";
const AGAIN = "00000000-0000-4000-8000-00000000be14";
const MONO_MODE = "00000000-0000-4000-8000-00000000be21";

function vapiCall(over: Partial<NonNullable<VapiCall["artifact"]>> = {}, top: Partial<VapiCall> = {}): VapiCall {
  return {
    id: "vapi-call-id",
    endedReason: "customer-ended-call",
    analysis: { summary: "a summary" },
    startedAt: "2026-09-04T10:00:00.000Z",
    endedAt: "2026-09-04T10:02:00.000Z",
    costs: [{ type: "transcriber", transcriber: { provider: "deepgram", model: "flux-general-en" } }],
    artifact: {
      transcript: "AI: hello\nUser: hi",
      messages: [{ role: "user", message: "hi" }],
      performanceMetrics: { transcriberLatencyAverage: 272 },
      presignedCustomerUrl: dataUrl("customer-bytes"),
      presignedAssistantUrl: dataUrl("assistant-bytes"),
      ...over,
    },
    ...top,
  };
}

function track(callId: string): void {
  written.push(
    path.join(CACHE_DIR, `${callId}.customer.audio`),
    path.join(CACHE_DIR, `${callId}.assistant.audio`),
    path.join(CACHE_DIR, `${callId}.artifact.json`),
  );
}

describe("cacheCallSidecars", () => {
  it("saves both channels and the artifact, in the shape the rescue script wrote", async () => {
    track(FULL);
    const result = await cacheCallSidecars(FULL, vapiCall());

    expect(result.saved.sort()).toEqual(["artifact", "assistant", "customer"]);
    expect(result.missing).toEqual([]);
    expect(result.errors).toEqual([]);

    expect(await fs.readFile(path.join(CACHE_DIR, `${FULL}.customer.audio`), "utf8")).toBe("customer-bytes");
    expect(await fs.readFile(path.join(CACHE_DIR, `${FULL}.assistant.audio`), "utf8")).toBe("assistant-bytes");

    // The key set is the contract M-7's backfill reads across both the
    // hand-rescued files and the imported ones.
    const artifact = JSON.parse(await fs.readFile(path.join(CACHE_DIR, `${FULL}.artifact.json`), "utf8"));
    expect(Object.keys(artifact).sort()).toEqual(
      ["analysis", "costs", "endedAt", "endedReason", "messages", "performanceMetrics", "savedAt", "startedAt", "transcript"],
    );
    expect(artifact.performanceMetrics.transcriberLatencyAverage).toBe(272);
    expect(artifact.endedReason).toBe("customer-ended-call");
  });

  it("writes the caller's audio and words readable only by this server (0600)", async () => {
    track(FULL);
    await cacheCallSidecars(FULL, vapiCall());
    for (const suffix of ["customer.audio", "assistant.audio", "artifact.json"]) {
      const stat = await fs.stat(path.join(CACHE_DIR, `${FULL}.${suffix}`));
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("names a channel Vapi did not offer instead of pretending it saved one", async () => {
    track(NO_CUSTOMER);
    const result = await cacheCallSidecars(NO_CUSTOMER, vapiCall({ presignedCustomerUrl: undefined }));

    expect(result.missing).toEqual(["customer"]);
    expect(result.saved).toContain("assistant");
    expect(result.saved).toContain("artifact");
    expect(await isCustomerAudioCached(NO_CUSTOMER)).toBe(false);
  });

  it("reports a failed download as an error and never throws", async () => {
    track(BAD_URL);
    const result = await cacheCallSidecars(BAD_URL, vapiCall({ presignedCustomerUrl: "https://127.0.0.1:1/nope.wav" }));

    expect(result.errors.some((e) => e.includes("customer channel"))).toBe(true);
    // The rest of the save still happened: one dead link must not cost the
    // artifact and the other channel too.
    expect(result.saved).toContain("artifact");
    expect(result.saved).toContain("assistant");
  });

  it("leaves files it already wrote exactly as they are on a second run", async () => {
    track(AGAIN);
    await cacheCallSidecars(AGAIN, vapiCall());
    const first = await fs.readFile(path.join(CACHE_DIR, `${AGAIN}.artifact.json`), "utf8");

    const second = await cacheCallSidecars(AGAIN, vapiCall({ presignedCustomerUrl: dataUrl("different-bytes") }));

    expect(second.saved).toEqual([]);
    expect(await fs.readFile(path.join(CACHE_DIR, `${AGAIN}.artifact.json`), "utf8")).toBe(first);
    expect(await fs.readFile(path.join(CACHE_DIR, `${AGAIN}.customer.audio`), "utf8")).toBe("customer-bytes");
  });
});

// M-6b. getOrCacheAudioBytes is the only writer of the mono `<id>.audio`
// file, and it asks Vapi for a fresh recording URL before writing -- the one
// path in this file that would reach the network. Only that function is
// replaced; the rest of ./vapi stays real.
vi.mock("./vapi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vapi")>()),
  resolveFreshRecordingUrl: async () =>
    `data:application/octet-stream;base64,${Buffer.from("mono-bytes").toString("base64")}`,
}));

describe("getOrCacheAudioBytes", () => {
  it("writes the mono mix readable only by this server (0600), like the three files beside it", async () => {
    const file = path.join(CACHE_DIR, `${MONO_MODE}.audio`);
    written.push(file);
    // A file left behind by a crashed earlier run would be returned from the
    // cache without the write below ever running, and its mode would be the
    // thing asserted.
    await fs.rm(file, { force: true });

    const bytes = await getOrCacheAudioBytes({
      id: MONO_MODE,
      sourceCallId: "vapi-call-id",
      sourceAccountLabel: null,
      audioObjectPath: null,
    });

    expect(bytes.toString("utf8")).toBe("mono-bytes");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});
