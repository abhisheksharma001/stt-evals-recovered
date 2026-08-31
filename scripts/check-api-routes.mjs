// Fails when the OpenAPI spec and the Express router disagree about which
// endpoints exist. Both directions of that drift are real defects, and both
// were live in this repo when this check was written (T-148):
//
//   in the spec, no route  -> orval generates a client function for an
//                             endpoint that answers 404, and (until T-149)
//                             answered it as an HTML page, so the caller got
//                             "Unexpected token <". POST /benchmark/agent/scans
//                             sat like that from 2026-08-27 to 2026-08-31.
//   a route, not in the spec -> no generated validator exists for it, so its
//                             parameters are whatever the handler remembers to
//                             check. GET /benchmark/calls/{callId}/audio was
//                             never in the spec and answered 500 for a
//                             malformed id (T-146).
//
// Deliberately dumb: a regex over `router.<method>("<path>"` and a
// line-oriented read of the spec's `paths:` block. Nothing here needs a YAML
// parser, and a dependency-free check is one that still runs in five years.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SPEC = resolve(process.argv[2] ?? "lib/api-spec/openapi.yaml");
const ROUTES = resolve(process.argv[3] ?? "artifacts/api-server/src/routes");
const METHODS = ["get", "post", "put", "patch", "delete"];

// Express writes `:callId`, OpenAPI writes `{callId}`; the name itself is
// local to each file, so compare on position, not on what it is called.
const shape = (path) => path.replace(/:(\w+)|\{(\w+)\}/g, "{}");
const key = (method, path) => `${method.toUpperCase()} ${shape(path)}`;

const implemented = new Map();
for (const name of readdirSync(ROUTES)) {
  if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
  const src = readFileSync(join(ROUTES, name), "utf8");
  for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
    implemented.set(key(m[1], m[2]), `${m[2]} (routes/${name})`);
  }
}

const declared = new Map();
let inPaths = false;
let currentPath = null;
for (const line of readFileSync(SPEC, "utf8").split("\n")) {
  if (/^paths:/.test(line)) { inPaths = true; continue; }
  if (inPaths && /^\w/.test(line)) break; // next top-level block ends paths
  if (!inPaths) continue;
  const p = /^ {2}(\/\S*):\s*$/.exec(line);
  if (p) { currentPath = p[1]; continue; }
  const m = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
  if (m && currentPath) declared.set(key(m[1], currentPath), currentPath);
}

const missingRoute = [...declared].filter(([k]) => !implemented.has(k));
const missingSpec = [...implemented].filter(([k]) => !declared.has(k));

if (declared.size === 0 || implemented.size === 0) {
  console.error(
    `check-api-routes: read ${declared.size} spec operations and ${implemented.size} routes -- ` +
      "one of the two parsers found nothing, which means this check is not checking anything.",
  );
  process.exit(1);
}

for (const [k, path] of missingRoute) {
  console.error(`In the spec, no route serves it: ${k.split(" ")[0]} ${path}`);
}
for (const [k, where] of missingSpec) {
  console.error(`A route serves it, the spec does not declare it: ${k.split(" ")[0]} ${where}`);
}

if (missingRoute.length || missingSpec.length) {
  console.error(
    `\ncheck-api-routes: ${missingRoute.length + missingSpec.length} mismatch(es). ` +
      "Add the missing path to lib/api-spec/openapi.yaml (then run the api-spec codegen), " +
      "or delete the dead entry.",
  );
  process.exit(1);
}

console.log(`check-api-routes: ${declared.size} operations, spec and router agree.`);
