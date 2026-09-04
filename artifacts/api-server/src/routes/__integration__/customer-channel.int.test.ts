// M-5: a bulk that measures the caller-only channel selects only calls that
// HAVE one, and says how many it dropped and why. The channel a cell was
// read from is recorded per result row so a number can always be traced
// back to the audio that produced it.
//
// The customer channel lives on disk as `<callId>.customer.audio` beside
// the mono mix (audio-cache.ts), so these cases write a real file into the
// server's cache directory under the fixture's own call id and delete it
// again -- there is no way to test a filesystem preference without a file.
// Nothing here calls a provider or spends anything.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

// The same directory audio-cache.ts computes: process.cwd()/audio-cache.
// Vitest runs from the api-server package root, which is where the server
// runs from too.
const CACHE_DIR = path.join(process.cwd(), "audio-cache");
const written: string[] = [];

/** A byte or two under a call id the fixture owns. The content is never
 *  read -- selection only asks whether the file exists. */
async function writeCustomerAudio(callId: string): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${callId}.customer.audio`);
  await fs.writeFile(file, Buffer.from("RIFF"));
  written.push(file);
}

afterAll(async () => {
  // Delete only the files this suite created -- the real rescued corpus
  // lives in the same directory and is irreplaceable.
  await Promise.all(written.map((f) => fs.rm(f, { force: true })));
  await fx.cleanup();
  await pool.end();
});

describe("M-5 customer-channel selection", () => {
  it("matches only calls with a customer channel, and names the ones it dropped", async () => {
    const accountLabel = `m5-acct-${fx.suffix}`;
    const withChannel = await fx.call({ durationSeconds: 60, sourceAccountLabel: accountLabel });
    await fx.call({ durationSeconds: 60, sourceAccountLabel: accountLabel });
    await fx.call({ durationSeconds: 60, sourceAccountLabel: accountLabel });
    await writeCustomerAudio(withChannel.id);

    // Default criteria: this endpoint previews POST /benchmark/bulks, which
    // requires the customer channel unless told otherwise.
    const res = await request(app)
      .post("/api/benchmark/bulks/preview")
      .send({ criteria: { accountLabel }, providerIds: [], minDurationSeconds: 30, maxDurationSeconds: 300 });

    expect(res.status).toBe(200);
    expect(res.body.inScopeCount).toBe(3);
    expect(res.body.matchedCount).toBe(1);
    expect(res.body.excluded).toEqual([{ bucket: "no customer-channel audio on file", count: 2 }]);
    // T-14's invariant still holds: nothing is dropped without a name.
    expect(res.body.matchedCount + res.body.excluded[0].count).toBe(res.body.inScopeCount);
  });

  it("matches all three when the bulk does not ask for the customer channel", async () => {
    const accountLabel = `m5-mono-${fx.suffix}`;
    const withChannel = await fx.call({ durationSeconds: 60, sourceAccountLabel: accountLabel });
    await fx.call({ durationSeconds: 60, sourceAccountLabel: accountLabel });
    await fx.call({ durationSeconds: 60, sourceAccountLabel: accountLabel });
    await writeCustomerAudio(withChannel.id);

    const res = await request(app)
      .post("/api/benchmark/bulks/preview")
      .send({
        criteria: { accountLabel, requireCustomerAudio: false },
        providerIds: [],
        minDurationSeconds: 30,
        maxDurationSeconds: 300,
      });

    expect(res.status).toBe(200);
    expect(res.body.matchedCount).toBe(3);
    expect(res.body.excluded).toEqual([]);
  });

  it("applies to a hand-picked call too -- a person cannot pick past a missing channel", async () => {
    // Every other filter is skipped for an explicit pick by design. This one
    // is not: a call with no caller-only track cannot satisfy a bulk whose
    // premise is the caller-only track, whoever chose it.
    const noChannel = await fx.call({ durationSeconds: 5 });

    const res = await request(app)
      .post("/api/benchmark/bulks/preview")
      .send({ criteria: { callIds: [noChannel.id] }, providerIds: [], minDurationSeconds: 30, maxDurationSeconds: 300 });

    expect(res.status).toBe(200);
    expect(res.body.inScopeCount).toBe(1);
    expect(res.body.matchedCount).toBe(0);
    expect(res.body.excluded).toEqual([{ bucket: "no customer-channel audio on file", count: 1 }]);
  });

  it("freezes the channel onto the bulk it creates, and the count it froze is the count previewed", async () => {
    const accountLabel = `m5-freeze-${fx.suffix}`;
    const withChannel = await fx.call({ durationSeconds: 60, sourceAccountLabel: accountLabel });
    await fx.call({ durationSeconds: 60, sourceAccountLabel: accountLabel });
    await writeCustomerAudio(withChannel.id);
    const provider = await fx.provider({ costPerMinute: 0.5 });

    const preview = await request(app)
      .post("/api/benchmark/bulks/preview")
      .send({ criteria: { accountLabel }, providerIds: [provider.id], minDurationSeconds: 30, maxDurationSeconds: 300 });
    expect(preview.body.matchedCount).toBe(1);

    const created = await request(app)
      .post("/api/benchmark/bulks")
      .set("x-actor", fx.actor)
      .send({
        name: `m5 freeze ${fx.suffix}`,
        criteria: { accountLabel },
        providerIds: [provider.id],
        minDurationSeconds: 30,
        maxDurationSeconds: 300,
      });
    expect(created.status).toBe(201);
    fx.adoptBulk(created.body.id);

    // The bulk says which channel it measures -- never left absent to be
    // guessed from whatever the default was on the day it ran.
    expect(created.body.selectionCriteria.requireCustomerAudio).toBe(true);
    // And it froze exactly the calls the preview promised: the one with a
    // channel, not the one without.
    expect(created.body.selectionCriteria.resolvedCallIds).toEqual([withChannel.id]);
  });

  it("a template saved before M-5 keeps matching exactly what it matched", async () => {
    // The template's stored criteria carry no opinion about the channel.
    // Launching it must not retroactively apply the new default, or a
    // saved template quietly starts measuring something else.
    const accountLabel = `m5-tmpl-${fx.suffix}`;
    await fx.call({ durationSeconds: 60, sourceAccountLabel: accountLabel });
    await fx.call({ durationSeconds: 60, sourceAccountLabel: accountLabel });
    const provider = await fx.provider({ costPerMinute: 0.5 });

    const template = await request(app)
      .post("/api/benchmark/bulk-templates")
      .set("x-actor", fx.actor)
      .send({
        name: `m5 template ${fx.suffix}`,
        criteria: { accountLabel },
        providerIds: [provider.id],
        minDurationSeconds: 30,
        maxDurationSeconds: 300,
      });
    expect(template.status).toBe(201);

    const launched = await request(app)
      .post(`/api/benchmark/bulk-templates/${template.body.id}/launch`)
      .set("x-actor", fx.actor)
      .send({ name: `m5 template launch ${fx.suffix}` });

    expect(launched.status).toBe(201);
    fx.adoptBulk(launched.body.id);
    // Neither call has a customer channel, and both are still selected.
    expect(launched.body.selectionCriteria.requireCustomerAudio).toBe(false);
    expect(launched.body.selectionCriteria.resolvedCallIds).toHaveLength(2);

    await request(app).delete(`/api/benchmark/bulk-templates/${template.body.id}`).set("x-actor", fx.actor);
  });
});
