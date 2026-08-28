import * as React from "react"
import {
  useListBenchmarkRankings,
  useGetAppSettings,
  useListBulks,
  useGetBulk,
  getGetBulkQueryKey,
  useListBenchmarkCalls,
  useListBenchmarkProviders,
  type VerticalRanking,
} from "@workspace/api-client-react"
import { Trophy, ArrowUpRight, ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, Download, Star, ShieldCheck, AlertTriangle } from "lucide-react"
import { formatMicrocents } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { JudgeAccuracyCard } from "@/components/judge-accuracy-card"
import { ProviderCorrelationCard } from "@/components/provider-correlation-card"
import { BulkVerdictBanner, GroupVerdictHeadline, findGroupVerdict, useBulkVerdicts } from "@/components/verdict-headline"
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

const SORT_LABELS: Record<SortKey, string> = {
  rank: "Composite",
  avgFlagCount: "Avg Flags",
  avgFlagSeverityScore: "Flag Severity",
  peerFlagsPer100Words: "Flags / 100 words",
  cleanCallRate: "Clean calls",
  latencyFinalMs: "Latency (Final)",
  costPerMinute: "Cost/Min",
  diarizationScore: "Diarization",
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

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return "—"
  return `$${(cents / 100).toFixed(2)}`
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

function ProductionBaselineNote({ assistantId, ranks }: { assistantId: string | null; ranks: RankingRow[] }) {
  const baseline = useProductionBaseline(assistantId)
  if (!baseline) return null

  const winner = [...ranks].sort((a, b) => a.rank - b.rank)[0]
  const baselineRow = baseline.matchedProviderId ? ranks.find((r) => r.providerId === baseline.matchedProviderId) : null

  return (
    <div className="flex items-start gap-2.5 border-t border-border bg-primary/5 px-4 py-3 text-sm">
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
              <>, ${Math.abs(baselineRow.score.costPerMinute - winner.score.costPerMinute).toFixed(4)}/min {winner.score.costPerMinute < baselineRow.score.costPerMinute ? "cheaper" : "more expensive"}</>
            )}
            .
          </>
        ) : baselineRow && winner && baselineRow.providerId === winner.providerId ? (
          <>Production's own provider is already this group's top candidate.</>
        ) : (
          <>Not benchmarked in this bulk, so no direct comparison yet.</>
        )}
      </p>
    </div>
  )
}

