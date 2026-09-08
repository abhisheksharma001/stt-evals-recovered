import { describe, expect, it } from "vitest";
import type { HeadlineVerdict } from "@workspace/scoring";
import { costDeltaLine, esc, renderVerdictArtefact } from "./verdict-artefact";
import type { BulkVerdicts } from "./verdict";

const base: HeadlineVerdict = {
  decision: "too_close",
  winnerProviderId: null,
  runnerUpProviderId: "b",
  leaderProviderId: "a",
  marginPct: null,
  vsProductionPct: null,
  productionProviderId: "b",
  productionIsLeader: false,
  evidenceCalls: 7,
  provisional: true,
  callsToSettle: 12,
  noiseFloor: { sharedCalls: 6, difference: 0.4, ci95: [-0.2, 1.1], withinNoise: true },
  confidenceComparable: { reporting: 1, total: 2 },
  rates: [
    { providerId: "a", flagsPer100Words: 1.2, calls: 7, totalFlags: 12, totalWords: 1000 },
    { providerId: "b", flagsPer100Words: 1.6, calls: 7, totalFlags: 16, totalWords: 1000 },
  ],
  sentence: "Too close to call on 7 calls.",
};

const nameOf = (id: string | null) => ({ a: "Alpha", b: "Bravo" })[id ?? ""] ?? "?";
const price = { a: 0.004, b: 0.008 };

function render(
  verdict: HeadlineVerdict,
  extra: Partial<Parameters<typeof renderVerdictArtefact>[0]> = {},
  productionDisagreement: BulkVerdicts["groups"][number]["productionDisagreement"] = null,
) {
  const verdicts: BulkVerdicts = {
    bulkId: "bulk-1",
    providers: [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Bravo" },
    ],
    groups: [{ clientLabel: "Rush <Parts>", assistantIds: ["x"], callCount: 9, vertical: "rush", production: { vendor: "Bravo", model: null, coverage: 9, total: 9 }, productionDisagreement, verdict }],
  };
  return renderVerdictArtefact({
    bulk: { id: "bulk-1", name: 'Aug "27" bulk', status: "complete", createdAt: new Date("2026-08-27T10:00:00Z"), completedAt: new Date("2026-08-27T11:00:00Z") },
    verdicts,
    listPricePerMinute: price,
    producedAt: new Date("2026-08-30T04:05:00Z"),
    buildCommitSha: "abc123def456",
    scoringVersion: "v2",
    ...extra,
  });
}

// T-32: the artefact is dated, attributed, and never names a winner the
// verdict did not name.
describe("renderVerdictArtefact", () => {
  it("stamps date, build SHA and scoring version, and escapes operator text", () => {
    const html = render(base);
    expect(html).toContain("Produced 2026-08-30 04:05 UTC");
    expect(html).toContain("build abc123def456");
    expect(html).toContain("scoring v2");
    expect(html).toContain("Rush &lt;Parts&gt;");
    expect(html).toContain("Aug &quot;27&quot; bulk");
    expect(html).not.toContain("<Parts>");
    expect(html).not.toContain("<script");
  });

  it("names the leader as leader, not winner, when the decision is too_close", () => {
    const html = render(base);
    expect(html).toContain("Too close to call");
    expect(html).toContain("Ahead, but not decided: Alpha.");
    expect(html).not.toContain("Alpha has the least disagreement");
    expect(html).not.toContain('class="tag">fewest');
    expect(html).toContain("Early read (under 20 calls)");
    expect(html).toContain("Only 1 of 2 providers report per-word confidence");
  });

  it("renders the winner, margin and cost delta vs production when a winner is named", () => {
    const html = render({ ...base, decision: "winner", winnerProviderId: "a", marginPct: 25, vsProductionPct: 25, provisional: false, evidenceCalls: 30 });
    expect(html).toContain("Alpha has the least disagreement: 25% fewer disagreements per 100 words than Bravo.");
    expect(html).toContain("Alpha $0.0040/min is 50% cheaper per minute than production Bravo $0.0080/min.");
    expect(html).toContain("the named provider has 25% fewer disagreements than production");
    expect(html).not.toContain("Early read");
  });
});

