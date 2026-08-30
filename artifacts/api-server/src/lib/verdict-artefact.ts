import type { HeadlineVerdict } from "@workspace/scoring";
import type { BulkVerdicts } from "./verdict";

/**
 * T-32 (PRD-v4 D.6 / U-9): the shareable, dated verdict artefact.
 *
 * A CEO does not need the app; they need one screen they can attach to an
 * email and that still says something true a month later. So this is NOT a
 * live view: it is a single self-contained HTML document (no scripts, no
 * external assets, print-clean) rendered server-side from the same
 * `bulkVerdicts` numbers the Results page shows, stamped with the moment
 * it was produced, the build SHA that produced it and the scoring version
 * -- so two artefacts a month apart can be told apart, and a later
 * re-generation that disagrees is visibly a different build or a different
 * date, never a silent rewrite.
 *
 * Rules carried over from T-20/T-21, non-negotiable:
 *  - "Winner" text only ever comes from a `decision === "winner"` verdict.
 *    The leader of a too_close / too_few_calls group is named as the
 *    leader, never as the winner.
 *  - Null never renders as zero or as blank: every unavailable figure says
 *    why it is unavailable.
 *  - The cost delta is list price vs list price ($/min, operator-entered),
 *    footnoted as such (docs/logic-register.md: rates must be verified
 *    against the provider's pricing page before a financial decision).
 *
 * Every string that came from the database goes through `esc` -- bulk
 * names, client labels and provider names are operator/Vapi-controlled
 * text and this document is opened in a browser.
 */

export type VerdictArtefactInput = {
  bulk: { id: string; name: string; status: string; createdAt: Date; completedAt: Date | null };
  verdicts: BulkVerdicts;
  /** List price per minute (USD) by provider id, from benchmark_providers. */
  listPricePerMinute: Record<string, number>;
  producedAt: Date;
  buildCommitSha: string;
  scoringVersion: string;
};

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

const DECISION_LABEL: Record<HeadlineVerdict["decision"], string> = {
  winner: "Winner",
  too_close: "Too close to call",
  too_few_calls: "Not enough calls",
  insufficient: "Only one provider",
};

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
const fmtStamp = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
const fmtRate = (usd: number) => `$${usd.toFixed(4)}/min`;
const n = (v: number) => v.toLocaleString("en-US");

/** The cost line for one group. Returns prose, never a bare number, so the
 * reason a delta is missing is always on the page. */
export function costDeltaLine(
  v: HeadlineVerdict,
  nameOf: (id: string | null) => string,
  price: Record<string, number>,
): string {
  if (v.decision !== "winner" || !v.winnerProviderId) return "No cost delta: no winner is named on this evidence.";
  const winner = v.winnerProviderId;
  const wp = price[winner];
  if (wp === undefined) return `No cost delta: no list price on file for ${nameOf(winner)}.`;
  if (!v.productionProviderId) {
    return `${nameOf(winner)} list price ${fmtRate(wp)}. No delta: the provider in production today for these calls is unknown or was not benchmarked in this bulk.`;
  }
  if (v.productionIsLeader || v.productionProviderId === winner) {
    return `${nameOf(winner)} is already in production today (${fmtRate(wp)}); switching changes nothing.`;
  }
  const pp = price[v.productionProviderId];
  if (pp === undefined) return `${nameOf(winner)} list price ${fmtRate(wp)}. No delta: no list price on file for production (${nameOf(v.productionProviderId)}).`;
  if (pp === 0) return `${nameOf(winner)} ${fmtRate(wp)} vs production ${nameOf(v.productionProviderId)} ${fmtRate(pp)}: production has no list price entered, so no percentage.`;
  const pct = ((wp - pp) / pp) * 100;
  const dir = pct === 0 ? "same list price as" : pct < 0 ? `${Math.abs(pct).toFixed(0)}% cheaper per minute than` : `${pct.toFixed(0)}% more expensive per minute than`;
  return `${nameOf(winner)} ${fmtRate(wp)} is ${dir} production ${nameOf(v.productionProviderId)} ${fmtRate(pp)}.`;
}

