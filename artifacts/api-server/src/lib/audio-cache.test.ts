// M-5: which channel readCellAudioSource picks, and what it says it picked.
// The whole step rests on this preference and on the answer being recorded,
// so both are asserted here against real files rather than a mock -- the
// preference IS a filesystem question.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { customerAudioPathFor, listCachedCallIds, listCachedCustomerCallIds, readCellAudioSource } from "./audio-cache";

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
