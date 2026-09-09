// R-41 (ox-alpha B-67). `artifacts/api-server`'s `start` script runs
// `node --env-file-if-exists=.env`, a flag that landed in Node 22.9. No
// package declared `engines`, so an older Node did not fail at install with a
// sentence -- it booted and died on `bad option: --env-file-if-exists`, which
// reads like a corrupt install rather than a version mismatch.
//
// Declaring `engines` once is the fix. This is the part that keeps it true:
// it scans every package.json's scripts for version-gated node flags and
// asserts the package declares a floor at least as high as the flag needs.
// Adding a newer flag without raising the floor now fails here instead of on
// somebody's machine.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** node CLI flags that are not available in every supported release, and the
 *  first version that shipped them. Add a row when you add a flag. */
const FLAG_FLOOR = {
  "--env-file-if-exists": "22.9",
  "--experimental-strip-types": "22.6",
};

function trackedPackageJsons() {
  return execFileSync("git", ["ls-files", "*package.json"], { encoding: "utf8" })
    .split("\n")
    .filter((p) => p && !p.includes("node_modules"));
}

/** Lowest version a semver range like ">=22.9" or ">=22.9.0 <25" allows. */
function declaredFloor(range) {
  const m = /(\d+)\.(\d+)/.exec(range ?? "");
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

function parseFloor(v) {
  const [major, minor] = v.split(".");
  return { major: Number(major), minor: Number(minor) };
}

const problems = [];
let checked = 0;

for (const file of trackedPackageJsons()) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const scripts = Object.entries(pkg.scripts ?? {});
  for (const [flag, floorText] of Object.entries(FLAG_FLOOR)) {
    const users = scripts.filter(([, body]) => String(body).includes(flag));
    if (users.length === 0) continue;
    checked += 1;
    const need = parseFloor(floorText);
    const declared = declaredFloor(pkg.engines?.node);
    if (!declared) {
      problems.push(
        `${file}: script "${users[0][0]}" uses ${flag} (node >=${floorText}) but the package declares no engines.node`,
      );
      continue;
    }
    const tooLow =
      declared.major < need.major ||
      (declared.major === need.major && declared.minor < need.minor);
    if (tooLow) {
      problems.push(
        `${file}: script "${users[0][0]}" uses ${flag} (node >=${floorText}) but engines.node is "${pkg.engines.node}"`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("check-node-engines: version-gated node flags without a matching engines floor\n");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-node-engines: ${checked} version-gated flag use(s), each covered by an engines floor.`);