function groupSection(g: BulkVerdicts["groups"][number], nameOf: (id: string | null) => string, price: Record<string, number>): string {
  const v = g.verdict;
  const label = g.clientLabel ?? "Calls with no account label on file";
  const headline =
    v.decision === "winner" && v.winnerProviderId
      ? `${esc(nameOf(v.winnerProviderId))} wins${v.marginPct != null ? ` by ${v.marginPct.toFixed(0)}% fewer disagreements per 100 words than ${esc(nameOf(v.runnerUpProviderId))}` : ""}.`
      : v.leaderProviderId
        ? `Ahead, not a winner: ${esc(nameOf(v.leaderProviderId))}.`
        : "No winner named.";
  const evidence: string[] = [`${n(v.evidenceCalls)} call${v.evidenceCalls === 1 ? "" : "s"} scored`, `${n(g.callCount)} call${g.callCount === 1 ? "" : "s"} in group`];
  if (v.noiseFloor) {
    // T-81: the 95% CI interval stays in the JSON API; the share page says
    // "margin of error" and leaves the numbers to the engineers' endpoint.
    evidence.push(`${n(v.noiseFloor.sharedCalls)} calls both ran`);
  } else {
    evidence.push("not enough calls both ran (need 5)");
  }
  if (v.callsToSettle != null) evidence.push(`about ${n(v.callsToSettle)} calls both ran would decide it`);
  const production = g.production
    ? `In production today: ${esc(g.production.vendor)}${g.production.model ? ` ${esc(g.production.model)}` : ""} on ${n(g.production.coverage)} of ${n(g.production.total)} calls${v.vsProductionPct != null ? ` — winner has ${v.vsProductionPct > 0 ? `${v.vsProductionPct.toFixed(0)}% fewer` : `${Math.abs(v.vsProductionPct).toFixed(0)}% more`} disagreements than production` : ""}.`
    : "In production today: unknown (no call in this group recorded its live provider).";
  const caveats: string[] = [];
  if (v.provisional) caveats.push(`Early read (under 20 calls): trust the direction, not the size.`);
  if (v.confidenceComparable.total > 0 && v.confidenceComparable.reporting < v.confidenceComparable.total)
    caveats.push(`Only ${v.confidenceComparable.reporting} of ${v.confidenceComparable.total} providers report per-word confidence; those unsure-word spans are left out of this metric so the comparison stays like-for-like.`);
  const rates = [...v.rates]
    .sort((a, b) => a.flagsPer100Words - b.flagsPer100Words)
    .map(
      (r) =>
        `<tr><td>${esc(nameOf(r.providerId))}${r.providerId === v.winnerProviderId && v.decision === "winner" ? ' <span class="tag">winner</span>' : ""}${r.providerId === v.productionProviderId ? ' <span class="tag muted">production</span>' : ""}</td><td class="num">${r.flagsPer100Words.toFixed(2)}</td><td class="num">${n(r.calls)}</td><td class="num">${n(r.totalFlags)}</td><td class="num">${n(r.totalWords)}</td><td class="num">${price[r.providerId] !== undefined ? fmtRate(price[r.providerId]) : "not on file"}</td></tr>`,
    )
    .join("");
  return `
<section class="group">
  <h2>${esc(label)} <span class="chip ${v.decision}">${DECISION_LABEL[v.decision]}</span></h2>
  <p class="headline">${headline}</p>
  <p class="sentence">${esc(v.sentence)}</p>
  <p class="meta">${esc(evidence.join(" · "))}</p>
  <p class="meta">${production}</p>
  <p class="meta">Cost: ${esc(costDeltaLine(v, nameOf, price))}</p>
  ${caveats.map((c) => `<p class="caveat">${esc(c)}</p>`).join("")}
  <table>
    <thead><tr><th>Provider</th><th class="num">Disagreements / 100 words ↓</th><th class="num">Calls</th><th class="num">Flags</th><th class="num">Words</th><th class="num">List price</th></tr></thead>
    <tbody>${rates}</tbody>
  </table>
</section>`;
}