// M-9 (PRD-v6 D1): the artefact is the file a client keeps. It may not hand
// them the word "Winner", and it must carry the qualifier that says what the
// number is NOT -- on every artefact, settled or not, without interaction.
describe("renderVerdictArtefact says 'Least disagreement', not 'Winner'", () => {
  it("labels a settled verdict 'Least disagreement' and prints 'Winner' nowhere", () => {
    const html = render({ ...base, decision: "winner", winnerProviderId: "a", marginPct: 25, provisional: false, evidenceCalls: 30 });
    expect(html).toContain("Least disagreement");
    expect(html).not.toContain("Winner");
  });

  it("carries the relative line whether or not a verdict settled", () => {
    for (const v of [base, { ...base, decision: "winner" as const, winnerProviderId: "a" }]) {
      const html = render(v);
      expect(html).toContain("Relative:");
      expect(html).toContain("Not a measured accuracy");
      expect(html).toContain("nothing here is scored against a human-checked transcript");
      // Corrections to M-9 as written: the step said "the same customer
      // audio" and "no transcript here was checked by a person". Neither is
      // true -- every bulk on file runs the mono mix, and 2 of 176 calls do
      // carry a human-written gold (the ranking just never reads one).
      expect(html).not.toContain("same customer audio");
      expect(html).not.toContain("checked by a person");
    }
  });
});

// M-9b: M-9 took the capital "Winner". The lowercase family survived it in 22
// rendered strings, including the row tag `winner` sitting under a heading
// that reads "Least disagreement", and the summary line "X wins N of M orgs
// outright". This is the guard that keeps the whole family out, not one
// phrase at a time: strip the parts of the document that legitimately carry
// the enum -- the <style> block and every class attribute, both driven by
// `decision` and both code, not copy -- and assert the visible text has no
// form of the word left, on every decision the verdict can reach.
describe("renderVerdictArtefact renders no form of 'winner' or 'wins'", () => {
  const visibleText = (html: string) =>
    html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/class="[^"]*"/g, "");

  it("holds on every decision", () => {
    const cases: HeadlineVerdict[] = [
      { ...base, decision: "winner", winnerProviderId: "a", marginPct: 25, vsProductionPct: 25, provisional: false, evidenceCalls: 30 },
      { ...base, decision: "winner", winnerProviderId: "a", marginPct: null, provisional: true, evidenceCalls: 6 },
      { ...base, decision: "too_close", leaderProviderId: "a" },
      { ...base, decision: "too_few_calls" },
      { ...base, decision: "insufficient", leaderProviderId: null },
    ];
    for (const v of cases) {
      const text = visibleText(render(v));
      expect(text).not.toMatch(/winner/i);
      expect(text).not.toMatch(/\bwins\b/i);
    }
  });

  it("names the row 'fewest' and settles a verdict with 'has the least disagreement'", () => {
    const html = render({ ...base, decision: "winner", winnerProviderId: "a", marginPct: 25, provisional: false, evidenceCalls: 30 });
    expect(html).toContain('<span class="tag">fewest</span>');
    expect(html).toContain("has the least disagreement");
  });

  it("says 'Nothing decided', not 'No winner', when the verdict refuses", () => {
    expect(render({ ...base, decision: "too_close", leaderProviderId: "a" })).toContain("Ahead, but not decided: Alpha.");
    expect(render({ ...base, decision: "insufficient", leaderProviderId: null })).toContain("Nothing decided.");
  });
});

