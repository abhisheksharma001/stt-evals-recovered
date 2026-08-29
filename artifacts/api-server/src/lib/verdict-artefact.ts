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
  winner: "Clear winner",
  too_close: "Too close to call",
  too_few_calls: "Too few calls",
  insufficient: "Not enough providers",
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
    return `${nameOf(winner)} list price ${fmtRate(wp)}. No delta: the production transcriber for these calls is unknown or was not benchmarked in this bulk.`;
  }
  if (v.productionIsLeader || v.productionProviderId === winner) {
    return `${nameOf(winner)} is already the production transcriber (${fmtRate(wp)}); switching changes nothing.`;
  }
  const pp = price[v.productionProviderId];
  if (pp === undefined) return `${nameOf(winner)} list price ${fmtRate(wp)}. No delta: no list price on file for production (${nameOf(v.productionProviderId)}).`;
  if (pp === 0) return `${nameOf(winner)} ${fmtRate(wp)} vs production ${nameOf(v.productionProviderId)} ${fmtRate(pp)}: production has no list price entered, so no percentage.`;
  const pct = ((wp - pp) / pp) * 100;
  const dir = pct === 0 ? "same list price as" : pct < 0 ? `${Math.abs(pct).toFixed(0)}% cheaper per minute than` : `${pct.toFixed(0)}% dearer per minute than`;
  return `${nameOf(winner)} ${fmtRate(wp)} is ${dir} production ${nameOf(v.productionProviderId)} ${fmtRate(pp)}.`;
}

function groupSection(g: BulkVerdicts["groups"][number], nameOf: (id: string | null) => string, price: Record<string, number>): string {
  const v = g.verdict;
  const label = g.clientLabel ?? "Calls with no account label on file";
  const headline =
    v.decision === "winner" && v.winnerProviderId
      ? `${esc(nameOf(v.winnerProviderId))} wins${v.marginPct != null ? ` by ${v.marginPct.toFixed(0)}% fewer flags per 100 words than ${esc(nameOf(v.runnerUpProviderId))}` : ""}.`
      : v.leaderProviderId
        ? `No winner named. Current leader: ${esc(nameOf(v.leaderProviderId))} (not a verdict).`
        : "No winner named.";
  const evidence: string[] = [`${n(v.evidenceCalls)} evidence call${v.evidenceCalls === 1 ? "" : "s"}`, `${n(g.callCount)} call${g.callCount === 1 ? "" : "s"} in group`];
  if (v.noiseFloor) {
    evidence.push(`${n(v.noiseFloor.sharedCalls)} shared by top two`);
    evidence.push(`95% CI of gap [${v.noiseFloor.ci95[0].toFixed(2)}, ${v.noiseFloor.ci95[1].toFixed(2)}] flags/100 words`);
  } else {
    evidence.push("no noise floor (fewer than 5 shared calls)");
  }
  if (v.callsToSettle != null) evidence.push(`~${n(v.callsToSettle)} more shared calls would settle it`);
  const production = g.production
    ? `Production today: ${esc(g.production.vendor)}${g.production.model ? ` ${esc(g.production.model)}` : ""} on ${n(g.production.coverage)} of ${n(g.production.total)} calls${v.vsProductionPct != null ? ` — winner is ${v.vsProductionPct > 0 ? `${v.vsProductionPct.toFixed(0)}% cleaner than` : `${Math.abs(v.vsProductionPct).toFixed(0)}% worse than`} production` : ""}.`
    : "Production today: unknown (no call in this group recorded its live transcriber).";
  const caveats: string[] = [];
  if (v.provisional) caveats.push(`Provisional: fewer than 20 evidence calls. Treat the direction, not the size, as the finding.`);
  if (v.confidenceComparable.total > 0 && v.confidenceComparable.reporting < v.confidenceComparable.total)
    caveats.push(`Only ${v.confidenceComparable.reporting} of ${v.confidenceComparable.total} providers report per-word confidence; confidence spans are excluded from this metric so the comparison stays like-for-like.`);
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
    <thead><tr><th>Provider</th><th class="num">Flags / 100 words</th><th class="num">Calls</th><th class="num">Flags</th><th class="num">Words</th><th class="num">List price</th></tr></thead>
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
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 48px; font: 15px/1.5 Georgia, "Times New Roman", serif; color: #1a1a1a; background: #fff; max-width: 880px; }
  h1 { font-size: 26px; margin: 0 0 4px; line-height: 1.2; }
  h2 { font-size: 18px; margin: 0 0 6px; }
  .stamp { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: #555; margin-bottom: 28px; }
  .summary { font-size: 20px; line-height: 1.35; margin: 0 0 8px; }
  .counts { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: #555; margin: 0 0 24px; }
  .group { border-top: 1px solid #ddd; padding: 20px 0 8px; break-inside: avoid; }
  .headline { font-size: 17px; margin: 0 0 4px; }
  .sentence { margin: 0 0 8px; color: #333; }
  .meta { margin: 0 0 4px; font-size: 13px; color: #444; }
  .caveat { margin: 6px 0; font-size: 13px; color: #7a4b00; border-left: 3px solid #d99a2b; padding-left: 8px; }
  .chip { display: inline-block; font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .04em; padding: 4px 8px; border-radius: 999px; border: 1px solid #999; vertical-align: middle; margin-left: 6px; }
  .chip.winner { border-color: #2a7a3b; color: #2a7a3b; }
  .chip.too_close { border-color: #b8860b; color: #8a6508; }
  .tag { font: 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; color: #2a7a3b; border: 1px solid #2a7a3b; border-radius: 3px; padding: 2px 4px; margin-left: 4px; }
  .tag.muted { color: #666; border-color: #999; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0 6px; font-size: 13px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #e5e5e5; }
  th { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #555; }
  .num { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .legend { margin-top: 28px; border-top: 1px solid #ddd; padding-top: 14px; font-size: 12px; color: #555; }
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
<p class="counts">${groups.length} client group${groups.length === 1 ? "" : "s"} · ${n(totalEvidence)} evidence call${totalEvidence === 1 ? "" : "s"} · ${counts.winner} winner${counts.winner === 1 ? "" : "s"} · ${counts.too_close} too close · ${counts.too_few_calls} too few calls${counts.insufficient ? ` · ${counts.insufficient} not enough providers` : ""}</p>
${groups.map((g) => groupSection(g, nameOf, price)).join("\n")}
<div class="legend">
  <p><strong>What "winner" means.</strong> Fewer cross-provider flags per 100 words (confidence spans excluded), and the gap to the runner-up survived 1,000 reshuffles of the calls both providers scored (95% interval excludes zero). Anything else is undecided, not a tie. Fewer than 20 evidence calls is provisional.</p>
  <p><strong>Cost figures</strong> are operator-entered list prices per minute at the time this page was produced. Verify against the provider's current pricing page and any contract before making a financial decision.</p>
  <p><strong>This is a dated snapshot.</strong> It was computed from the scores stored for this bulk at the time above. Re-generating it later on a different build or after retries may give different figures; compare the stamp.</p>
</div>
</body>
</html>
`;
}
