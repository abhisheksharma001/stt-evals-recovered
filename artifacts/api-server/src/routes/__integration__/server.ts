// S-8: one server per test file, bound to the loopback address, started once.
//
// This exists because of what `request(app)` does. supertest, handed an
// express app rather than a listening server, stands a NEW one up for every
// single request -- 178 call sites in this suite, several inside loops -- with
// `app.listen(0)`. `listen` with no host binds the WILDCARD address, and that
// bind succeeds even while another process already holds 127.0.0.1 on the same
// port. A connection to 127.0.0.1:P then goes to the more specific binding:
// the stranger. Measured 2026-09-08 by standing two servers up in one process,
// one on 127.0.0.1:P and one on 0.0.0.0:P; the second bound with no error and
// the request reached the FIRST. This machine holds around twenty
// loopback-only listeners inside the ephemeral range 49152-65535 -- editor
// helpers, a bundler, local agent servers -- which is why the suite failed
// about one run in eleven, in a different file every time, with answers no
// route here can produce: an Anthropic API error envelope, a `ws` server's
// "WebSockets request was expected", a body that was not the array the route
// only ever returns.
//
// Binding 127.0.0.1 instead fails with EADDRINUSE, so the kernel hands out a
// genuinely free port and the collision cannot happen.
//
// It has to be done HERE, not by patching `listen` in setup.ts -- that was
// tried first and broke all 27 files. `listen(port, host)` resolves the host
// through `dns.lookup`, which defers even for an IP literal, so
// `server.address()` is still null on the next line; supertest reads it
// synchronously and dies with "Cannot read properties of null (reading
// 'port')". Awaiting the bind once, at module load, is the only way to hand
// supertest a server whose address is already there.
//
// `unref` so a file that has finished its tests is not held open by this.
import type { Server } from "node:http";

import app from "../../app";

const LOOPBACK = "127.0.0.1";

export const server: Server = await new Promise<Server>((resolve) => {
  const s = app.listen(0, LOOPBACK, () => resolve(s));
});

server.unref();