export default function Rankings() {
  const { data: bulks } = useListBulks()
  const [viewMode, setViewMode] = React.useState<"bulk" | "overall">("bulk")
  const [selectedBulkId, setSelectedBulkId] = React.useState<string | null>(null)

  // useListBulks returns newest-first -- default to the most recent one the
  // first time bulks load, so there's never an empty "pick a bulk" state
  // for the common case of "what did the run I just launched find."
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

  // technical-fixes FIX-4 / ux-fixes UX-6: "active provider" (Providers ->
  // System settings) previously fed nothing downstream -- an operator could
  // set it and never see it do anything. This is the decision-support use:
  // highlight that provider's row and show every other row's delta against
  // it, so setting it actually changes what the page tells you.
  const { data: settings } = useGetAppSettings()
  const activeProviderId = settings?.activeProviderId ?? null
  // T-09: provider display names for the judge-vs-human card.
  const { data: providerList } = useListBenchmarkProviders()
  const providerNames = React.useMemo(
    () => Object.fromEntries((providerList ?? []).map((p) => [p.id, p.name])),
    [providerList],
  )
  // T-21: one verdict fetch per bulk, shared by the banner and every group
  // card. Only meaningful for a single bulk -- the all-time view has no
  // noise floor of its own and shows no verdict rather than a wrong one.
  const { data: verdicts } = useBulkVerdicts(viewMode === "bulk" ? selectedBulkId : null)
  const [sortKey, setSortKey] = React.useState<SortKey>("rank")
  // Direction starts at each metric's sensible default (lower-is-better for
  // WER/cost/latency, higher for accuracy) and clicking the active column
  // flips it -- UX review 2026-08-25: direction was locked before, so
  // "most expensive provider" was unreachable.
  const [asc, setAsc] = React.useState<boolean>(SORT_ASC_DEFAULT.rank)

  // 2026-08-27, per Abhishek: grouped by real assistant instead of vertical
  // (same reasoning as the Bulks picker) -- keyed by assistantId, null
  // bucketed under "Unassigned" rather than dropped. assistantLabel is
  // resolved server-side from a live Vapi lookup, so it's already a real
  // name here.
  const groupedRankings = React.useMemo(() => {
    if (!rankings) return {}
    return rankings.reduce((acc, curr) => {
      const key = curr.assistantId ?? "__other__"
      if (!acc[key]) acc[key] = []
      acc[key].push(curr)
      return acc
    }, {} as Record<string, typeof rankings>)
  }, [rankings])

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setAsc((v) => !v)
    } else {
      setSortKey(key)
      setAsc(SORT_ASC_DEFAULT[key])
    }
  }

  const renderSortIcon = (key: SortKey) =>
    sortKey !== key ? (
      <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />
    ) : asc ? (
      <ArrowUp className="ml-1 inline h-3 w-3" />
    ) : (
      <ArrowDown className="ml-1 inline h-3 w-3" />
    )

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Results</h1>
        <p className="text-muted-foreground mt-1">
          Provider scores and recommendations, grouped by assistant. Pick one bulk to see just that
          run's evidence with full detail, or switch to the all-time view to see every bulk combined.
        </p>
      </div>

      {/* T-09: the one number that says whether the judge can be trusted
          to stand in for a listening human -- and its sample size. Sits
          above the rankings because every "agent pick" below it is only as
          good as this. */}
      <JudgeAccuracyCard providerNames={providerNames} />

      {/* view switcher + bulk picker -- 2026-08-27, per Abhishek: "for each
          run then it should show the ranking for each, and for bulk overall
          ranking for all the call" -- "run" here means one launched Bulk,
          not the internal shard-run concept; "overall" is every bulk ever,
          combined, same as this page's old (only) behavior. */}
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
      </div>

      {/* T-21: the answer first. One sentence for the whole bulk, above
          cost, correlation and every table -- a non-technical reader is
          done here. Per-group sentences repeat inside each card. */}
      {viewMode === "bulk" && selectedBulkId && (
        <BulkVerdictBanner
          bulkId={selectedBulkId}
          groupLabels={Object.fromEntries(
            Object.values(groupedRankings).map((rows) => [rows[0]?.assistantId ?? "__none__", rows[0]?.assistantLabel ?? "Unassigned (no assistant ID captured at import)"]),
          )}
        />
      )}

      {/* cost + coverage summary -- 2026-08-27, per Abhishek: "does the
          estimation show cost of each run and the openai agent cost and stt
          cost separately." Real (post-run) numbers when available, split
          the same way estimates are: STT and agent spend are different
          budgets, never combined into one figure. */}
      {viewMode === "bulk" && bulkDetail && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-3 p-4 text-sm">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground">STT cost</div>
              <div className="font-mono text-base font-semibold">
                {formatMicrocents(bulkDetail.actualCost.sttCostMicrocents)}
                {bulkDetail.estimatedSttCostCents != null && (
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    est. {formatCents(bulkDetail.estimatedSttCostCents)}
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground">Agent verification cost</div>
              <div className="font-mono text-base font-semibold">
                {formatMicrocents(bulkDetail.actualCost.agentCostMicrocents)}
                {bulkDetail.estimatedAgentCostCents != null && (
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    est. {formatCents(bulkDetail.estimatedAgentCostCents)}
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground">Agent coverage</div>
              <div className="font-mono text-base font-semibold">
                {bulkDetail.actualCost.agentCallsChecked} checked
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  {bulkDetail.actualCost.agentCallsFlagged} flagged, {bulkDetail.actualCost.agentCallsJudged} judged by OpenAI
                </span>
              </div>
            </div>
            {/* T-03 (2026-08-28): errored scans get their own cell, in
                destructive colour, never folded into the flagged count.
                A crash is a hole in the coverage, not a finding. */}
            {bulkDetail.actualCost.agentCallsErrored > 0 && (
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wide text-destructive">Agent errors</div>
                <div className="font-mono text-base font-semibold text-destructive">
                  {bulkDetail.actualCost.agentCallsErrored} errored
                  <span className="ml-1.5 text-xs font-normal">unchecked, not clean</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* T-18: how independent the providers' votes are. Sits right under
          the cost line so it is read before the table it qualifies. */}
      {viewMode === "bulk" && selectedBulkId && <ProviderCorrelationCard bulkId={selectedBulkId} />}

      {/* The ranking cards below are scored from transcripts, not from the
          agent, so an agent failure cannot move them. Say that explicitly
          rather than leaving a red number next to a table and letting the
          reader guess whether the table is compromised. */}
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
          {[1,2].map(i => <Card key={i} className="h-64 animate-pulse bg-muted/20" />)}
        </div>
      ) : Object.keys(groupedRankings).length === 0 ? (
        <div className="text-center py-24 border rounded-md border-dashed border-muted-foreground/30">
          <Trophy className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
          <h3 className="text-lg font-semibold">No rankings available</h3>
          <p className="text-muted-foreground">
            {viewMode === "bulk" ? "This bulk hasn't scored any calls yet." : "Complete a benchmark run to see results."}
          </p>
        </div>
      ) : (
        Object.entries(groupedRankings).map(([groupKey, ranks]) => {
          const sorted = [...ranks].sort((a, b) => compareRows(a, b, sortKey, asc))
          const winner = [...ranks].sort((a, b) => a.rank - b.rank)[0]
          const sortAria = (key: SortKey) => (sortKey === key ? (asc ? "ascending" : "descending") : "none")
          const groupLabel = ranks[0]?.assistantLabel ?? "Unassigned (no assistant ID captured at import)"
          // FIX-4/UX-6: the active provider might not have been benchmarked
          // in this particular group (e.g. it errored out entirely) -- undefined
          // is handled the same as "no active provider set" below.
          const activeRow = activeProviderId ? ranks.find((r) => r.providerId === activeProviderId) : undefined
          return (
          <Card key={groupKey} className="overflow-hidden border-t-4 border-t-primary shadow-sm">
            <CardHeader className="bg-muted/10 pb-4 border-b">
              <div className="flex flex-wrap justify-between items-center gap-3">
                <CardTitle className="text-xl flex items-center gap-2 flex-wrap">
                  {groupLabel}
                  <Badge variant="outline" className="ml-2 font-mono">{ranks.length} Providers</Badge>
                </CardTitle>
                <div className="flex items-center gap-4">
                  <div className="flex gap-4 text-sm font-mono text-muted-foreground">
                    <span>Official order: <span className="text-foreground font-semibold">composite</span></span>
                  </div>
                  {/* FR-R3 decision export; run id in the filename so
                      spreadsheets from different runs can't be confused
                      (UX review 2026-08-25). */}
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
              {/* T-21: this group's verdict sentence sits above its table so
                  the decision is read before the numbers that back it. */}
              {viewMode === "bulk" && (
                <GroupVerdictHeadline verdict={findGroupVerdict(verdicts, ranks[0]?.assistantId ?? null)?.verdict} />
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead
                      aria-sort={sortAria("rank")}
                      className="w-16 text-center cursor-pointer select-none hover:text-foreground"
                      onClick={() => toggleSort("rank")}
                      title="Computed from peer flags (cross-provider disagreement + wrong entities only) plus cost and latency -- NOT the Avg Flags column, which includes a provider's own self-reported low confidence and is only fairly comparable among providers that report it at all. See the small 'peer' number under Avg Flags for the figure Rank actually uses."
                    >
                      Rank{renderSortIcon("rank")}
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
                        >
                          {SORT_LABELS[key]}
                          {renderSortIcon(key)}
                        </TableHead>
                      ))}
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
                            <Badge variant="outline" className="gap-1 text-[10px] font-mono uppercase" title="Set as the active production provider in Providers -> System settings">
                              <Star className="h-2.5 w-2.5" /> Active
                            </Badge>
                          )}
                        </div>
                        {r.rank === 1 && (
                          <div className="text-xs text-primary font-medium mt-1 flex items-center">
                            <CheckCircle2 className="w-3 h-3 mr-1" /> Recommended
                          </div>
                        )}
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
                              {better ? "" : "+"}{delta.toFixed(2)} vs active
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
                          <div className="text-[10px] font-normal text-muted-foreground" title="Cross-provider disagreement + wrong entities only, excluding self-reported confidence -- this is the number Rank is actually computed from.">
                            peer: {r.score.avgPeerFlagCount.toFixed(2)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono" title="0=none .. 3=high, averaged across this provider's cells in this group">
                        {r.score.avgFlagSeverityScore != null ? r.score.avgFlagSeverityScore.toFixed(2) : <span title="Not measured in this run">—</span>}
                        {r.score.avgPeerFlagSeverityScore != null && (
                          <div className="text-[10px] font-normal text-muted-foreground" title="Severity of peer-only flags -- what Rank actually uses.">
                            peer: {r.score.avgPeerFlagSeverityScore.toFixed(2)}
                          </div>
                        )}
                      </TableCell>
                      {/* T-19: rates computed by the API when the snapshot was
                          written. Peer-only basis, same as Rank. A snapshot
                          from before T-19 shows "—" until recomputed. */}
                      <TableCell className="text-right font-mono" title="Peer-only flags per 100 words this provider transcribed in this group -- comparable across call lengths">
                        {r.score.peerFlagsPer100Words != null ? r.score.peerFlagsPer100Words.toFixed(2) : <span title="Not in this snapshot">—</span>}
                      </TableCell>
                      <TableCell className="text-right font-mono" title="Share of this provider's scored calls with zero peer flags">
                        {r.score.cleanCallRate != null ? `${(r.score.cleanCallRate * 100).toFixed(0)}%` : <span title="Not in this snapshot">—</span>}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {r.score.latencyFinalMs != null ? `${r.score.latencyFinalMs}ms` : <span title="Not measured in this run">—</span>}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {r.score.costPerMinute != null ? `$${r.score.costPerMinute.toFixed(4)}` : <span title="Not measured in this run">—</span>}
                      </TableCell>
                      <TableCell className="text-right font-mono" title="Share of calls where more than one speaker was detected">
                        {r.score.diarizationScore != null ? `${(r.score.diarizationScore * 100).toFixed(1)}%` : <span title="Not measured in this run">—</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Context / Recommendation note */}
              {winner?.recommendation && (
                <div className="p-4 bg-muted/30 border-t flex gap-3 text-sm">
                  <ArrowUpRight className="w-5 h-5 text-primary shrink-0" />
                  <p className="text-foreground"><span className="font-semibold mr-1">Decision Logic:</span>{winner.recommendation}</p>
                </div>
              )}
              <ProductionBaselineNote assistantId={ranks[0]?.assistantId ?? null} ranks={ranks} />
            </CardContent>
          </Card>
          )
        })
      )}
    </div>
  )
}
