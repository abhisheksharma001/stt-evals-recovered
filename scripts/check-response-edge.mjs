// Fails when a route file answers a success (2xx/3xx) payload without going
// through respondJson. T-152..T-155 made respondJson the one way a success
// payload leaves the server, because it is the only form the compiler can
// hold against the contract: `res.json(Schema.parse(value))` typechecks
// `value` against nothing (parse takes unknown), which is exactly how T-136
// shipped -- a required field missing from a hand-built mapping, discovered
// as a 500 in production a day later. A new handler written the old way
// would reopen that hole silently; this check makes it a CI failure instead.
//
// Error responses are deliberately allowed through res.status(4xx/5xx).json:
// their { error } shape is owned by respondInvalid (T-150), jsonErrorHandler
// (T-76) and jsonNotFoundHandler (T-149), and inline 404s like
// `res.status(404).json({ error: "Run not found" })` are fine. Non-JSON
// responses (the audio stream, the verdict HTML, redirects) are not this
// check's business.
//
// Same philosophy as check-api-routes.mjs: deliberately dumb, line-oriented,
// dependency-free, and refuses to pass when it finds nothing to check.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROUTES = resolve(process.argv[2] ?? "artifacts/api-server/src/routes");

const offences = [];
let filesRead = 0;
let respondJsonSites = 0;

for (const name of readdirSync(ROUTES)) {
  if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
  filesRead += 1;
  const lines = readFileSync(join(ROUTES, name), "utf8").split("\n");
  lines.forEach((line, i) => {
    respondJsonSites += (line.match(/respondJson\(/g) ?? []).length;
    // Bare res.json: a payload with no status is a success payload.
    if (/\bres\s*\.json\(/.test(line)) {
      offences.push(`routes/${name}:${i + 1}: res.json(...) -- a success payload must go through respondJson`);
    }
    // res.status(2xx|3xx).json, same line.
    if (/\bres\s*\.status\(\s*[23]\d\d\s*\)\s*\.json\(/.test(line)) {
      offences.push(`routes/${name}:${i + 1}: res.status(2xx/3xx).json(...) -- use respondJson(res, Schema, value, status)`);
    }
    // The split form: `.status(2xx)` on its own line inside a res chain,
    // with .json following. Catching the status line is enough.
    if (/^\s*\.status\(\s*[23]\d\d\s*\)\s*$/.test(line) && /^\s*\.json\(/.test(lines[i + 1] ?? "")) {
      offences.push(`routes/${name}:${i + 1}: res ... .status(2xx/3xx).json(...) -- use respondJson(res, Schema, value, status)`);
    }
    // A schema parse fed straight to json (any status) bypasses the compile
    // check even when the runtime one is kept.
    if (/\.json\(\s*\w+\.parse\(/.test(line)) {
      offences.push(`routes/${name}:${i + 1}: .json(Schema.parse(...)) -- the parse alone is runtime-only; use respondJson`);
    }
  });
}

if (filesRead === 0 || respondJsonSites === 0) {
  console.error(
    `check-response-edge: read ${filesRead} route files and found ${respondJsonSites} respondJson sites -- ` +
      "nothing to check means this check is not checking anything.",
  );
  process.exit(1);
}

if (offences.length) {
  for (const o of offences) console.error(o);
  console.error(
    `\ncheck-response-edge: ${offences.length} success response(s) bypass respondJson. ` +
      "respondJson(res, Schema, value[, status]) keeps the payload compile-checked against the contract.",
  );
  process.exit(1);
}

console.log(`check-response-edge: ${filesRead} route files, ${respondJsonSites} respondJson sites, no bypasses.`);
