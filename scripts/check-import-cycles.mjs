// Walks relative imports under each hand-written package root and fails on
// any cycle. Acceptance check for T-75; cheap enough to run in CI.
//
// The default list is the whole check (O-88). It used to be one root, and
// both callers -- package.json check:cycles and .github/workflows/ci.yml --
// passed that same one root explicitly, so lib/scoring, lib/stt-providers
// and lib/db were never checked; lib/scoring had six cycles. Callers now
// pass nothing, so there is one list to keep right.
//
// Why a cycle can sit there for months looking fine: it only bites when a
// module READS a binding it imported through the cycle while it is still
// being evaluated. lib/scoring's siblings only ever called through the
// barrel later, at runtime, by which point index.ts had finished. One
// top-level read -- a `const X = diffWords(...)`, a re-exported const --
// turns it into a ReferenceError or a silent undefined. Verified against
// node, not assumed.
//
// Not listed, on purpose. artifacts/stt-benchmark and artifacts/mockup-sandbox
// import through the "@/*" tsconfig alias, not relatively: 202 alias imports
// to 1 relative one, measured 2026-09-09. This walker only follows relative
// specifiers, so pointing it at the UI would traverse one edge out of 203 and
// print "no import cycles among 101 files" -- a pass it has not earned, which
// is the same failure this script exists to prevent. Widening the .ts filter
// to .tsx is NOT enough on its own and would make it worse by making the lie
// look thorough; the alias has to be resolved first. Backlog 2026-09-09.
// lib/api-zod and lib/api-client-react are orval output, so a cycle there is
// not a thing a person can fix by editing the file.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DEFAULT_ROOTS = [
  "artifacts/api-server/src",
  "lib/scoring/src",
  "lib/stt-providers/src",
  "lib/db/src",
];
const roots = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_ROOTS;

const resolveImport = (from, spec) => {
  const base = resolve(dirname(from), spec);
  for (const c of [base, base + ".ts", join(base, "index.ts")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
};

const WHITE = 0, GREY = 1, BLACK = 2;

function cyclesUnder(ROOT) {
  const files = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) files.push(p);
    }
  })(ROOT);

  const graph = new Map();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const deps = new Set();
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const r = resolveImport(f, m[1]);
      if (r) deps.add(r);
    }
    graph.set(f, deps);
  }

  const color = new Map(files.map((f) => [f, WHITE]));
  const stack = [];
  const cycles = [];
  function dfs(n) {
    color.set(n, GREY);
    stack.push(n);
    for (const d of graph.get(n) ?? []) {
      if (color.get(d) === GREY) cycles.push([...stack.slice(stack.indexOf(d)), d]);
      else if (color.get(d) === WHITE) dfs(d);
    }
    stack.pop();
    color.set(n, BLACK);
  }
  for (const f of files) if (color.get(f) === WHITE) dfs(f);
  return { files, cycles };
}

let failed = false;
for (const root of roots) {
  const ROOT = resolve(root);
  const { files, cycles } = cyclesUnder(ROOT);
  if (cycles.length) {
    failed = true;
    console.error(`${cycles.length} import cycle(s) under ${root}:`);
    for (const c of cycles) console.error("  " + c.map((p) => p.slice(ROOT.length + 1)).join(" -> "));
  } else {
    console.log(`no import cycles among ${files.length} files under ${root}`);
  }
}
if (failed) process.exit(1);
