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

function render(verdict: HeadlineVerdict, extra: Partial<Parameters<typeof renderVerdictArtefact>[0]> = {}) {
  const verdicts: BulkVerdicts = {
    bulkId: "bulk-1",
    providers: [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Bravo" },
    ],
    groups: [{ clientLabel: "Rush <Parts>", assistantIds: ["x"], callCount: 9, vertical: "rush", production: { vendor: "Bravo", model: null, coverage: 9, total: 9 }, verdict }],
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
    expect(html).toContain("Ahead, not a winner: Alpha.");
    expect(html).not.toContain("Alpha wins");
    expect(html).not.toContain('class="tag">winner');
    expect(html).toContain("Early read (under 20 calls)");
    expect(html).toContain("Only 1 of 2 providers report per-word confidence");
  });

  it("renders the winner, margin and cost delta vs production when a winner is named", () => {
    const html = render({ ...base, decision: "winner", winnerProviderId: "a", marginPct: 25, vsProductionPct: 25, provisional: false, evidenceCalls: 30 });
    expect(html).toContain("Alpha wins by 25% fewer disagreements per 100 words than Bravo.");
    expect(html).toContain("Alpha $0.0040/min is 50% cheaper per minute than production Bravo $0.0080/min.");
    expect(html).toContain("winner has 25% fewer disagreements than production");
    expect(html).not.toContain("Early read");
  });
});

describe("costDeltaLine", () => {
  it("explains every missing delta instead of printing a number", () => {
    expect(costDeltaLine(base, nameOf, price)).toContain("no winner is named");
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
