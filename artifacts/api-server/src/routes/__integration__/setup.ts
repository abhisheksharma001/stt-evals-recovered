// M-6c: when a request in this suite dies, say which one and how far the
// server had got with it.
//
// Roughly one integration run in ten fails, and one of the two shapes it takes
// is `Error: socket hang up` -- measured 2026-09-05 on
// bulk-preview-cancel.int.test.ts, on a branch that had touched none of the
// files involved. M-6a made the assertions carry the server's answer, but a
// hang up has no answer to carry: the socket closed before one arrived.
//
// What vitest prints for a hang up today is the whole of this:
//
//   × probe2 > D: uncaught socket hang up, mid-response 9ms
//     → socket hang up
//
// No stack, no method, no URL, and the same line for two deliberately
// different failures -- because the error is built by node's http *client*
// after the fact, and its stack carries no frame from the test.
//
// The step that asked for this file prescribed process.on("unhandledRejection")
// and process.on("uncaughtException") handlers instead. Both were measured
// first and both are redundant: vitest 3.2.7 already prints those with a full
// stack, the source frame and the name of the running test. Neither fires for
// a hang up anyway -- a destroyed socket raises nothing in this process.
//
// So the answer has to come from the other end of the socket. supertest hands
// an express app to `http.createServer`, so wrapping that one function -- in a
// file the integration config loads and nothing else does -- reaches every
// server the suite starts without touching app.ts or any route. Each test file
// runs in its own worker context, so the wrap is applied once per file and the
// lines do not stack (measured with two files, one line each).
import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

function watchResponses(server: Server): void {
  // prependListener, not on: `http.createServer(app)` registers the express
  // app as the first "request" listener, listeners run in order, and the app
  // has already rewritten req.url by the time a later listener is called.
  server.prependListener("request", (req: IncomingMessage, res: ServerResponse) => {
    // Captured now, not in the close handler below: express strips a mounted
    // router's prefix off req.url while the request is inside it, so by the
    // time the socket closes `/api/benchmark/...` reads as `/benchmark/...`.
    const asked = `${req.method ?? "?"} ${req.url ?? "?"}`;
    const startedAt = Date.now();
    res.on("close", () => {
      // A response that finished normally is the ordinary case, and 119 of
      // them saying so would bury the one that did not.
      if (res.writableFinished) return;
      const how = res.headersSent
        ? `the server had already sent headers with status ${res.statusCode}`
        : "the server had not sent any headers";
      // console.error rather than process.stderr.write: vitest prints the name
      // of the test that was running above its console output.
      console.error(
        `[integration] socket closed before the response finished: ${asked} ` +
          `-- ${how}, ${Date.now() - startedAt}ms in. This is what the test sees as "socket hang up".`,
      );
    });
  });

  // No `clientError` listener here on purpose. A connection that fails before
  // it becomes a request would be worth naming, but node disables its own
  // default handling the moment a listener is registered: measured
  // 2026-09-05, a malformed request line gets `HTTP/1.1 400 Bad Request` with
  // no listener and an empty response with one. Listening would manufacture
  // the exact failure this file exists to explain.
}

// S-8: bind the loopback address, never the wildcard.
//
// supertest stands up a fresh server per request -- 178 call sites, several
// in loops -- with `app.listen(0)`, and `listen` with no host binds
// 0.0.0.0. That bind SUCCEEDS even when another process already holds
// 127.0.0.1 on the same port (SO_REUSEADDR), and a connection to
// 127.0.0.1:P then goes to the more specific binding: the other process.
// The test asks its own app a question and a stranger answers.
//
// Measured 2026-09-08. Two loopback-only listeners were stood up in one
// process, one on 127.0.0.1:P and one on 0.0.0.0:P; the second bound with no
// error and the connection reached the FIRST. Binding 127.0.0.1 instead
// fails with EADDRINUSE, so the kernel hands out a genuinely free port and
// the collision cannot happen. This machine holds around twenty
// loopback-only listeners inside the ephemeral range (49152-65535) --
// editor helpers, a bundler, local agent servers -- which is why the suite
// failed roughly one run in eleven, in a different file every time.
const LOOPBACK = "127.0.0.1";

function bindLoopback(server: Server): void {
  const listen = server.listen.bind(server);
  server.listen = function patchedListen(...args: unknown[]): Server {
    // Only the `listen(port, ...)` form with no host is rewritten: a caller
    // that named an address meant it.
    if (typeof args[0] === "number" && typeof args[1] !== "string") {
      const [port, ...rest] = args;
      return (listen as (...a: unknown[]) => Server)(port, LOOPBACK, ...rest);
    }
    return (listen as (...a: unknown[]) => Server)(...args);
  } as typeof server.listen;
}

const createServer = http.createServer;
http.createServer = function patchedCreateServer(this: unknown, ...args: unknown[]): Server {
  const server = (createServer as (...a: unknown[]) => Server).apply(this, args);
  watchResponses(server);
  bindLoopback(server);
  return server;
} as typeof http.createServer;
