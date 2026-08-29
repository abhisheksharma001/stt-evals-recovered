// Walks relative imports under artifacts/api-server/src and fails on any
// cycle. Acceptance check for T-75; cheap enough to run in CI.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(process.argv[2] ?? "artifacts/api-server/src");
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) files.push(p);
  }
})(ROOT);

const resolveImport = (from, spec) => {
  const base = resolve(dirname(from), spec);
  for (const c of [base, base + ".ts", join(base, "index.ts")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
};

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

const WHITE = 0, GREY = 1, BLACK = 2;
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

if (cycles.length) {
  console.error(`${cycles.length} import cycle(s) under ${ROOT}:`);
  for (const c of cycles) console.error("  " + c.map((p) => p.slice(ROOT.length + 1)).join(" -> "));
  process.exit(1);
}
console.log(`no import cycles among ${files.length} files under ${ROOT}`);