// M-8b/R-3: production's own transcript first -- or nothing.
describe("renderVerdictArtefact production disagreement", () => {
  const measured = { rate: 0.041, leaderProviderId: "a", leaderRate: 0.018, calls: 19, totalCalls: 56 };

  it("states production's own disagreement beside the closest candidate's, on one scale", () => {
    const html = render(base, {}, measured);
    expect(html).toContain("4.1 of every 100 caller words");
    expect(html).toContain("The closest candidate on those same words, Alpha, sat at 1.8.");
    expect(html).toContain("over 19 of 56 calls");
    // Must not: production is never a row, a rank or a candidate.
    expect(html).toContain("never ranked with them");
    expect(html).not.toContain("__production__");
  });

  // R-3: the reader is already living with production's number, so it is the
  // first thing the document says and the first thing each org section says.
  it("puts production before the decision, in the document and in the section", () => {
    const html = render(base, {}, measured);
    const lead = html.indexOf("4.1 of every 100 caller words");
    const summary = html.indexOf("Nothing decided: the top providers are inside the noise");
    const decision = html.indexOf("Ahead, but not decided: Alpha.");
    expect(lead).toBeGreaterThan(-1);
    expect(summary).toBeGreaterThan(lead);
    expect(decision).toBeGreaterThan(lead);
    // The org's own line comes back a second time, inside its section --
    // and inside that section it is the paragraph in headline type, with the
    // decision demoted under it.
    expect(html.split("4.1 of every 100 caller words").length - 1).toBe(2);
    const section = html.slice(html.indexOf('<section class="group">'));
    expect(section).toContain('<p class="headline">Production today (Bravo) disagreed');
    expect(section).toContain('<p class="sentence">Ahead, but not decided: Alpha.</p>');
    expect(section.indexOf("4.1 of every 100 caller words")).toBeLessThan(section.indexOf("Ahead, but not decided"));
    // The caveat rides with it, once at the top and once in the section.
    expect(html).toContain("ran live during the call");
    expect(html).toContain("not the per-100-words flag count the ranking uses");
  });

  it("prefixes the org's name only when the bulk holds more than one", () => {
    const one = render(base, {}, measured);
    expect(one).not.toContain("Rush &lt;Parts&gt;: Production today");
    const two = render(base, {
      verdicts: {
        bulkId: "bulk-1",
        providers: [
          { id: "a", name: "Alpha" },
          { id: "b", name: "Bravo" },
        ],
        groups: [
          { clientLabel: "Rush <Parts>", assistantIds: ["x"], callCount: 9, vertical: "rush", production: { vendor: "Bravo", model: null, coverage: 9, total: 9 }, productionDisagreement: measured, verdict: base },
          { clientLabel: null, assistantIds: [null], callCount: 4, vertical: "rush", production: null, productionDisagreement: { ...measured, rate: 0.02 }, verdict: base },
        ],
      },
    });
    // Operator text is escaped before the sentence is composed, never after.
    expect(two).toContain("Rush &lt;Parts&gt;: Production today");
    expect(two).toContain("Calls with no org label on file: The transcriber in production today");
    expect(two).not.toContain("Rush <Parts>");
  });

  it("says nothing at all when there is no comparable number, never a zero", () => {
    // The default fixture is null, which is what both bulks on disk return:
    // they ran on the mono mix, where production's caller-only draft and the
    // candidates' both-speaker transcripts are not on one scale.
    const html = render(base);
    expect(html).not.toContain("Production today (");
    expect(html).not.toContain("of every 100 caller words");
    // The line that WAS always there is untouched, and the decision keeps the
    // big type it has when nothing displaces it.
    expect(html).toContain("In production today: Bravo on 9 of 9 calls");
    expect(html).toContain('<p class="headline">Ahead, but not decided: Alpha.</p>');
    expect(html).toContain('<p class="summary">Nothing decided: the top providers are inside the noise');
  });
});

describe("costDeltaLine", () => {
  it("explains every missing delta instead of printing a number", () => {
    expect(costDeltaLine(base, nameOf, price)).toContain("nothing is decided");
    const won = { ...base, decision: "winner" as const, winnerProviderId: "a" };
    expect(costDeltaLine({ ...won, productionProviderId: null }, nameOf, price)).toContain("provider in production today for these calls is unknown");
    expect(costDeltaLine(won, nameOf, { a: 0.004 })).toContain("no list price on file for production (Bravo)");
    expect(costDeltaLine(won, nameOf, { a: 0.004, b: 0 })).toContain("no list price entered");
    expect(costDeltaLine({ ...won, productionProviderId: "a", productionIsLeader: true }, nameOf, price)).toContain("already in production today");
    expect(costDeltaLine({ ...won, productionProviderId: "b" }, nameOf, { a: 0.012, b: 0.008 })).toContain("50% more expensive per minute than production Bravo");
  });
});

describe("esc", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(esc(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});
