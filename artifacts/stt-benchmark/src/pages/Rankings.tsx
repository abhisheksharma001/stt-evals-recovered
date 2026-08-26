import * as React from "react"
import { useListBenchmarkRankings, type VerticalRanking } from "@workspace/api-client-react"
import { Trophy, ArrowUpRight, ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, Download } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

// Sortable metric keys -- "rank" keeps the composite-score ordering the run
// computed server-side (FR-R1 adds per-metric resorting on top of it).
type SortKey = "rank" | "wer" | "entityAccuracy" | "latencyFinalMs" | "costPerMinute" | "diarizationScore"

// Lower-is-better metrics sort ascending by default; accuracy metrics
// descending. Nulls always sink to the bottom regardless of direction --
// "not measured" must never masquerade as a great or terrible score.
const SORT_ASC_DEFAULT: Record<SortKey, boolean> = {
  rank: true,
  wer: true,
  entityAccuracy: false,
  latencyFinalMs: true,
  costPerMinute: true,
  diarizationScore: false,
}

const SORT_LABELS: Record<SortKey, string> = {
  rank: "Composite",
  wer: "WER",
  entityAccuracy: "Entity Acc.",
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
    "wer", "entity_accuracy", "alphanumeric_accuracy",
    "latency_first_partial_ms", "latency_final_ms",
    "cost_per_minute", "diarization_score", "run_id", "recommendation",
  ]
  const lines = rows.map((r) =>
    [
      groupLabel, r.vertical, r.rank, r.providerId, r.providerName,
      r.score.wer, r.score.entityAccuracy, r.score.alphanumericAccuracy,
      r.score.latencyFirstPartialMs, r.score.latencyFinalMs,
      r.score.costPerMinute, r.score.diarizationScore, r.runId, r.recommendation,
    ].map(escape).join(","),
  )
  return [header.join(","), ...lines].join("\n")
}

function downloadCsv(filename: string, csv: string): void {
  // B-31: BOM so Excel reads the UTF-8 provider names instead of mojibake.
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function Rankings() {
  const { data: rankings, isLoading, isError, error, refetch } = useListBenchmarkRankings()
  const [sortKey, setSortKey] = React.useState<SortKey>("rank")
  // Direction starts at each metric's sensible default (lower-is-better for
  // WER/cost/latency, higher for accuracy) and clicking the active column
  // flips it -- UX review 2026-08-25: direction was locked before, so
  // "most expensive provider" was unreachable.
  const [asc, setAsc] = React.useState<boolean>(SORT_ASC_DEFAULT.rank)

  // 2026-08-27, per Abhishek: grouped by real assistant instead of vertical
  // (same reasoning as the Bulks picker) -- keyed by assistantId, null
  // bucketed under "Other" rather than dropped. assistantLabel is resolved
  // server-side from a live Vapi lookup, so it's already a real name here.
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
        <h1 className="text-3xl font-bold tracking-tight">Rankings & Results</h1>
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
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Rankings & Results</h1>
        <p className="text-muted-foreground mt-1">
          Provider scores and recommendations by assistant (2026-08-27 -- was by vertical; vertical
          still shows as a tag per card). Click a column to sort by that metric; rank badges always
          show the official composite order.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-6">
          {[1,2].map(i => <Card key={i} className="h-64 animate-pulse bg-muted/20" />)}
        </div>
      ) : Object.keys(groupedRankings).length === 0 ? (
        <div className="text-center py-24 border rounded-md border-dashed border-muted-foreground/30">
          <Trophy className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
          <h3 className="text-lg font-semibold">No rankings available</h3>
          <p className="text-muted-foreground">Complete a benchmark run to see results.</p>
        </div>
      ) : (
        Object.entries(groupedRankings).map(([groupKey, ranks]) => {
          const sorted = [...ranks].sort((a, b) => compareRows(a, b, sortKey, asc))
          const winner = [...ranks].sort((a, b) => a.rank - b.rank)[0]
          const sortAria = (key: SortKey) => (sortKey === key ? (asc ? "ascending" : "descending") : "none")
          const groupLabel = ranks[0]?.assistantLabel ?? "Other (no assistant on file)"
          // An assistant's calls are expected to share one vertical, but
          // this is defensive (2026-08-27) -- shows every distinct vertical
          // actually present in the group rather than assuming.
          const verticalsInGroup = [...new Set(ranks.map((r) => r.vertical))]
          return (
          <Card key={groupKey} className="overflow-hidden border-t-4 border-t-primary shadow-sm">
            <CardHeader className="bg-muted/10 pb-4 border-b">
              <div className="flex flex-wrap justify-between items-center gap-3">
                <CardTitle className="text-xl flex items-center gap-2 flex-wrap">
                  {groupLabel}
                  {verticalsInGroup.map((v) => (
                    <Badge key={v} variant="secondary" className="font-mono text-[10px] uppercase">{v.replace('_', ' ')}</Badge>
                  ))}
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead
                      aria-sort={sortAria("rank")}
                      className="w-16 text-center cursor-pointer select-none hover:text-foreground"
                      onClick={() => toggleSort("rank")}
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
                        <div className="font-semibold text-foreground">{r.providerName}</div>
                        {r.rank === 1 && (
                          <div className="text-xs text-primary font-medium mt-1 flex items-center">
                            <CheckCircle2 className="w-3 h-3 mr-1" /> Recommended
                          </div>
                        )}
                      </TableCell>
                      {/* Null "—" means "not measured in this run" (spec:
                          distinct from a true zero) -- title says so instead
                          of leaving the dash ambiguous (UX review). */}
                      <TableCell className="text-right font-mono font-medium" title={r.recommendation ?? undefined}>
                        {r.score.wer != null ? `${(r.score.wer * 100).toFixed(1)}%` : <span title="Not measured in this run">—</span>}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {r.score.entityAccuracy != null ? `${(r.score.entityAccuracy * 100).toFixed(1)}%` : <span title="Not measured in this run">—</span>}
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
            </CardContent>
          </Card>
          )
        })
      )}
    </div>
  )
}
