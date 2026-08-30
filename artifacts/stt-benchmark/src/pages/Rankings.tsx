import * as React from "react"
import {
  useListBenchmarkRankings,
  useGetAppSettings,
  useListBulks,
  useGetBulk,
  getGetBulkQueryKey,
  useListBenchmarkCalls,
  useGetAssistantTranscriber,
  getGetAssistantTranscriberQueryKey,
  useListBenchmarkProviders,
  useGetBulkManifest,
  getGetBulkManifestQueryKey,
  type VerticalRanking,
  type BulkVerdicts,
  useGetCallDisagreement,
  getGetCallDisagreementQueryKey,
} from "@workspace/api-client-react"
import { Link } from "wouter"
import { Trophy, ArrowUpRight, ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, Download, Star, ShieldCheck, AlertTriangle, FileText, Building2 } from "lucide-react"
import { formatCents, formatMicrocents, formatPerMinute } from "@/lib/utils"
import { paidVsListDiffers } from "@/lib/paid-vs-list"

// T-123: recharts (~450 kB minified) rides only in the trend strip, and the
// trend strip lives behind the closed-by-default "More evidence" fold. A
// <details> renders its children even while closed, so a static import put
// the whole charting library in this page's chunk for every visitor who
// never opened the fold. Lazy + render-only-when-open keeps it out until
// someone actually asks for the chart.
const ClientTrendSection = React.lazy(() =>
  import("@/components/trend-strip").then((m) => ({ default: m.ClientTrendSection })),
)
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ProviderCorrelationCard } from "@/components/provider-correlation-card"
import { BulkVerdictBanner, GroupVerdictHeadline, findGroupVerdict, useBulkVerdicts } from "@/components/verdict-headline"
import { WordsToWatch } from "@/components/words-to-watch"
import { AssistantSignals } from "@/components/assistant-signals"
import { apiBase } from "@/lib/api-base"
import { ClientMonthlyCostLine, GroupVolumeLine, MonthlyCostCell, fmtUsd, monthlyCost, useGroupVolume, useListPrices, type GroupVolume } from "@/components/monthly-cost"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

// Sortable metric keys -- "rank" keeps the composite-score ordering the run
// computed server-side (FR-R1 adds per-metric resorting on top of it).
// 2026-08-27: wer/entityAccuracy retired (no gold transcript to score
// against) -- avgFlagCount/avgFlagSeverityScore (gold-free hybrid flagging)
// replace them as the primary ranking signal.
type SortKey = "rank" | "avgFlagCount" | "avgFlagSeverityScore" | "peerFlagsPer100Words" | "cleanCallRate" | "latencyFinalMs" | "costPerMinute" | "diarizationScore"

// Lower-is-better metrics sort ascending by default; accuracy metrics
// descending. Nulls always sink to the bottom regardless of direction --
// "not measured" must never masquerade as a great or terrible score.
const SORT_ASC_DEFAULT: Record<SortKey, boolean> = {
  rank: true,
  avgFlagCount: true,
  avgFlagSeverityScore: true,
  // T-19: rates from the API. Flags/100 words lower-is-better; clean-call
  // share higher-is-better.
  peerFlagsPer100Words: true,
  cleanCallRate: false,
  latencyFinalMs: true,
  costPerMinute: true,
  diarizationScore: false,
}

// T-81 copy: plain label on screen, exact mechanism in the title tooltip.
const SORT_LABELS: Record<SortKey, string> = {
  rank: "Rank",
  avgFlagCount: "Flags per call",
  avgFlagSeverityScore: "How serious (0–3)",
  peerFlagsPer100Words: "Disagreements / 100 words",
  cleanCallRate: "Clean calls",
  latencyFinalMs: "Speed",
  costPerMinute: "Paid / min",
  diarizationScore: "Speakers told apart",
}

const SORT_TITLES: Record<SortKey, string> = {
  rank: "From disagreements (cross-provider disagreement + wrong entities only), price and speed. Not from Flags per call, which includes a provider's own low-confidence words.",
  avgFlagCount: "Average flags per call, including a provider's own low-confidence words. Only providers that report confidence add those, so compare with care; the small 'peer' number below is what Rank uses.",
  avgFlagSeverityScore: "How serious the flags were, 0 = none .. 3 = high, averaged over this provider's transcripts in this group.",
  peerFlagsPer100Words: "Disagreements with the other providers plus wrong entities, per 100 words transcribed. Confidence excluded, so it is comparable across all providers and call lengths.",
  cleanCallRate: "Share of this provider's scored calls with zero disagreements.",
  latencyFinalMs: "Time from sending the audio to the final transcript.",
  costPerMinute: "What this bulk actually paid per audio minute, from each transcript's recorded cost -- not today's list price. When the Setup list price differs by more than 2%, the cell says so.",
  diarizationScore: "Share of calls where this provider told more than one speaker apart.",
}

/** ↓ = lower is better, ↑ = higher is better (T-81: every numeric column
 *  says its direction; the page-top legend says it once in words). */
const DIRECTION: Record<SortKey, "↓" | "↑"> = {
  rank: "↓",
  avgFlagCount: "↓",
  avgFlagSeverityScore: "↓",
  peerFlagsPer100Words: "↓",
  cleanCallRate: "↑",
  latencyFinalMs: "↓",
  costPerMinute: "↓",
  diarizationScore: "↑",
}

