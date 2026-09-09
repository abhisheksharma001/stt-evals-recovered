// R-45 (ox-alpha B-88). This is an integration test rather than a unit test
// for one reason: the defect is not in a helper, it is in the *exported pool
// object itself*, and that object only exists when DATABASE_URL is set. A unit
// test would have to build its own pool, which would pass whatever the real
// one does.
//
// pg-pool emits "error" on the pool when an idle client dies (failover, an
// idle-socket kill, an RST). `pg.Pool extends EventEmitter`, so before R-45
// that emit threw: nothing installs an `uncaughtException` handler, so the API
// process exited and every run in flight stayed at `running`, already paid for.
import { afterAll, describe, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";

afterAll(async () => {
  await pool.end().catch(() => {});
});

describe("pg pool error handling", () => {
  it("has a listener for the event pg-pool emits on a dead idle client", () => {
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
  });

  // The regression that matters. Without a listener this line throws, which in
  // the real process is an uncaught exception and a dead API.
  it("survives the emit instead of taking the process down", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = Object.assign(new Error("Connection terminated unexpectedly"), {
        code: "ECONNRESET",
      });
      expect(() => pool.emit("error", err, deadClient())).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("logs what happened without logging the client's credentials", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = Object.assign(new Error("Connection terminated unexpectedly"), {
        code: "ECONNRESET",
      });
      pool.emit("error", err, deadClient());
      const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("Connection terminated unexpectedly");
      expect(logged).toContain("ECONNRESET");
      // pg hands the dead client as the second argument, and that client
      // carries connectionParameters. Nothing from it may reach the log.
      expect(logged).not.toContain(FAKE_PASSWORD);
      expect(logged).not.toContain("db.internal.example.com");
    } finally {
      spy.mockRestore();
    }
  });
});

const FAKE_PASSWORD = "not-a-real-password-9f3a";

/** Shaped like the client pg passes as the second emit argument: the part that
 *  matters is that it carries connection parameters. */
function deadClient(): unknown {
  return {
    connectionParameters: {
      host: "db.internal.example.com",
      user: "postgres",
      password: FAKE_PASSWORD,
    },
  };
}
