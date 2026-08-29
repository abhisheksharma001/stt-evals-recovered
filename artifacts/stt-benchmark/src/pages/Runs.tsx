import * as React from "react"
import { Link } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListBenchmarkRuns,
  useExecuteBenchmarkRun,
  useListBenchmarkRunResults,
  useListBenchmarkProviders,
  useListBenchmarkCalls,
  useAnalyzeResultFailure,
  getListBenchmarkRunsQueryKey,
  getListBenchmarkRunResultsQueryKey,
  getGetBenchmarkDashboardQueryKey,
  RunStatus
} from "@workspace/api-client-react"
import { Rocket, Activity, Server, Database, RotateCw, ListChecks, ArrowUpRight, ChevronDown, ChevronRight, Sparkles } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { WordDiffView } from "@/components/word-diff-view"

export default function Runs() {
  // Runs execute fire-and-forget in the background (no job queue -- see
  // .claude/CLAUDE.md) and there was no way to see a "running" run finish
  // short of manually reloading the page. Poll while anything is actually
  // in flight; stop polling the moment nothing is (avoids hammering the API
  // once every run has settled).
  const { data: runs, isLoading, isError, error } = useListBenchmarkRuns({
    query: {
      queryKey: getListBenchmarkRunsQueryKey(),
      refetchInterval: (query) => {
        const hasInFlightRun = query.state.data?.some(
          (run) => run.status === "queued" || run.status === "running",
        )
        return hasInFlightRun ? 3000 : false
      },
    },
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Benchmark Runs</h1>
          <p className="text-muted-foreground mt-1">Monitor execution jobs launched from Bulks.</p>
        </div>
        {/* technical-fixes FIX-6 / ux-fixes UX-4: this page used to have its
            own "Queue Run" dialog (always the whole ready-to-run corpus, no
            assistant/date scoping) alongside Bulks' separate, more capable
            launch flow -- two independent ways to start a run with no
            relationship to each other. Folded into one launch surface:
            Bulks already supports "whole corpus" when its filters are left
            empty, so nothing is lost, and every run (bulk-scoped or not)
            still shows up in this list either way. */}
        <Link href="/bulks">
          <Button className="bg-accent text-accent-foreground hover:bg-accent/90">
            <Rocket className="w-4 h-4 mr-2" /> Launch a run in Bulks
          </Button>
        </Link>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isError ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-destructive text-sm">
                    Failed to load runs: {error instanceof Error ? error.message : String(error)}
                  </TableCell>
                </TableRow>
              ) : isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">Loading run history...</TableCell>
                </TableRow>
              ) : runs?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">No benchmark runs recorded.</TableCell>
                </TableRow>
              ) : (
                runs?.map(run => (
                  <TableRow key={run.id}>
                    <TableCell className="font-mono text-xs font-semibold">
                      {run.id.substring(0, 8)}
                    </TableCell>
                    <TableCell>
                      <RunStatusBadge status={run.status} />
                      {/* Executor writes actionable guidance here ("N cell(s)
                          failed transiently and can be retried...", blocked
                          reasons). Surfacing it turns a bare FAILED badge
                          into a next step. UX review 2026-08-25. */}
                      {run.notes && (
                        <div className="mt-1 max-w-xs truncate text-xs text-muted-foreground" title={run.notes}>
                          {run.notes}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-4 text-xs font-mono">
                        <span className="flex items-center text-muted-foreground"><Server className="w-3 h-3 mr-1" /> {run.providerIds.length} Providers</span>
                        <span className="flex items-center text-muted-foreground"><Database className="w-3 h-3 mr-1" /> {run.callCount} Calls</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDistanceToNow(new Date(run.createdAt), { addSuffix: true })}
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {run.completedAt
                        ? `${Math.floor((new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()) / 1000)}s`
                        : run.status === 'running' ? <Activity className="w-4 h-4 animate-pulse text-primary" /> : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <ResultsDialog runId={run.id} />
                        {/* B-15: the backend deliberately re-executes
                            complete (retry failed cells) and running (crash
                            recovery) runs too — gating the button to
                            failed|queued made the documented retry path
                            unreachable for partial-outage runs. */}
                        {(run.status === 'failed' || run.status === 'queued' || run.status === 'complete' || run.status === 'running') && (
                          <ExecuteButton runId={run.id} />
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function RunStatusBadge({ status }: { status: RunStatus }) {
  const styles: Record<RunStatus, string> = {
    queued: "bg-secondary text-muted-foreground border-border",
    running: "bg-primary/15 text-primary animate-pulse border-primary/30",
    complete: "bg-success/10 text-success border-success/25",
    blocked: "bg-warning/10 text-warning border-warning/25",
    failed: "bg-destructive/10 text-destructive border-destructive/25",
    cancelled: "bg-secondary text-muted-foreground border-border line-through"
  }

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold font-mono uppercase tracking-widest border ${styles[status]}`}>
      {status}
    </span>
  )
}


// FR-E4: a queued run that never started, or a run left "failed" after a
// partial outage, can be (re)executed here -- only the cells without a
// successful result are retried (see run-executor.ts).
function ExecuteButton({ runId }: { runId: string }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const execute = useExecuteBenchmarkRun()

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={execute.isPending}
      onClick={() => execute.mutate({ runId }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListBenchmarkRunsQueryKey() })
          queryClient.invalidateQueries({ queryKey: getGetBenchmarkDashboardQueryKey() })
          toast({ title: "Run started", description: "Retrying cells that don't have a successful result yet." })
        },
        onError: () => {
          toast({ title: "Error", description: "Failed to start execution.", variant: "destructive" })
        }
      })}
    >
      <RotateCw className="w-3.5 h-3.5 mr-1.5" /> Execute
    </Button>
  )
}

// FR-E3 drill-down: per (provider, call) cell -- raw status/latency plus the
// score, so an operator can see exactly why a run landed where it did
// instead of trusting only the aggregate ranking.
// T-72: WordDiffView moved to components/word-diff-view.tsx (one organism
// for Runs, Corpus and Results).

// 2026-08-27: the gold-free replacement for WordDiffView above -- shows
// exactly why a cell was flagged (cross-provider disagreement, low-
// confidence words per that provider, entity mismatches it took part in)
// instead of an aggregate flag count alone.
export type HybridFlagDetail = {
  crossProviderDisagreement?: { disagreementRate?: number; mismatchWords?: number; comparedWords?: number } | null
  lowConfidenceSpans?: Array<{ words?: string[]; avgConfidence?: number; severity?: string }>
  entityMismatches?: Array<{ type?: string; valuesByProvider?: Record<string, string[]> }>
}

export function HybridFlagView({ detail }: { detail: HybridFlagDetail }) {
  const disagreement = detail.crossProviderDisagreement
  const confidenceSpans = detail.lowConfidenceSpans ?? []
  const entityMismatches = detail.entityMismatches ?? []
  const nothing = !disagreement?.disagreementRate && confidenceSpans.length === 0 && entityMismatches.length === 0

  if (nothing) return <p className="text-xs text-muted-foreground">No hybrid flags for this cell.</p>

  return (
    <div className="space-y-2.5 text-sm">
      {disagreement && disagreement.disagreementRate != null && disagreement.disagreementRate > 0.15 && (
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cross-provider disagreement:</span>
          <span className="font-mono text-warning">{Math.round(disagreement.disagreementRate * 100)}%</span>
          <span className="text-xs text-muted-foreground">of its words don't match its peers ({disagreement.mismatchWords}/{disagreement.comparedWords} word-comparisons).</span>
        </div>
      )}
      {confidenceSpans.length > 0 && (
        <div>
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Low-confidence spans:</span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {confidenceSpans.map((span, i) => (
              <span
                key={i}
                className="rounded border border-destructive/25 bg-destructive/10 px-1.5 py-0.5 font-mono text-xs text-destructive"
                title={`avg confidence ${((span.avgConfidence ?? 0) * 100).toFixed(0)}%`}
              >
                {(span.words ?? []).join(" ")}
              </span>
            ))}
          </div>
        </div>
      )}
      {entityMismatches.length > 0 && (
        <div>
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Entity mismatches:</span>
          <div className="mt-1 space-y-1">
            {entityMismatches.map((m, i) => (
              <div key={i} className="text-xs">
                <span className="font-mono font-semibold text-destructive uppercase">{(m.type ?? "").replace(/_/g, " ")}</span>{": "}
                {Object.entries(m.valuesByProvider ?? {}).map(([pid, values], j) => (
                  <span key={pid} className="text-muted-foreground">
                    {j > 0 && " vs. "}
                    <span className="font-mono">{pid}</span>: {values.join(", ")}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// 2026-08-26, per Abhishek: a raw errorMessage wasn't enough to act on for
// the many cells that were failing. On-demand, per cell (real OpenAI cost) --
// generates a plain-English diagnosis + suggested fix and persists it on the
// result row, so it's there for free on the next view.
function FailureAnalysisPanel({
  runId,
  resultId,
  errorMessage,
  failureDiagnosis,
  failureSuggestedFix,
}: {
  runId: string
  resultId: string
  errorMessage: string | null
  failureDiagnosis: string | null
  failureSuggestedFix: string | null
}) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const analyze = useAnalyzeResultFailure()

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground font-mono whitespace-pre-wrap">{errorMessage}</p>
      {failureDiagnosis ? (
        <div className="text-sm rounded-md border border-border bg-muted/40 px-3 py-2 space-y-1">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Diagnosis: </span>
            {failureDiagnosis}
          </div>
          <div>
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Suggested fix: </span>
            {failureSuggestedFix}
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={analyze.isPending || !errorMessage}
          onClick={() =>
            analyze.mutate(
              { resultId },
              {
                onSuccess: () => queryClient.invalidateQueries({ queryKey: getListBenchmarkRunResultsQueryKey(runId) }),
                onError: (err) => toast({ title: "Error", description: err instanceof Error ? err.message : "Analysis failed.", variant: "destructive" }),
              },
            )
          }
        >
          <Sparkles className={`w-3.5 h-3.5 mr-1.5 ${analyze.isPending ? "animate-pulse" : ""}`} />
          {analyze.isPending ? "Analyzing…" : "AI analysis"}
        </Button>
      )}
    </div>
  )
}

// ux-fixes UX-3: this used to be named/labeled "Results," the same word the
// Rankings page's title uses for a completely different thing (the
// aggregate recommendation). Renamed to "Cell detail" throughout -- this
// dialog is the raw per-(call, provider) drill-down; "Results" now means
// only the Rankings page.
function ResultsDialog({ runId }: { runId: string }) {
  const [open, setOpen] = React.useState(false)
  const [expandedId, setExpandedId] = React.useState<string | null>(null)
  // ux-fixes UX-1: skipped_pending_review cells are collapsed by default --
  // see the split below.
  const [showSkipped, setShowSkipped] = React.useState(false)
  const { data: results, isLoading, isError, error, refetch } = useListBenchmarkRunResults(runId, {
    // UX review 2026-08-25: the drill-down used to freeze on "No cells
    // executed yet." for a run still in flight -- poll while open; closing
    // the dialog stops it.
    query: {
      enabled: open,
      queryKey: getListBenchmarkRunResultsQueryKey(runId),
      refetchInterval: 3000,
    }
  })
  // Provider rows carry raw ids; resolve them to display names so the
  // results table reads like the rest of the app (review finding #17).
  const { data: providers } = useListBenchmarkProviders()
  const providerNameOf = (id: string): string =>
    providers?.find((p) => p.id === id)?.name ?? id
  // 2026-08-26, per Abhishek: grouped by call id -- "open it, see every
  // provider's output together" -- instead of one flat list mixing every
  // call's cells.
  const { data: calls } = useListBenchmarkCalls()
  const callLabelById = React.useMemo(
    () => new Map((calls ?? []).map((c) => [c.id, c.label])),
    [calls],
  )
  // ux-fixes UX-1: "a lot of them are getting failed and skipped" traced to
  // skipped_pending_review cells (a call matched a bulk's filters but hasn't
  // cleared review yet -- FR-BLK-11, not a failure) rendering as full rows
  // with the same visual weight as a real ok/failed attempt. Confirmed live:
  // these are routinely the majority of a bulk run's cells. Split them out
  // so the attempted cells (what actually ran) are what's visible by
  // default, and the skipped count reads as a single clear line instead of
  // a wall of identical rows.
  const attemptedResults = React.useMemo(
    () => (results ?? []).filter((r) => r.status !== 'skipped_pending_review'),
    [results],
  )
  const skippedResults = React.useMemo(
    () => (results ?? []).filter((r) => r.status === 'skipped_pending_review'),
    [results],
  )
  const groupByCall = (rows: typeof results) => {
    const order: string[] = []
    const byCallId = new Map<string, typeof results>()
    for (const r of rows ?? []) {
      if (!byCallId.has(r.callId)) { order.push(r.callId); byCallId.set(r.callId, []) }
      byCallId.get(r.callId)!.push(r)
    }
    return order.map((callId) => ({ callId, rows: byCallId.get(callId)! }))
  }
  const attemptedGroups = React.useMemo(() => groupByCall(attemptedResults), [attemptedResults])
  const skippedGroups = React.useMemo(() => groupByCall(skippedResults), [skippedResults])

  const renderRow = (r: NonNullable<typeof results>[number]) => {
    const hasDiff = !!r.score?.wordDiff?.length
    const flagCount = r.score?.flagCount ?? null
    const flagSeverity = r.score?.flagSeverity ?? null
    const hasHybridFlags = flagCount != null && flagCount > 0
    const hasExpandable = hasDiff || hasHybridFlags || r.status === 'failed'
    const isExpanded = expandedId === r.id
    return (
      <React.Fragment key={r.id}>
        <TableRow
          className={hasExpandable ? "cursor-pointer" : undefined}
          onClick={() => hasExpandable && setExpandedId(isExpanded ? null : r.id)}
        >
          <TableCell className="w-6">
            {hasExpandable && (isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />)}
          </TableCell>
          <TableCell className="text-xs">{providerNameOf(r.providerId)}</TableCell>
          <TableCell>
            <Badge variant={r.status === 'ok' ? 'default' : r.status === 'failed' ? 'destructive' : 'secondary'} className="uppercase text-[10px]">
              {r.status.replaceAll('_', ' ')}
            </Badge>
          </TableCell>
          {/* 2026-08-27: gold-free hybrid flag count + severity, replaces
              WER/Entity Acc. (no gold transcript to score against). */}
          <TableCell className="font-mono text-xs">
            {flagCount == null ? (
              <span title="Not measured for this cell">—</span>
            ) : flagCount === 0 ? (
              <span className="text-success">0</span>
            ) : (
              <span className={flagSeverity === 'high' ? 'text-destructive font-semibold' : flagSeverity === 'medium' ? 'text-warning' : 'text-muted-foreground'}>
                {flagCount} ({flagSeverity})
              </span>
            )}
          </TableCell>
          <TableCell className="text-xs text-muted-foreground max-w-xs truncate" title={r.errorMessage ?? undefined}>
            {r.failureDiagnosis ? "Diagnosis available" : r.errorMessage ?? '—'}
          </TableCell>
        </TableRow>
        {isExpanded && hasHybridFlags && (
          <TableRow>
            <TableCell colSpan={5} className="bg-muted/30">
              <HybridFlagView detail={(r.score?.hybridFlags ?? {}) as HybridFlagDetail} />
            </TableCell>
          </TableRow>
        )}
        {isExpanded && !hasHybridFlags && hasDiff && r.score?.wordDiff && (
          <TableRow>
            <TableCell colSpan={5} className="bg-muted/30">
              <WordDiffView wordDiff={r.score.wordDiff} referenceLabel="gold" />
            </TableCell>
          </TableRow>
        )}
        {isExpanded && r.status === 'failed' && (
          <TableRow>
            <TableCell colSpan={5} className="bg-muted/30">
              <FailureAnalysisPanel
                runId={runId}
                resultId={r.id}
                errorMessage={r.errorMessage ?? null}
                failureDiagnosis={r.failureDiagnosis ?? null}
                failureSuggestedFix={r.failureSuggestedFix ?? null}
              />
            </TableCell>
          </TableRow>
        )}
      </React.Fragment>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm"><ListChecks className="w-3.5 h-3.5 mr-1.5" /> Cell detail</Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Cell detail</DialogTitle>
        </DialogHeader>
        <div className="max-h-[55vh] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-6"></TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Status</TableHead>
                {/* 2026-08-27: WER/Entity Acc. columns retired -- no gold
                    transcript to score against any more. Flags is the
                    gold-free hybrid signal (cross-provider disagreement +
                    confidence + entity mismatch) that replaces them. */}
                <TableHead>Flags</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isError ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-destructive text-sm">
                    Failed to load results: {error instanceof Error ? error.message : String(error)}{" "}
                    <Button variant="outline" size="sm" className="ml-2" onClick={() => void refetch()}>Retry</Button>
                  </TableCell>
                </TableRow>
              ) : isLoading ? (
                <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">Loading...</TableCell></TableRow>
              ) : !results?.length ? (
                <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No cells executed yet.</TableCell></TableRow>
              ) : (
                <>
                  {attemptedGroups.length === 0 ? (
                    <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No cells were attempted yet -- see skipped below.</TableCell></TableRow>
                  ) : attemptedGroups.map(({ callId, rows }) => (
                    <React.Fragment key={callId}>
                      <TableRow className="bg-muted/20 hover:bg-muted/20">
                        <TableCell colSpan={5} className="py-1.5">
                          <span className="text-xs font-semibold">{callLabelById.get(callId) ?? callId.slice(0, 8)}</span>
                          <span className="ml-2 font-mono text-[10px] text-muted-foreground">{callId.slice(0, 8)}</span>
                          <span className="ml-2 text-[10px] text-muted-foreground">· {rows.length} provider{rows.length === 1 ? '' : 's'}</span>
                        </TableCell>
                      </TableRow>
                      {rows.map(renderRow)}
                    </React.Fragment>
                  ))}
                  {skippedResults.length > 0 && (
                    <>
                      <TableRow
                        className="cursor-pointer bg-secondary/40 hover:bg-secondary/60"
                        onClick={() => setShowSkipped((v) => !v)}
                      >
                        <TableCell className="w-6">
                          {showSkipped ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
                        </TableCell>
                        <TableCell colSpan={4} className="text-xs text-muted-foreground">
                          {skippedResults.length} cell{skippedResults.length === 1 ? '' : 's'} skipped — matching calls haven't cleared review yet
                        </TableCell>
                      </TableRow>
                      {showSkipped && skippedGroups.map(({ callId, rows }) => (
                        <React.Fragment key={callId}>
                          <TableRow className="bg-muted/10 hover:bg-muted/10">
                            <TableCell colSpan={5} className="py-1.5">
                              <span className="text-xs font-semibold">{callLabelById.get(callId) ?? callId.slice(0, 8)}</span>
                              <span className="ml-2 font-mono text-[10px] text-muted-foreground">{callId.slice(0, 8)}</span>
                              <span className="ml-2 text-[10px] text-muted-foreground">· {rows.length} provider{rows.length === 1 ? '' : 's'}</span>
                            </TableCell>
                          </TableRow>
                          {rows.map(renderRow)}
                        </React.Fragment>
                      ))}
                    </>
                  )}
                </>
              )}
            </TableBody>
          </Table>
        </div>
        <DialogFooter className="border-t border-border pt-3 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            This is the raw drill-down for this run. Rankings and the keep/switch recommendation live in Rankings.
          </span>
          <Link href="/results" onClick={() => setOpen(false)}>
            <Button variant="outline" size="sm">
              View in Rankings <ArrowUpRight className="w-3.5 h-3.5 ml-1.5" />
            </Button>
          </Link>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