/**
 * T-116: the ranking's $/min is what the bulk PAID (each cell's recorded
 * cost over the group's audio minutes, computed in run-executor
 * aggregateRankingRows). It is not the Setup list price, and re-ranking
 * would not change it. So a price edit on Setup (T-62 moved flux from
 * $0.0043 to $0.0077) must show up here as a note, or a reader compares a
 * stale paid rate against today's price without knowing. Only speaks when
 * the two differ by more than 2% -- rounding noise on short calls stays
 * quiet.
 */
function PaidVsListNote({ paid, list }: { paid: number | null; list: number | undefined }) {
  // T-122: the threshold logic lives in lib/paid-vs-list.ts, unit-tested.
  if (!paidVsListDiffers(paid, list)) return null
  if (paid == null || list === undefined) return null // narrowing only; differs() already guaranteed both
  return (
    <span
      className="ml-1 rounded border border-warning/40 bg-warning/10 px-1 py-px text-[10px] text-warning"
      title={`This bulk paid ${formatPerMinute(paid)}; the list price on Setup is ${formatPerMinute(list)} today. The $/month column and the switch sentence use today's price.`}
      data-testid="paid-vs-list"
    >
      list {formatPerMinute(list).replace("/min", "")}
    </span>
  )
}

type RankingRow = VerticalRanking

function metricOf(r: RankingRow, key: SortKey): number | null {
  if (key === "rank") return r.rank
  return r.score[key] ?? null
}

function compareRows(a: RankingRow, b: RankingRow, key: SortKey, asc: boolean): number {
  const av = metricOf(a, key)
  const bv = metricOf(b, key)
  if (av === null && bv === null) return a.rank - b.rank
  if (av === null) return 1 // nulls last
  if (bv === null) return -1
  return asc ? av - bv : bv - av
}

// FR-R3: per-group decision export. The CSV mirrors exactly what the
// table shows (including nulls as empty cells), so an emailed spreadsheet can
// never disagree with the app.
function buildCsv(groupLabel: string, rows: RankingRow[]): string {
  const escape = (v: unknown): string => {
    const s = v == null ? "" : String(v)
    // B-91 (verified wave-2): the formula guard must test the RAW value —
    // a quoted field like "=IF(TRUE,1,0)" starts with `"` after escaping,
    // which bypassed the prefix check and still executed in Excel.
    const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
    return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
  }
  const header = [
    "assistant", "vertical", "rank", "provider_id", "provider_name",
    "avg_flag_count", "avg_flag_severity_score",
    "avg_peer_flag_count", "avg_peer_flag_severity_score",
    "peer_flags_per_100_words", "clean_call_rate",
    "latency_first_partial_ms", "latency_final_ms",
    "cost_per_minute", "diarization_score", "run_id", "recommendation",
  ]
  const lines = rows.map((r) =>
    [
      groupLabel, r.vertical, r.rank, r.providerId, r.providerName,
      r.score.avgFlagCount, r.score.avgFlagSeverityScore,
      r.score.avgPeerFlagCount, r.score.avgPeerFlagSeverityScore,
      r.score.peerFlagsPer100Words, r.score.cleanCallRate,
      r.score.latencyFirstPartialMs, r.score.latencyFinalMs,
      r.score.costPerMinute, r.score.diarizationScore, r.runId, r.recommendation,
    ].map(escape).join(","),
  )
  return [header.join(","), ...lines].join("\n")
}

