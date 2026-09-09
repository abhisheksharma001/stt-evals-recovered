// R-47 (from R-45/R-46): the register needs a check that counts, not a claim
// that remembers.
//
// R-35 reported that all 100 entries in ox-alpha/bug-register.md carried a
// disposition. Ten of them had never been named in docs/step-register.md at
// all, and one of those ten -- B-88, no `error` listener on the pg pool --
// was a live P0 that killed the API process on any idle-connection drop. The
// claim was written from the tranche just finished rather than from a scan,
// and nothing in CI could tell the difference.
//
// This is deliberately the weakest rule that has no false positives: every
// `### B-<n>` heading in the register must be named SOMEWHERE in the step
// register. It does not check that the mention is a disposition -- a stricter
// rule was tried first (the mention must be the first B-number on its line)
// and it flagged 11 entries that are correctly dispositioned inside grouped
// prose such as "**Moot -- 7.** B-51, B-58, B-59 name ...". A check that cries
// wolf gets switched off, so this one only catches the entry nobody wrote down
// anywhere, which is exactly what happened to B-88.
//
// Measured against be0294b (the commit before R-45): 10 unnamed, 0 false
// positives.
import { readFileSync } from "node:fs";

const REGISTER = "ox-alpha/bug-register.md";
const STEPS = "docs/step-register.md";

const register = readFileSync(REGISTER, "utf8");
const steps = readFileSync(STEPS, "utf8");

const declared = [...register.matchAll(/^### B-(\d+) /gm)].map((m) => Number(m[1]));
if (declared.length === 0) {
  console.error(`check-register-coverage: found no "### B-<n>" entries in ${REGISTER} -- has the format changed?`);
  process.exit(1);
}

const unnamed = declared.filter((n) => !new RegExp(`\\bB-${n}\\b`).test(steps));

if (unnamed.length > 0) {
  console.error(
    `check-register-coverage: ${unnamed.length} of ${declared.length} entries in ${REGISTER} are named nowhere in ${STEPS}:`,
  );
  for (const n of unnamed) {
    const heading = register.match(new RegExp(`^### B-${n} .*$`, "m"))?.[0] ?? `### B-${n}`;
    console.error(`  ${heading.slice(0, 120)}`);
  }
  console.error(
    "\nAn entry nobody has written down is an entry nobody has read. Give each one a\n" +
      "disposition in a step block -- fixed, moot, live, refuted -- with the line that\n" +
      "decides it. B-88 sat here as a live P0 through four triage passes.",
  );
  process.exit(1);
}

console.log(`check-register-coverage: all ${declared.length} register entries are named in the step register.`);
