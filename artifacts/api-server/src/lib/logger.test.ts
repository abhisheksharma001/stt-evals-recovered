import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardTransport, resolveLogLevel } from "./logger";

afterEach(() => {
  vi.restoreAllMocks();
});

// R-49 (ox-alpha waves, logger.ts). What this protects: the logger is the
// first thing this process builds. Every failure here happens before a single
// request can be served, or takes the process down mid-run.
describe("resolveLogLevel", () => {
  it("defaults to info when LOG_LEVEL is absent", () => {
    expect(resolveLogLevel({} as NodeJS.ProcessEnv)).toBe("info");
  });

  it("defaults to info when LOG_LEVEL is set but empty", () => {
    // `?? "info"` did not catch this: "" is a string, and pino threw on it.
    expect(resolveLogLevel({ LOG_LEVEL: "" } as NodeJS.ProcessEnv)).toBe("info");
    expect(resolveLogLevel({ LOG_LEVEL: "   " } as NodeJS.ProcessEnv)).toBe("info");
  });

  it("falls back to info on a level pino does not have, and says so", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveLogLevel({ LOG_LEVEL: "verbose" } as NodeJS.ProcessEnv)).toBe("info");
    expect(err).toHaveBeenCalledOnce();
  });

  it("keeps every level pino accepts, including silent", () => {
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal", "silent"]) {
      expect(resolveLogLevel({ LOG_LEVEL: level } as NodeJS.ProcessEnv)).toBe(level);
    }
  });

  it("accepts a level pino would accept but with surrounding whitespace or caps", () => {
    // pino lowercases the level itself but throws on " info".
    expect(resolveLogLevel({ LOG_LEVEL: "INFO" } as NodeJS.ProcessEnv)).toBe("info");
    expect(resolveLogLevel({ LOG_LEVEL: " debug\n" } as NodeJS.ProcessEnv)).toBe("debug");
  });

  it("every level it returns is one pino will construct", () => {
    for (const raw of ["", "verbose", "INFO", " debug ", "silent", "fatal"]) {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const level = resolveLogLevel({ LOG_LEVEL: raw } as NodeJS.ProcessEnv);
      expect(() => pino({ level })).not.toThrow();
    }
  });
});

describe("guardTransport", () => {
  it("stops an error event on the transport from being fatal", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stream = guardTransport(new EventEmitter());
    expect(() => stream.emit("error", new Error("the worker thread exited"))).not.toThrow();
  });

  it("reports once, not once per dropped log line", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const stream = guardTransport(new EventEmitter());
    stream.emit("error", new Error("the worker thread exited"));
    stream.emit("error", new Error("the worker has exited"));
    stream.emit("error", new Error("the worker has exited"));
    expect(err).toHaveBeenCalledOnce();
    expect(String(err.mock.calls[0]?.[0])).toContain("the worker thread exited");
  });

  // The break test. Not a synthetic emit: this kills a real pino-pretty worker
  // the way an unhandled throw inside pino-pretty would, and then keeps
  // logging. Without guardTransport, thread-stream's unhandled "error" ends
  // this process -- reverting the guard does not fail this assertion, it takes
  // the test runner down with it.
  it("survives the real pino-pretty worker dying, and keeps serving", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stream = guardTransport(
      pino.transport({ target: "pino-pretty", options: { colorize: false } }),
    );
    const log = pino({ level: "info" }, stream);
    log.info("before the worker dies");

    await new Promise((resolve) => setTimeout(resolve, 300));
    const worker = (stream as unknown as { worker: { terminate(): Promise<number> } }).worker;
    expect(worker).toBeDefined();
    await worker.terminate();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(() => log.info("after the worker died")).not.toThrow();
    expect(process.exitCode ?? 0).toBe(0);
  }, 10_000);
});
