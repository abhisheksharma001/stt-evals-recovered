// R-46 (ox-alpha B-82): syncProviderReadiness is a read-modify-write. It
// SELECTs every provider, derives a status from that snapshot, and used to
// write it back with a blind `WHERE id`. A PATCH that flips manuallyDisabled
// inside that window commits its own sync, and then the stale loop overwrote
// the answer with one computed from the pre-PATCH row.
//
// SAFETY: fixture provider ids match no adapter, so nothing here can derive a
// "ready" provider and no run is created. Never seed a "ready" provider in
// this suite.
//
// The window is in-process and cannot be opened from outside, so the function
// takes an `onBeforeUpdate` seam (R-27 added one to the executor for the same
// reason). Without it this test would be a sleep and a coin flip, and O-27
// says the flake does not get papered over.
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, benchmarkProvidersTable } from "@workspace/db";
import { syncProviderReadiness } from "../benchmark";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

async function readProvider(id: string) {
  const [row] = await db
    .select()
    .from(benchmarkProvidersTable)
    .where(eq(benchmarkProvidersTable.id, id));
  return row;
}

describe("syncProviderReadiness under a concurrent disable", () => {
  it("does not write a status derived from a row that has since been disabled", async () => {
    // Seeded stale on purpose: no adapter matches this id, so the sync wants
    // to move it "disabled" -> "not_configured", which is what makes it write.
    const provider = await fx.provider({ status: "disabled", manuallyDisabled: false });

    let flipped = false;
    await syncProviderReadiness({
      onBeforeUpdate: async (providerId) => {
        // Only this fixture's row: the sync walks every provider in the table.
        if (providerId !== provider.id || flipped) return;
        flipped = true;
        // The PATCH landing mid-sync, with its own sync already committed.
        await db
          .update(benchmarkProvidersTable)
          .set({ status: "disabled", manuallyDisabled: true })
          .where(eq(benchmarkProvidersTable.id, provider.id));
      },
    });

    expect(flipped).toBe(true);
    const after = await readProvider(provider.id);
    expect(after.manuallyDisabled).toBe(true);
    // The regression: without the precondition this reads "not_configured" --
    // a provider the operator just switched off, no longer saying so.
    expect(after.status).toBe("disabled");
  });

  it("still converges when nothing moves underneath it", async () => {
    const provider = await fx.provider({ status: "disabled", manuallyDisabled: false });
    await syncProviderReadiness();
    const after = await readProvider(provider.id);
    expect(after.status).toBe("not_configured");
  });
});