function downloadCsv(filename: string, csv: string): void {
  // B-31: BOM so Excel reads the UTF-8 provider names instead of mojibake.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}


/**
 * 2026-08-27, per Abhishek: "redesign the whole ranking and result ... with
 * this stt its this, and its this" -- the single most useful sentence this
 * page can say is the before/after: what production actually uses today
 * for this assistant's calls, versus what this bulk's top candidate scores
 * like. Reuses the same provider-name normalization Corpus's per-call panel
 * uses, aggregated across the group instead of one call.
 */
function useProductionBaseline(assistantId: string | null) {
  const { data: calls } = useListBenchmarkCalls()
  const { data: providers } = useListBenchmarkProviders()
  return React.useMemo(() => {
    if (!calls) return null
    const groupCalls = calls.filter((c) => (c.sourceAssistantId ?? null) === assistantId)
    const counts = new Map<string, number>()
    for (const c of groupCalls) {
      if (!c.sourceTranscriberProvider) continue
      const key = `${c.sourceTranscriberProvider}::${c.sourceTranscriberModel ?? ""}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    if (!top) return null
    const [vendor, model] = top[0].split("::")
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "")
    const matchedProviderId =
      (providers ?? []).find((p) => norm(p.name) === norm(vendor) && (model ? norm(p.model) === norm(model) : false))
        ?.id ?? null
    return { vendor, model: model || null, matchedProviderId, coverage: top[1], total: groupCalls.length }
  }, [calls, providers, assistantId])
}

function ProductionBaselineNote({ assistantId, ranks, gv }: { assistantId: string | null; ranks: RankingRow[]; gv: GroupVolume }) {
  const baseline = useProductionBaseline(assistantId)
  const listPrices = useListPrices()
  // T-97: what the assistant is *configured* with, read live from Vapi --
  // the fallback and the boosted vocabulary are the two things production
  // has that the benchmark runs did not.
  const configured = useGetAssistantTranscriber(assistantId ?? "", {
    query: { queryKey: getGetAssistantTranscriberQueryKey(assistantId ?? ""), enabled: assistantId !== null, retry: false, staleTime: 10 * 60 * 1000 },
  })
  if (!baseline) return null
  const cfg = configured.data
  const specText = (x: { provider: string; model: string | null }) => `${x.provider}${x.model ? ` / ${x.model}` : ""}`

  const winner = [...ranks].sort((a, b) => a.rank - b.rank)[0]
  const baselineRow = baseline.matchedProviderId ? ranks.find((r) => r.providerId === baseline.matchedProviderId) : null

  return (
    <div className="flex flex-wrap items-start gap-2.5 border-t border-border bg-primary/5 px-4 py-3 text-sm">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <p className="text-foreground">
        <span className="font-semibold">Production today:</span>{" "}
        <span className="font-mono">{baseline.vendor}{baseline.model ? ` / ${baseline.model}` : ""}</span>
        {" "}({baseline.coverage}/{baseline.total} of this group's calls).{" "}
        {baselineRow && winner && baselineRow.providerId !== winner.providerId ? (
          <>
            <span className="font-semibold">This bulk's top candidate:</span>{" "}
            <span className="font-mono">{winner.providerName}</span>
            {baselineRow.score.avgFlagCount != null && winner.score.avgFlagCount != null && (
              <> -- {(baselineRow.score.avgFlagCount - winner.score.avgFlagCount).toFixed(2)} fewer flags/call</>
            )}
            {baselineRow.score.costPerMinute != null && winner.score.costPerMinute != null && (
              <>, {formatPerMinute(Math.abs(baselineRow.score.costPerMinute - winner.score.costPerMinute))} {winner.score.costPerMinute < baselineRow.score.costPerMinute ? "cheaper" : "more expensive"}</>
            )}
            .
            {/* T-24: the switch stated in money at this assistant's own
                volume. List prices x projected monthly minutes; absent
                (not $0) when there is no volume basis. */}
            {(() => {
              const from = monthlyCost(listPrices.get(baselineRow.providerId), gv.monthlyMinutes)
              const to = monthlyCost(listPrices.get(winner.providerId), gv.monthlyMinutes)
              if (gv.state !== "ok" || from === null || to === null) return null
              const diff = to - from
              return (
                <span className="font-semibold" data-testid="switch-money">
                  {" "}Switching {baseline.vendor} → {winner.providerName} at this assistant's volume:{" "}
                  {Math.abs(diff) < 0.005 ? "same cost" : `${fmtUsd(Math.abs(diff))}/month ${diff < 0 ? "saved" : "more"}`}{" "}
                  ({fmtUsd(from)} → {fmtUsd(to)}/month, projected from {gv.volume?.windowDays} days of Vapi calls).
                </span>
              )
            })()}
          </>
        ) : baselineRow && winner && baselineRow.providerId === winner.providerId ? (
          <>The provider in production today is already ahead.</>
        ) : (
          <>
            Not benchmarked in this bulk, so no quality comparison yet.
            {/* T-24: cost alone can still be stated -- the production
                provider's list price is in the catalog even when it was
                never a candidate (T-56). Said as cost only, not a verdict. */}
            {(() => {
              const from = monthlyCost(baseline.matchedProviderId ? listPrices.get(baseline.matchedProviderId) : undefined, gv.monthlyMinutes)
              const to = winner ? monthlyCost(listPrices.get(winner.providerId), gv.monthlyMinutes) : null
              if (gv.state !== "ok" || from === null || to === null || !winner) return null
              const diff = to - from
              return (
                <span data-testid="switch-money">
                  {" "}<span className="font-semibold">Cost alone, at this assistant's volume:</span> production ≈ {fmtUsd(from)}/month, {winner.providerName} ≈ {fmtUsd(to)}/month
                  {" "}({Math.abs(diff) < 0.005 ? "same" : `${fmtUsd(Math.abs(diff))}/month ${diff < 0 ? "less" : "more"}`}; projected from {gv.volume?.windowDays} days of Vapi calls; quality not compared).
                </span>
              )
            })()}
          </>
        )}
      </p>
      {cfg && (
        <p className="basis-full pl-6 text-xs text-muted-foreground" data-testid="configured-transcriber">
          Configured in Vapi for <span className="font-medium text-foreground">{cfg.name}</span>:{" "}
          <span className="font-mono">{cfg.primary ? specText(cfg.primary) : "no transcriber set"}</span>
          {cfg.fallback.length > 0 ? (
            <> · fallback <span className="font-mono">{cfg.fallback.map(specText).join(", ")}</span></>
          ) : (
            <> · no fallback</>
          )}
          {cfg.keytermCount > 0 && <> · {cfg.keytermCount} boosted keyterms</>}
          {cfg.numerals === true && <> · numerals on</>}
          .{" "}
          {cfg.fallback.length > 0 || cfg.keytermCount > 0
            ? "The benchmark ran without the fallback and without the boosted vocabulary -- production has an edge the candidates were not given."
            : "Nothing here that the benchmark did not also have."}
        </p>
      )}
    </div>
  )
}

// T-24: hooks can't run inside the group map, so the volume lookup lives
// in this tiny render-prop wrapper -- one Vapi-backed query per group,
// deduped by react-query since every group of a client shares the key.
/**
 * T-72 (E.4): the per-call provider comparison is reachable from a Results
 * group card. One link per call in this group -- scoped to the selected
 * bulk's calls (from its manifest) in bulk mode, every call of the
 * assistant in the all-time view. Opens Corpus with the row expanded and
 * the comparison scoped to the bulk (?call=<id>&bulk=<id>).
 */
function PerCallComparisonLinks({ assistantId, bulkId }: { assistantId: string | null; bulkId: string | null }) {
  const { data: calls } = useListBenchmarkCalls()
  const { data: manifest } = useGetBulkManifest(bulkId ?? "", {
    query: { queryKey: getGetBulkManifestQueryKey(bulkId ?? ""), enabled: !!bulkId },
  })
  // T-85: worst first. The call the providers disagreed on most opens
  // first; calls with no scored transcript sort last, never as "zero".
  const { data: disagreement } = useGetCallDisagreement(bulkId ? { bulkId } : undefined, {
    query: { queryKey: getGetCallDisagreementQueryKey(bulkId ? { bulkId } : undefined) },
  })
  const disagreementOf = React.useMemo(
    () => new Map((disagreement?.calls ?? []).map((c) => [c.callId, c.disagreements])),
    [disagreement],
  )
  const groupCalls = React.useMemo(() => {
    if (!calls) return []
    const inBulk = bulkId
      ? new Set((manifest?.runs ?? []).flatMap((r) => r.calls.map((c) => c.id)))
      : null
    const rank = (id: string) => disagreementOf.get(id) ?? -1
    return calls
      .filter((c) => (c.sourceAssistantId ?? null) === assistantId && (!inBulk || inBulk.has(c.id)))
      .sort((a, b) => rank(b.id) - rank(a.id) || a.label.localeCompare(b.label))
  }, [calls, manifest, assistantId, bulkId, disagreementOf])
  if (bulkId && !manifest) return null
  if (groupCalls.length === 0) return null
  return (
    <details className="border-t px-4 py-3 text-sm">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
        <FileText className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" />
        Compare providers per call ({groupCalls.length} call{groupCalls.length === 1 ? "" : "s"})
        <span className="ml-2 text-xs" title="Sum of disagreements across every provider's transcript of the call. Calls with no scored transcript are last.">· most disagreement first</span>
      </summary>
      <ul className="mt-2 grid max-h-56 grid-cols-1 gap-x-6 gap-y-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
        {groupCalls.map((c) => (
          <li key={c.id}>
            <Link
              href={`/corpus?call=${c.id}${bulkId ? `&bulk=${bulkId}` : ""}`}
              className="font-mono text-xs text-primary hover:underline"
              title="Open this call in Corpus: reference transcript on top, every provider's output diffed under it"
            >
              {c.label}
            </Link>
            {disagreementOf.has(c.id) && (
              <span className="ml-1.5 font-mono text-[10px] text-muted-foreground" title="Disagreements across providers on this call">
                {disagreementOf.get(c.id)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}

function WithGroupVolume({ assistantId, children }: { assistantId: string | null; children: (gv: GroupVolume) => React.ReactNode }) {
  const gv = useGroupVolume(assistantId)
  return <>{children(gv)}</>
}

/** The ranked table for one assistant. Markup unchanged from before T-88;
 *  pulled out so the page body reads as its hierarchy, not as one 400-line
 *  expression. */
function RankingTable({
  sorted, sortKey, asc, toggleSort, activeProviderId, activeRow, verdictWinnerId, viewMode, listPrices, gv,
}: {
  sorted: RankingRow[]
  sortKey: SortKey
  asc: boolean
  toggleSort: (key: SortKey) => void
  activeProviderId: string | null
  activeRow: RankingRow | undefined
  verdictWinnerId: string | null
  viewMode: "bulk" | "overall"
  listPrices: Map<string, number>
  gv: GroupVolume
}) {
  const sortAria = (key: SortKey) => (sortKey === key ? (asc ? "ascending" : "descending") : "none")
  const renderSortIcon = (key: SortKey) =>
    sortKey !== key ? (
      <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />
    ) : asc ? (
      <ArrowUp className="ml-1 inline h-3 w-3" />
    ) : (
      <ArrowDown className="ml-1 inline h-3 w-3" />
    )
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead
            aria-sort={sortAria("rank")}
            className="w-16 text-center cursor-pointer select-none hover:text-foreground"
            onClick={() => toggleSort("rank")}
            title={SORT_TITLES.rank}
          >
            Rank {DIRECTION.rank}{renderSortIcon("rank")}
          </TableHead>
          <TableHead>Provider</TableHead>
          {(Object.keys(SORT_ASC_DEFAULT) as SortKey[])
            .filter((k) => k !== "rank")
            .map((key) => (
              <TableHead
                key={key}
                aria-sort={sortAria(key)}
                className="text-right cursor-pointer select-none hover:text-foreground"
                onClick={() => toggleSort(key)}
                title={SORT_TITLES[key]}
              >
                {SORT_LABELS[key]} <span aria-label={DIRECTION[key] === "↓" ? "lower is better" : "higher is better"}>{DIRECTION[key]}</span>
                {renderSortIcon(key)}
              </TableHead>
            ))}
          <TableHead className="text-right" title="List $/min x this assistant's projected monthly minutes (Vapi, last 14 days x 30/14). Not sortable: it is price x one shared volume, so its order is the list-price order.">
            $/month ↓
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((r) => (
          <TableRow key={r.providerId} className={r.rank === 1 ? "bg-primary/5" : ""}>
            <TableCell className="text-center font-mono font-medium">
              {r.rank === 1 ? <span className="text-primary flex items-center justify-center gap-1 text-lg font-bold"><Trophy className="w-4 h-4" /> 1</span> : r.rank}
            </TableCell>
            <TableCell title={r.recommendation ?? undefined}>
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-foreground">{r.providerName}</span>
                {r.providerId === activeProviderId && (
                  <Badge variant="outline" className="gap-1 text-[10px] font-mono uppercase" title="Set on the Setup page">
                    <Star className="h-2.5 w-2.5" /> In production
                  </Badge>
                )}
              </div>
              {/* T-57: "Recommended" is the verdict's word. The badge
                  appears only on the provider the T-20 noise-floor
                  verdict named; rank 1 without a verdict win is
                  "leading", not decided. */}
              {verdictWinnerId === r.providerId ? (
                <div className="text-xs text-primary font-medium mt-1 flex items-center" title="Named by this group's verdict: the gap to the runner-up is bigger than the margin of error.">
                  <CheckCircle2 className="w-3 h-3 mr-1" /> Winner
                </div>
              ) : r.rank === 1 ? (
                <div className="text-xs text-muted-foreground font-medium mt-1" title={viewMode === "bulk" ? "Best rank, but the verdict above did not name a winner: the gap is inside the margin of error or too few calls ran on both." : "Best rank across all bulks. The all-time view has no verdict, so nothing here is decided."}>
                  Ahead, not a winner
                </div>
              ) : null}
            </TableCell>
            {/* Null "—" means "not measured in this run" (spec:
                distinct from a true zero) -- title says so instead
                of leaving the dash ambiguous (UX review). 2026-08-27:
                gold-free -- avgFlagCount replaces WER as the
                primary metric. FIX-4/UX-6: a non-active row shows
                its delta against the active provider's flag count
                right underneath -- lower is better, so a negative
                (green) delta means this candidate beats the active
                provider. */}
            <TableCell className="text-right font-mono font-medium" title={r.recommendation ?? undefined}>
              {r.score.avgFlagCount != null ? r.score.avgFlagCount.toFixed(2) : <span title="Not measured in this run">—</span>}
              {activeRow && r.providerId !== activeProviderId && r.score.avgFlagCount != null && activeRow.score.avgFlagCount != null && (() => {
                const delta = r.score.avgFlagCount! - activeRow.score.avgFlagCount!
                const better = delta < 0
                return (
                  <div className={`text-[10px] font-normal ${better ? "text-success" : delta > 0 ? "text-destructive" : "text-muted-foreground"}`}>
                    {better ? "" : "+"}{delta.toFixed(2)} vs production
                  </div>
                )
              })()}
              {/* 2026-08-27, found live ("for this call why its
                  different then?" -- Rank contradicted this
                  column with no visible reason): Rank is actually
                  sorted by THIS number, not the one above --
                  avgFlagCount includes a provider's own self-
                  reported low confidence, which only 3 of 7
                  providers report at all, so it isn't fair to
                  rank on directly. Shown small and separate so
                  the two are never confused for the same thing. */}
              {r.score.avgPeerFlagCount != null && (
                <div className="text-[10px] font-normal text-muted-foreground" title="Disagreements with other providers + wrong entities only, a provider's own low-confidence words excluded. This is the number Rank uses.">
                  peer: {r.score.avgPeerFlagCount.toFixed(2)}
                </div>
              )}
            </TableCell>
            <TableCell className="text-right font-mono" title="0 = none .. 3 = high, averaged over this provider's transcripts in this group">
              {r.score.avgFlagSeverityScore != null ? r.score.avgFlagSeverityScore.toFixed(2) : <span title="Not measured in this run">—</span>}
              {r.score.avgPeerFlagSeverityScore != null && (
                <div className="text-[10px] font-normal text-muted-foreground" title="How serious the disagreements were (own low-confidence words excluded). This is what Rank uses.">
                  peer: {r.score.avgPeerFlagSeverityScore.toFixed(2)}
                </div>
              )}
            </TableCell>
            {/* T-19: rates computed by the API when the snapshot was
                written. Peer-only basis, same as Rank. A snapshot
                from before T-19 shows "—" until recomputed. */}
            <TableCell className="text-right font-mono" title="Disagreements per 100 words this provider transcribed in this group. Comparable across call lengths.">
              {r.score.peerFlagsPer100Words != null ? r.score.peerFlagsPer100Words.toFixed(2) : <span title="Not in this snapshot">—</span>}
            </TableCell>
            <TableCell className="text-right font-mono" title="Share of this provider's scored calls with zero disagreements">
              {r.score.cleanCallRate != null ? `${(r.score.cleanCallRate * 100).toFixed(0)}%` : <span title="Not in this snapshot">—</span>}
            </TableCell>
            <TableCell className="text-right font-mono text-muted-foreground">
              {r.score.latencyFinalMs != null ? `${Math.round(r.score.latencyFinalMs)}ms` : <span title="Not measured in this run">—</span>}
            </TableCell>
            <TableCell className="text-right font-mono text-muted-foreground">
              {r.score.costPerMinute != null ? formatPerMinute(r.score.costPerMinute).replace("/min", "") : <span title="Not measured in this run">—</span>}
              <PaidVsListNote paid={r.score.costPerMinute} list={listPrices.get(r.providerId)} />
            </TableCell>
            <TableCell className="text-right font-mono" title="Share of calls where more than one speaker was detected">
              {r.score.diarizationScore != null ? `${(r.score.diarizationScore * 100).toFixed(1)}%` : <span title="Not measured in this run">—</span>}
            </TableCell>
            <TableCell className="text-right font-mono" data-testid="monthly-cost">
              <MonthlyCostCell listPrice={listPrices.get(r.providerId)} gv={gv} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** T-88: one org (a Vapi account -- "Land And Apartment", "Default"), the
 *  assistants under it, and the org-level verdict those assistants share
 *  (T-55: verdicts are computed per org because one assistant alone has
 *  too few calls). */
type OrgGroup = {
  key: string
  label: string | null
  assistantKeys: string[]
  calls: number
  verdict: BulkVerdicts["groups"][number] | undefined
}

export default function Rankings() {
  const listPrices = useListPrices()
  const { data: bulks } = useListBulks()
  const [viewMode, setViewMode] = React.useState<"bulk" | "overall">("bulk")
  const [evidenceOpen, setEvidenceOpen] = React.useState(false)
  const [selectedBulkId, setSelectedBulkId] = React.useState<string | null>(null)

  // useListBulks returns newest-first -- default to the most recent one the
  // first time bulks load, so there's never an empty "pick a bulk" state.
  React.useEffect(() => {
    if (!selectedBulkId && bulks && bulks.length > 0) setSelectedBulkId(bulks[0].id)
  }, [bulks, selectedBulkId])

  const activeBulkId = viewMode === "bulk" ? selectedBulkId : undefined
  const { data: rankings, isLoading, isError, error, refetch } = useListBenchmarkRankings(
    activeBulkId ? { bulkId: activeBulkId } : undefined,
  )
  const { data: bulkDetail } = useGetBulk(selectedBulkId ?? "", {
    query: {
      queryKey: getGetBulkQueryKey(selectedBulkId ?? ""),
      enabled: viewMode === "bulk" && !!selectedBulkId,
    },
  })
  const { data: settings } = useGetAppSettings()
  const activeProviderId = settings?.activeProviderId ?? null
  const { data: providerList } = useListBenchmarkProviders()
  const providerNames = React.useMemo(
    () => Object.fromEntries((providerList ?? []).map((p) => [p.id, p.name])),
    [providerList],
  )
  // T-21: one verdict fetch per bulk, shared by the banner and every org
  // section. Only meaningful for a single bulk -- the all-time view has no
  // noise floor of its own and shows no verdict rather than a wrong one.
  const { data: verdicts } = useBulkVerdicts(viewMode === "bulk" ? selectedBulkId : null)
  const [sortKey, setSortKey] = React.useState<SortKey>("rank")
  const [asc, setAsc] = React.useState<boolean>(SORT_ASC_DEFAULT.rank)

  // Grouped by real assistant (2026-08-27, per Abhishek), keyed by
  // assistantId; null bucketed under "Unassigned" rather than dropped.
  const groupedRankings = React.useMemo(() => {
    if (!rankings) return {}
    return rankings.reduce((acc, curr) => {
      const key = curr.assistantId ?? "__other__"
      if (!acc[key]) acc[key] = []
      acc[key].push(curr)
      return acc
    }, {} as Record<string, typeof rankings>)
  }, [rankings])

  // T-88: assistant -> org. The verdict group is authoritative in bulk mode
  // (it lists the assistant ids it pooled); otherwise the org is the account
  // label most of the assistant's calls carry.
  const { data: calls } = useListBenchmarkCalls()
  const assistantOrg = React.useMemo(() => {
    const tally = new Map<string, Map<string | null, number>>()
    for (const c of calls ?? []) {
      const aKey = c.sourceAssistantId ?? "__other__"
      const per = tally.get(aKey) ?? new Map<string | null, number>()
      per.set(c.sourceAccountLabel ?? null, (per.get(c.sourceAccountLabel ?? null) ?? 0) + 1)
      tally.set(aKey, per)
    }
    const out = new Map<string, string | null>()
    for (const [aKey, per] of tally) out.set(aKey, [...per.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null)
    return out
  }, [calls])
  const callLabels = React.useMemo(() => Object.fromEntries((calls ?? []).map((c) => [c.id, c.label])), [calls])

  const orgs = React.useMemo<OrgGroup[]>(() => {
    const byKey = new Map<string, OrgGroup>()
    for (const aKey of Object.keys(groupedRankings)) {
      const aId = aKey === "__other__" ? null : aKey
      const vg = viewMode === "bulk" ? findGroupVerdict(verdicts, aId) : undefined
      const label = vg ? vg.clientLabel : (assistantOrg.get(aKey) ?? null)
      const key = label ?? "__no_org__"
      const org = byKey.get(key) ?? { key, label, assistantKeys: [], calls: 0, verdict: vg ?? verdicts?.groups.find((g) => g.clientLabel === label) }
      org.assistantKeys.push(aKey)
      byKey.set(key, org)
    }
    for (const org of byKey.values()) {
      org.calls = org.verdict?.callCount ?? (calls ?? []).filter((c) => (c.sourceAccountLabel ?? null) === org.label && org.assistantKeys.includes(c.sourceAssistantId ?? "__other__")).length
      // Biggest assistant first inside the org.
      org.assistantKeys.sort((a, b) => (calls ?? []).filter((c) => (c.sourceAssistantId ?? "__other__") === b).length - (calls ?? []).filter((c) => (c.sourceAssistantId ?? "__other__") === a).length)
    }
    return [...byKey.values()].sort((a, b) => b.calls - a.calls || (a.label ?? "~").localeCompare(b.label ?? "~"))
  }, [groupedRankings, verdicts, assistantOrg, calls, viewMode])

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setAsc((v) => !v)
    else {
      setSortKey(key)
      setAsc(SORT_ASC_DEFAULT[key])
    }
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-bold tracking-tight">Results</h1>
        <div className="text-center py-24 border rounded-md border-destructive/40 text-destructive">
          Failed to load rankings: {error instanceof Error ? error.message : String(error)}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => void refetch()}>Retry</Button>
          </div>
        </div>
      </div>
    )
  }

  const tile = (label: string, value: React.ReactNode, sub?: React.ReactNode, tone: "normal" | "destructive" = "normal") => (
    <div className={`rounded-lg border px-4 py-3 ${tone === "destructive" ? "border-destructive/40 bg-destructive/5" : "border-border bg-card"}`}>
      <div className={`text-[10px] font-mono uppercase tracking-wide ${tone === "destructive" ? "text-destructive" : "text-muted-foreground"}`}>{label}</div>
      <div className={`mt-1 font-mono text-lg font-semibold tabular-nums ${tone === "destructive" ? "text-destructive" : ""}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  )

  return (
    <div className="space-y-8">
      {/* T-88 (PRD-v4 Part G) page order, top to bottom: which bulk? -> the
          answer (verdict) -> what it cost -> per org: the org's verdict, its
          monthly cost, then each assistant's ranked table and the words
          that split the providers -> "more evidence" folded at the end
          (correlation, the one trend graph). Evidence: Peec AI overview,
          Maze results (Mobbin) -- headline, a strip of tiles, ranked list;
          charts secondary. */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Results</h1>
        <p className="text-muted-foreground mt-1">
          Which provider should each org's assistants run on. One bulk at a time, or every bulk combined.
        </p>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="results-legend">
          <span className="font-medium text-foreground">Lower is better</span> for disagreements, flags, speed and price
          (↓). Higher is better for clean calls and speakers told apart (↑). Hover a column for exactly what it measures.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-border p-0.5">
          <button
            onClick={() => setViewMode("bulk")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${viewMode === "bulk" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            One bulk
          </button>
          <button
            onClick={() => setViewMode("overall")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${viewMode === "overall" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            All-time combined
          </button>
        </div>
        {viewMode === "bulk" && (
          <Select value={selectedBulkId ?? undefined} onValueChange={setSelectedBulkId}>
            <SelectTrigger className="h-9 w-[360px]"><SelectValue placeholder="Pick a bulk..." /></SelectTrigger>
            <SelectContent>
              {(bulks ?? []).map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name} · {b.status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {viewMode === "bulk" && selectedBulkId && (
          <a
            href={`${apiBase()}/api/benchmark/bulks/${selectedBulkId}/verdict.html`}
            target="_blank"
            rel="noopener"
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted"
            data-testid="share-verdict-link"
            title="Read-only dated verdict page for this bulk. Save or print it to share."
          >
            <FileText className="h-4 w-4" /> Share verdict
          </a>
        )}
      </div>

      {/* T-21: the answer first. */}
      {viewMode === "bulk" && selectedBulkId && <BulkVerdictBanner bulkId={selectedBulkId} groupLabels={{}} />}

      {/* Cost + coverage as tiles. STT and agent spend are different
          budgets, never combined into one figure. */}
      {viewMode === "bulk" && bulkDetail && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="cost-tiles">
          {tile("STT cost", formatMicrocents(bulkDetail.actualCost.sttCostMicrocents), bulkDetail.estimatedSttCostCents != null ? <>est. {formatCents(bulkDetail.estimatedSttCostCents)}</> : undefined)}
          {tile("AI check cost", formatMicrocents(bulkDetail.actualCost.agentCostMicrocents), bulkDetail.estimatedAgentCostCents != null ? <>est. {formatCents(bulkDetail.estimatedAgentCostCents)}</> : undefined)}
          {tile("Checked by AI", `${bulkDetail.actualCost.agentCallsChecked} calls`, <>{bulkDetail.actualCost.agentCallsFlagged} flagged, {bulkDetail.actualCost.agentCallsJudged} judged{bulkDetail.actualCost.agentCallsResolved > 0 && <>, {bulkDetail.actualCost.agentCallsResolved} resolved by a person</>}</>)}
          {bulkDetail.actualCost.agentCallsErrored > 0
            ? tile("Agent errors", `${bulkDetail.actualCost.agentCallsErrored} errored`, "unchecked, not clean", "destructive")
            : tile("Orgs", orgs.length, <>{Object.keys(groupedRankings).length} assistant{Object.keys(groupedRankings).length === 1 ? "" : "s"}</>)}
        </div>
      )}

      {viewMode === "bulk" && bulkDetail && bulkDetail.actualCost.agentCallsErrored > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Agent verification failed on {bulkDetail.actualCost.agentCallsErrored} of{" "}
            {bulkDetail.actualCost.agentCallsChecked} call(s) in this bulk. Those calls were never checked
            &mdash; treat them as unknown, not clean. The rankings below are unchanged by this: they are
            scored from the transcripts themselves.
          </span>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-6">
          {[1, 2].map((i) => <Card key={i} className="h-64 animate-pulse bg-muted/20" />)}
        </div>
      ) : orgs.length === 0 ? (
        <div className="text-center py-24 border rounded-md border-dashed border-muted-foreground/30">
          <Trophy className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
          <h3 className="text-lg font-semibold">No rankings available</h3>
          <p className="text-muted-foreground">
            {viewMode === "bulk" ? "This bulk hasn't scored any calls yet." : "Complete a benchmark run to see results."}
          </p>
        </div>
      ) : (
        orgs.map((org) => (
          <section key={org.key} className="space-y-4" data-testid="org-section">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border pb-2">
              <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
                <Building2 className="h-5 w-5 text-muted-foreground" />
                {org.label ?? "No org label on file"}
              </h2>
              <span className="text-xs text-muted-foreground">
                {org.assistantKeys.length} assistant{org.assistantKeys.length === 1 ? "" : "s"}
                {org.calls > 0 && <> · {org.calls} call{org.calls === 1 ? "" : "s"}{viewMode === "bulk" ? " in this bulk" : ""}</>}
              </span>
            </div>
            {/* T-55/T-88: the verdict is the org's, computed over all its
                assistants together, so it sits at org level once -- not
                repeated under every assistant. */}
            {viewMode === "bulk" && (
              <div className="overflow-hidden rounded-lg border border-border">
                <GroupVerdictHeadline
                  verdict={org.verdict?.verdict}
                  scope={org.verdict ? { clientLabel: org.verdict.clientLabel, assistantCount: org.verdict.assistantIds.length, callCount: org.verdict.callCount } : undefined}
                />
              </div>
            )}
            {/* T-24: the org as a whole -- every candidate's list price at
                the account's full projected monthly volume. */}
            <ClientMonthlyCostLine
              accountLabel={org.label}
              providerIds={[...new Set(org.assistantKeys.flatMap((k) => (groupedRankings[k] ?? []).map((r) => r.providerId)))]}
            />

            {org.assistantKeys.map((aKey) => {
              const ranks = groupedRankings[aKey] ?? []
              return (
                <WithGroupVolume key={aKey} assistantId={ranks[0]?.assistantId ?? null}>
                  {(gv) => {
                    const sorted = [...ranks].sort((a, b) => compareRows(a, b, sortKey, asc))
                    const winner = [...ranks].sort((a, b) => a.rank - b.rank)[0]
                    const groupLabel = ranks[0]?.assistantLabel ?? "Unassigned (no assistant ID captured at import)"
                    const activeRow = activeProviderId ? ranks.find((r) => r.providerId === activeProviderId) : undefined
                    // T-57: the verdict owns the word "Winner" -- the composite rank only ever says "ahead".
                    const verdictWinnerId = viewMode === "bulk" && org.verdict?.verdict.decision === "winner" ? org.verdict.verdict.winnerProviderId : null
                    return (
                      <Card className="overflow-hidden shadow-sm">
                        <CardHeader className="bg-muted/10 pb-3 border-b">
                          <div className="flex flex-wrap justify-between items-center gap-3">
                            <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                              {groupLabel}
                              <Badge variant="outline" className="font-mono font-normal">{ranks.length} providers</Badge>
                            </CardTitle>
                            <div className="flex items-center gap-4">
                              <span className="text-xs font-mono text-muted-foreground" title="Rank = disagreements, then price and speed. Sorting a column changes the view, not the rank.">
                                Ranked by <span className="text-foreground font-semibold">disagreements, price, speed</span>
                              </span>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => downloadCsv(`rankings-${groupLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${winner?.runId?.slice(0, 8) ?? "unknown"}.csv`, buildCsv(groupLabel, sorted))}
                              >
                                <Download className="mr-2 h-4 w-4" /> Export CSV
                              </Button>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="p-0">
                          <GroupVolumeLine gv={gv} />
                          <RankingTable
                            sorted={sorted}
                            sortKey={sortKey}
                            asc={asc}
                            toggleSort={toggleSort}
                            activeProviderId={activeProviderId}
                            activeRow={activeRow}
                            verdictWinnerId={verdictWinnerId}
                            viewMode={viewMode}
                            listPrices={listPrices}
                            gv={gv}
                          />
                          {winner?.recommendation && (
                            <div className="p-4 bg-muted/30 border-t flex gap-3 text-sm">
                              <ArrowUpRight className="w-5 h-5 text-primary shrink-0" />
                              <p className="text-foreground">
                                <span className="font-semibold mr-1">Why this order:</span>
                                {winner.recommendation}
                              </p>
                            </div>
                          )}
                          <ProductionBaselineNote assistantId={ranks[0]?.assistantId ?? null} ranks={ranks} gv={gv} />
                          {/* T-112 / T-113: how sure the AI judge was, and what a
                              person flagged as hard -- machine and human signal
                              side by side, counts only. */}
                          <AssistantSignals bulkId={viewMode === "bulk" ? selectedBulkId : null} assistantId={ranks[0]?.assistantId ?? null} />
                          {/* T-87 / T-92: the words that split the providers for
                              this assistant -- this bulk, or all-time (every
                              finished bulk, latest run per call). */}
                          <WordsToWatch
                            bulkId={viewMode === "bulk" ? selectedBulkId : null}
                            assistantId={ranks[0]?.assistantId ?? null}
                            providerNames={providerNames}
                            callLabels={callLabels}
                            compact
                          />
                          <PerCallComparisonLinks assistantId={ranks[0]?.assistantId ?? null} bulkId={viewMode === "bulk" ? selectedBulkId : null} />
                        </CardContent>
                      </Card>
                    )
                  }}
                </WithGroupVolume>
              )
            })}
          </section>
        ))
      )}

      {/* T-88: the supporting evidence, folded. T-18 correlation qualifies
          the votes above; T-23 trend is the one chart on the page -- kept,
          once, here (the per-assistant copies inside every card were
          noise at three bulks per line). */}
      {(orgs.length > 0 || viewMode === "overall") && (
        <details
          className="rounded-lg border border-border"
          data-testid="more-evidence"
          onToggle={(e) => setEvidenceOpen(e.currentTarget.open)}
        >
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-foreground hover:bg-muted/40">
            More evidence
            <span className="ml-2 text-xs font-normal text-muted-foreground">how independent the providers' votes are · the trend, bulk over bulk</span>
          </summary>
          {evidenceOpen && (
            <div className="space-y-4 border-t border-border p-4">
              {viewMode === "bulk" && selectedBulkId && <ProviderCorrelationCard bulkId={selectedBulkId} />}
              <React.Suspense fallback={<div className="text-sm text-muted-foreground">Loading the trend chart...</div>}>
                <ClientTrendSection highlightBulkId={viewMode === "bulk" ? selectedBulkId : null} />
              </React.Suspense>
            </div>
          )}
        </details>
      )}
    </div>
  )
}