export function renderVerdictArtefact(input: VerdictArtefactInput): string {
  const { bulk, verdicts, listPricePerMinute: price, producedAt, buildCommitSha, scoringVersion } = input;
  const nameOf = (id: string | null) => (id ? (verdicts.providers.find((p) => p.id === id)?.name ?? id) : "?");
  const groups = verdicts.groups;
  const counts = { winner: 0, too_close: 0, too_few_calls: 0, insufficient: 0 };
  for (const g of groups) counts[g.verdict.decision] += 1;
  const winners = groups.filter((g) => g.verdict.decision === "winner");
  const totalEvidence = groups.reduce((s, g) => s + g.verdict.evidenceCalls, 0);

  let summary: string;
  if (groups.length === 0) summary = "No verdict: this bulk has no scored calls.";
  else if (winners.length > 0) {
    const tally = new Map<string, number>();
    for (const g of winners) tally.set(g.verdict.winnerProviderId ?? "?", (tally.get(g.verdict.winnerProviderId ?? "?") ?? 0) + 1);
    const [topId, topN] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    summary = `${esc(nameOf(topId))} wins ${topN} of ${groups.length} client group${groups.length === 1 ? "" : "s"} outright.${groups.length - winners.length > 0 ? ` The other ${groups.length - winners.length} ${groups.length - winners.length === 1 ? "has" : "have"} no clear winner on this evidence.` : ""}`;
  } else if (counts.too_close > 0 && counts.too_close >= counts.too_few_calls)
    summary = "No clear winner: the top providers are inside the noise in every group with enough calls to judge.";
  else summary = `No clear winner yet: ${counts.too_few_calls} of ${groups.length} client group${groups.length === 1 ? "" : "s"} have fewer than 5 calls shared by the top two providers.`;

  const status = bulk.status === "complete" ? "complete" : `${bulk.status} — figures may change if the bulk is retried`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>STT verdict — ${esc(bulk.name)} — ${fmtDate(producedAt)}</title>
<style>
  /* T-70: same warm light palette as the app (stt-benchmark index.css) so the
     artefact and a screenshot of the app read as one product. */
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 48px; font: 15px/1.5 Georgia, "Times New Roman", serif; color: #2b2017; background: #f7f4ed; max-width: 880px; }
  h1 { font-size: 26px; margin: 0 0 4px; line-height: 1.2; }
  h2 { font-size: 18px; margin: 0 0 6px; }
  .stamp { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: #695b4f; margin-bottom: 28px; }
  .summary { font-size: 20px; line-height: 1.35; margin: 0 0 8px; }
  .counts { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: #695b4f; margin: 0 0 24px; }
  .group { border-top: 1px solid #dad2c8; padding: 20px 0 8px; break-inside: avoid; }
  .headline { font-size: 17px; margin: 0 0 4px; }
  .sentence { margin: 0 0 8px; color: #2b2017; }
  .meta { margin: 0 0 4px; font-size: 13px; color: #695b4f; }
  .caveat { margin: 6px 0; font-size: 13px; color: #8e5a0b; border-left: 3px solid #8e5a0b; padding-left: 8px; }
  .chip { display: inline-block; font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .04em; padding: 4px 8px; border-radius: 999px; border: 1px solid #b3a89a; vertical-align: middle; margin-left: 6px; }
  .chip.winner { border-color: #27684a; color: #27684a; }
  .chip.too_close { border-color: #8e5a0b; color: #8e5a0b; }
  .tag { font: 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; color: #27684a; border: 1px solid #27684a; border-radius: 3px; padding: 2px 4px; margin-left: 4px; }
  .tag.muted { color: #695b4f; border-color: #b3a89a; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0 6px; font-size: 13px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #e8e1d6; }
  th { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #695b4f; }
  .num { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .legend { margin-top: 28px; border-top: 1px solid #dad2c8; padding-top: 14px; font-size: 12px; color: #695b4f; }
  .legend p { margin: 0 0 6px; }
  @media print { body { padding: 0; } .group { page-break-inside: avoid; } }
</style>
</head>
<body>
<h1>STT verdict: ${esc(bulk.name)}</h1>
<div class="stamp">
  Produced ${fmtStamp(producedAt)} · build ${esc(buildCommitSha)} · scoring ${esc(scoringVersion)} · bulk ${esc(bulk.id)}<br>
  Bulk launched ${fmtDate(bulk.createdAt)}${bulk.completedAt ? `, completed ${fmtDate(bulk.completedAt)}` : ""} · status: ${esc(status)}
</div>
<p class="summary">${summary}</p>
<p class="counts">${groups.length} client group${groups.length === 1 ? "" : "s"} · ${n(totalEvidence)} call${totalEvidence === 1 ? "" : "s"} scored · ${counts.winner} winner${counts.winner === 1 ? "" : "s"} · ${counts.too_close} too close · ${counts.too_few_calls} not enough calls${counts.insufficient ? ` · ${counts.insufficient} only one provider` : ""}</p>
${groups.map((g) => groupSection(g, nameOf, price)).join("\n")}
<div class="legend">
  <p><strong>Winner</strong> = fewest disagreements per 100 words, by more than the margin of error. Lower is better. Anything else is undecided, not a tie. Under 20 calls is an early read.<br><span class="muted">Mechanism: disagreements are cross-provider word disagreements plus entity mismatches (a provider's own low-confidence spans excluded); the margin of error is a 95% bootstrap interval over 1,000 reshuffles of the calls both providers scored.</span></p>
  <p><strong>Cost figures</strong> are operator-entered list prices per minute at the time this page was produced. Verify against the provider's current pricing page and any contract before making a financial decision.</p>
  <p><strong>This is a dated snapshot.</strong> It was computed from the scores stored for this bulk at the time above. Re-generating it later on a different build or after retries may give different figures; compare the stamp.</p>
</div>
</body>
</html>
`;
}
