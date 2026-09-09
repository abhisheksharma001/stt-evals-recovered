// R-18 (O-102). R-16 removed three dead Replit packages and a scope-wide
// supply-chain waiver, and deliberately KEPT a fourth package that does real
// work off Replit. The scan that proved both halves lived only in that PR's
// description, so nothing stops the next sweep from undoing either one.
//
// Two directions, because a one-directional scan grades this repo's own
// deliberate exception as a success the moment somebody deletes it:
//
//   1. Nothing R-16 removed is referenced again -- and the waiver has not
//      widened back to the `@replit/*` scope. A blanket scope exemption
//      waives the 1-day quarantine for packages a third party has not
//      published yet, which is the standing hole R-16 closed.
//   2. `@replit/vite-plugin-runtime-error-modal` is still wired: declared in
//      artifacts/stt-benchmark and imported by its vite config, and every
//      other workspace package either declares AND imports it or does
//      neither. A half-wired package installs a dependency nothing loads,
//      or imports one nothing installs.
//
// stt-benchmark is the anchor on purpose. Deriving the whole check from
// "whatever declares it" would pass an empty repo, so one package has to be
// named. mockup-sandbox is not named (O-99 may delete it) -- it is covered
// by the both-or-neither rule instead.
//
// Comment lines are skipped. PR #133 hit that false positive: prose
// documenting a removal counted as a reference to it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const KEPT = "@replit/vite-plugin-runtime-error-modal";

/** Every string R-16 took out. Each one is a package name, so a bare
 *  substring match is exact enough -- and `@replit/` alone is not on this
 *  list, because KEPT contains it. */
const REMOVED = [
  "@replit/vite-plugin-cartographer",
  "@replit/vite-plugin-dev-banner",
  "@replit/connectors-sdk",
  "stripe-replit-sync",
];

/** The scope glob, in the forms a yaml allowlist can spell it. Matched
 *  separately from REMOVED because it is a pattern, not a package. */
const SCOPE_WAIVER = [/'@replit\/\*'/, /"@replit\/\*"/, /(^|\s)-\s*@replit\/\*\s*$/];

/** The package that must stay wired, and the file that must import it. */
const ANCHOR_PKG = "artifacts/stt-benchmark";

const failures = [];

function tracked() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
}

/** Drops whole-line comments in the three syntaxes this repo's non-doc files
 *  use (`//`, `#`, and jsdoc continuation `*`). Deliberately not a parser:
 *  a trailing comment on a line of real config still counts, which is the
 *  safe direction to be wrong in. */
function codeLines(text) {
  return text.split("\n").map((line, i) => ({ line, no: i + 1 })).filter(({ line }) => {
    const t = line.trim();
    return t !== "" && !t.startsWith("//") && !t.startsWith("#") && !t.startsWith("*") && !t.startsWith("/*");
  });
}

// ---- direction 1: nothing removed came back -------------------------------
for (const file of tracked()) {
  if (file.endsWith(".md")) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // binary or unreadable: nothing to match anyway
  }
  for (const { line, no } of codeLines(text)) {
    for (const pkg of REMOVED) {
      if (line.includes(pkg)) failures.push(`REMOVED-BUT-BACK  ${file}:${no}  ${pkg}`);
    }
    for (const re of SCOPE_WAIVER) {
      if (re.test(line)) failures.push(`SCOPE-WAIVER-BACK  ${file}:${no}  @replit/* waives the quarantine for the whole scope`);
    }
  }
}

// ---- direction 2: the package that was kept is still wired ----------------
const manifests = tracked().filter((f) => f.endsWith("package.json") && !f.includes("node_modules"));
for (const manifest of manifests) {
  const pkgDir = dirname(manifest);
  const declared = readFileSync(manifest, "utf8").includes(`"${KEPT}"`);
  const configPath = join(pkgDir, "vite.config.ts");
  const imported = existsSync(configPath) && readFileSync(configPath, "utf8").includes(KEPT);

  if (declared && !imported) {
    failures.push(`HALF-WIRED  ${manifest}  declares ${KEPT}, ${configPath} does not import it`);
  }
  if (imported && !declared) {
    failures.push(`HALF-WIRED  ${configPath}  imports ${KEPT}, ${manifest} does not declare it`);
  }
  if (pkgDir === ANCHOR_PKG && !declared) {
    failures.push(`KEPT-BUT-GONE  ${manifest}  ${KEPT} was kept on purpose (R-16) and is no longer declared`);
  }
}

// A declared version of `catalog:` resolves through pnpm-workspace.yaml, so
// the catalog entry is part of "wired" -- without it install fails, which is
// a loud failure, but the allowlist entry beside it is the quiet one: lose it
// and the package silently falls back under the 1-day quarantine.
const workspace = readFileSync("pnpm-workspace.yaml", "utf8").split("\n");

/** The indented lines under a top-level yaml key, up to the next one. Enough
 *  yaml for a flat list; a real parser would be a dependency for two lookups. */
function blockUnder(key) {
  const start = workspace.findIndex((l) => l.trimEnd() === `${key}:`);
  if (start < 0) return null;
  const rest = workspace.slice(start + 1);
  const end = rest.findIndex((l) => /^[A-Za-z]/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

for (const key of ["catalog", "minimumReleaseAgeExclude"]) {
  const block = blockUnder(key);
  if (block === null) {
    failures.push(`KEPT-BUT-GONE  pnpm-workspace.yaml  no ${key}: block at all`);
  } else if (!block.includes(KEPT)) {
    failures.push(`KEPT-BUT-GONE  pnpm-workspace.yaml  ${KEPT} is missing from ${key}`);
  }
}

if (failures.length > 0) {
  console.error("Replit residue check failed:\n");
  for (const f of failures) console.error(`  ${f}`);
  console.error(`\n${failures.length} problem(s). R-16 is the reasoning; docs/step-register.md R-18 is this check.`);
  process.exit(1);
}
console.log(`ok: nothing R-16 removed is referenced, ${KEPT} is still wired`);
