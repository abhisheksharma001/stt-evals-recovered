import { describe, expect, it } from "vitest";
import { probeDatabase } from "./db-probe";

describe("probeDatabase (R-56)", () => {
  it("is ok when the query answers", async () => {
    expect(await probeDatabase(async () => ({ rows: [{ "?column?": 1 }] }))).toBe("ok");
  });

  it("is unreachable when the query fails, and does not throw", async () => {
    expect(await probeDatabase(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:5433"); })).toBe("unreachable");
  });

  it("is unreachable when the query never answers, within the cap", async () => {
    const started = Date.now();
    expect(await probeDatabase(() => new Promise(() => {}), 50)).toBe("unreachable");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
