import * as React from "react"
import { Link } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListBenchmarkRuns,
  useCreateBenchmarkRun,
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
import { Play, Activity, Clock, Server, Database, RotateCw, ListChecks, ArrowUpRight, ChevronDown, ChevronRight, Sparkles } from "lucide-react"
import { format, formatDistanceToNow } from "date-fns"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"

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
          <p className="text-muted-foreground mt-1">Queue and monitor comparable execution jobs.</p>
        </div>
        <QueueRunDialog />
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

function QueueRunDialog() {
  const [open, setOpen] = React.useState(false)
  const { data: providers, isLoading: providersLoading } = useListBenchmarkProviders()
  const { data: calls, isLoading: callsLoading } = useListBenchmarkCalls()
  const [selectedProviders, setSelectedProviders] = React.useState<string[]>([])

  const readyCalls = calls?.filter(c => c.status === 'ready_to_run') || []
  const readyProviders = providers?.filter(p => p.status === 'ready') || []
  const scopeLoading = providersLoading || callsLoading

  // UX review 2026-08-25: launching was blind spend. Everything needed for
  // an exact estimate is already loaded -- cells = providers x calls, cost
  // = sum(durationSeconds/60 * costPerMinute) across the selection.
  const cellCount = selectedProviders.length * readyCalls.length
  const estimatedCost = React.useMemo(() => {
    if (selectedProviders.length === 0) return 0
    const selected = new Set(selectedProviders)
    let total = 0
    for (const c of readyCalls) {
      for (const p of readyProviders) {
        if (selected.has(p.id)) total += (c.durationSeconds / 60) * p.costPerMinute
      }
    }
    return total
  }, [selectedProviders, readyCalls, readyProviders])

  const queryClient = useQueryClient()
  const { toast } = useToast()
  const createRun = useCreateBenchmarkRun()

  const toggleProvider = (id: string) => {
    setSelectedProviders(prev => 
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    )
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (selectedProviders.length === 0 || readyCalls.length === 0) return

    createRun.mutate({
      data: {
        // B-27: the selection could reference a provider disabled after the
        // dialog opened — the server blocks such runs with status "blocked"
        // and a reason in notes. Intersect with what is still ready so the
        // operator never launches a dead scope.
        providerIds: selectedProviders.filter((id) => readyProviders.some((p) => p.id === id)),
        callIds: readyCalls.map(c => c.id)
      }
    }, {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListBenchmarkRunsQueryKey() })
        // B-32: Overview derives its CTA from the dashboard aggregate —
        // without this invalidation it kept saying "Queue a run" with
        // pre-launch numbers for up to 30s, inviting a duplicate launch.
        queryClient.invalidateQueries({ queryKey: getGetBenchmarkDashboardQueryKey() })
        if (data.status === "blocked") {
          // Blocked runs never execute; the toast must not claim they did.
          toast({
            title: "Run blocked",
            description: data.notes ?? "Prerequisites are missing — check the Runs page.",
            variant: "destructive",
          })
        } else {
          setOpen(false)
          setSelectedProviders([])
          toast({ title: "Run started", description: "Provider calls are being made now — monitor progress on the Runs page." })
        }
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to queue run.", variant: "destructive" })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-accent text-accent-foreground hover:bg-accent/90"><Play className="w-4 h-4 mr-2" /> Queue Run</Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Queue Benchmark Run</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-6 pt-4">
          <div className="bg-muted p-4 rounded-md border text-sm space-y-1">
            <div className="flex justify-between items-center">
              <div>
                <div className="font-semibold text-foreground">Target Scope</div>
                <div className="text-muted-foreground">Will execute against all ready calls.</div>
              </div>
              <div className="text-2xl font-mono font-bold">
                {selectedProviders.length} × {readyCalls.length}
                <span className="text-sm font-sans text-muted-foreground font-normal"> = {cellCount} transcriptions</span>
              </div>
            </div>
            {/* NFR-8 pre-flight (UX review 2026-08-25): launch starts billed
                provider calls immediately -- the operator sees the size and
                price of that before clicking. */}
            {cellCount > 0 && (
              <div className="text-right font-mono text-sm text-foreground">
                Estimated cost: ≈ ${estimatedCost.toFixed(2)}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <label className="text-sm font-medium">Select Target Providers</label>
            {scopeLoading ? (
              <div className="text-sm text-muted-foreground">Loading providers and calls…</div>
            ) : readyProviders.length === 0 ? (
              <div className="text-sm text-destructive">No providers ready. Configure providers first.</div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {readyProviders.map(p => (
                  <div 
                    key={p.id} 
                    className={`border p-3 rounded-md cursor-pointer transition-colors ${selectedProviders.includes(p.id) ? 'bg-primary/10 border-primary' : 'hover:bg-muted/50'}`}
                    onClick={() => toggleProvider(p.id)}
                  >
                    <div className="font-medium text-sm">{p.name}</div>
                    <div className="text-xs text-muted-foreground font-mono mt-1">{p.model}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          
          <DialogFooter className="flex-col items-stretch gap-2 sm:items-stretch">
            <p className="text-xs text-muted-foreground text-center sm:text-left">
              Starts paid provider API calls immediately. A run cannot be cancelled once started;
              failed cells can be retried afterwards.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={createRun.isPending || selectedProviders.length === 0 || readyCalls.length === 0}>
                {createRun.isPending ? 'Queuing...' : 'Launch Benchmark'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
// Colors a gold-vs-hypothesis word alignment so a reviewer can see exactly
// which words a provider missed instead of only an aggregate WER number.
// "ok" words are dimmed (not the point), "sub"/"del" are what the provider
// got wrong, "ins" is text the provider added that isn't in gold at all.
// Exported for reuse by the Agent page (2026-08-26): its candidate-vs-real-
// transcript diff highlighting uses the exact same colors/component so a
// mismatch reads the same way everywhere in the app, not a second style.
export function WordDiffView({ wordDiff }: { wordDiff: Array<{ op: string; ref: string | null; hyp: string | null }> }) {
  if (!wordDiff.length) return <p className="text-xs text-muted-foreground">No diff available.</p>
  const errorCount = wordDiff.filter(w => w.op !== "ok").length
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{errorCount} word{errorCount === 1 ? '' : 's'} differ from gold, out of {wordDiff.length}.</p>
      <p className="text-sm leading-7 font-mono">
        {wordDiff.map((w, i) => {
          if (w.op === "ok") {
            return <span key={i} className="text-muted-foreground">{w.ref} </span>
          }
          if (w.op === "sub") {
            return (
              <span key={i} className="mr-1 inline-block">
                {/* Full-opacity destructive + strikethrough: /70 opacity
                    measured ≈3:1 contrast, vanishing the gold word a
                    reviewer needs (theme review 2026-08-25). */}
                <span className="line-through text-destructive">{w.ref}</span>
                {"→"}
                <span className="text-warning font-semibold">{w.hyp}</span>
              </span>
            )
          }
          if (w.op === "del") {
            return <span key={i} className="line-through text-destructive mr-1">{w.ref}</span>
          }
          // ins: provider said a word that isn't in gold at all
          return <span key={i} className="text-chart-3 font-semibold mr-1">+{w.hyp}</span>
        })}
      </p>
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

function ResultsDialog({ runId }: { runId: string }) {
  const [open, setOpen] = React.useState(false)
  const [expandedId, setExpandedId] = React.useState<string | null>(null)
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
  const callGroups = React.useMemo(() => {
    const order: string[] = []
    const byCallId = new Map<string, typeof results>()
    for (const r of results ?? []) {
      if (!byCallId.has(r.callId)) { order.push(r.callId); byCallId.set(r.callId, []) }
      byCallId.get(r.callId)!.push(r)
    }
    return order.map((callId) => ({ callId, rows: byCallId.get(callId)! }))
  }, [results])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm"><ListChecks className="w-3.5 h-3.5 mr-1.5" /> Results</Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Per-cell results</DialogTitle>
        </DialogHeader>
        <div className="max-h-[55vh] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-6"></TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>WER</TableHead>
                <TableHead>Entity Acc.</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isError ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-destructive text-sm">
                    Failed to load results: {error instanceof Error ? error.message : String(error)}{" "}
                    <Button variant="outline" size="sm" className="ml-2" onClick={() => void refetch()}>Retry</Button>
                  </TableCell>
                </TableRow>
              ) : isLoading ? (
                <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">Loading...</TableCell></TableRow>
              ) : !results?.length ? (
                <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No cells executed yet.</TableCell></TableRow>
              ) : callGroups.map(({ callId, rows }) => (
                <React.Fragment key={callId}>
                  <TableRow className="bg-muted/20 hover:bg-muted/20">
                    <TableCell colSpan={6} className="py-1.5">
                      <span className="text-xs font-semibold">{callLabelById.get(callId) ?? callId.slice(0, 8)}</span>
                      <span className="ml-2 font-mono text-[10px] text-muted-foreground">{callId.slice(0, 8)}</span>
                      <span className="ml-2 text-[10px] text-muted-foreground">· {rows.length} provider{rows.length === 1 ? '' : 's'}</span>
                    </TableCell>
                  </TableRow>
                  {rows.map(r => {
                    const hasDiff = !!r.score?.wordDiff?.length
                    const hasExpandable = hasDiff || r.status === 'failed'
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
                            {r.status}
                          </Badge>
                        </TableCell>
                        {/* Percent format matches Rankings/Review -- the same
                            score used to read 0.123 here and 12.3% there
                            (terminology review 2026-08-25). */}
                        <TableCell className="font-mono text-xs">{r.score?.wer != null ? `${(r.score.wer * 100).toFixed(1)}%` : <span title="Not measured in this run">—</span>}</TableCell>
                        <TableCell className="font-mono text-xs">{r.score?.entityAccuracy != null ? `${(r.score.entityAccuracy * 100).toFixed(1)}%` : <span title="Not measured in this run">—</span>}</TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-xs truncate" title={r.errorMessage ?? undefined}>
                          {r.failureDiagnosis ? "AI analysis available" : r.errorMessage ?? '—'}
                        </TableCell>
                      </TableRow>
                      {isExpanded && hasDiff && r.score?.wordDiff && (
                        <TableRow>
                          <TableCell colSpan={6} className="bg-muted/30">
                            <WordDiffView wordDiff={r.score.wordDiff} />
                          </TableCell>
                        </TableRow>
                      )}
                      {isExpanded && r.status === 'failed' && (
                        <TableRow>
                          <TableCell colSpan={6} className="bg-muted/30">
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
                  })}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
        <DialogFooter className="border-t border-border pt-3 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            This is the raw drill-down for this run. Rankings and the keep/switch recommendation live in Results.
          </span>
          <Link href="/results" onClick={() => setOpen(false)}>
            <Button variant="outline" size="sm">
              View in Results <ArrowUpRight className="w-3.5 h-3.5 ml-1.5" />
            </Button>
          </Link>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
