import * as React from "react"
import { Link } from "wouter"
import {
  getGetBulkQueryKey,
  getHealthCheckQueryKey,
  useGetBenchmarkDashboard,
  useGetBulk,
  useHealthCheck,
  type BenchmarkDashboard,
} from "@workspace/api-client-react"
import { AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DecisionChip, summarizeBulkVerdicts, useBulkVerdicts } from "@/components/verdict-headline"
import { apiBase } from "@/lib/api-base"
import { formatMicrocents } from "@/lib/utils"

// ---------------------------------------------------------------------------
// T-84 (per Abhishek 2026-08-30: "redesign the overview page, minimalist").
//
// One column, no cards. The page is four flat sections separated by
// hairlines, each answering one question in one line of large type and one
// line of small type:
//   1. The verdict         -- one sentence, the provider name in ink
//   2. Needs a person      -- four numbers in a row, each a link
//   3. Running now         -- one line + a hairline progress bar (only when true)
//   4. This month          -- two amounts and the API build, in a row
// Numbers are computed on the server (api-server/src/lib/overview.ts) and the
// verdict sentence comes from the same endpoint Results uses, so nothing here
// can disagree with a detail page. Pattern checked on Mobbin (Midday home:
// greeting sentence, a flat row of figures, plain links) -- D.5 "stop
// wrapping everything in a card" applied literally.
// ---------------------------------------------------------------------------

function Row({ children }: { children: React.ReactNode }) {
  return <section className="space-y-3 border-t border-border py-7 first:border-t-0 first:pt-0">{children}</section>
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <h2 className="font-mono text-[11px] uppercase tracking-[0.09em] text-muted-foreground">{children}</h2>
}

function Figure({ value, label, href, tone = "quiet" }: { value: React.ReactNode; label: string; href?: string; tone?: "quiet" | "attention" | "destructive" }) {
  const color = tone === "attention" ? "text-warning" : tone === "destructive" ? "text-destructive" : "text-foreground"
  const body = (
    <span className="flex items-baseline gap-2">
      <span className={`font-mono text-2xl font-semibold tabular-nums leading-none ${color}`}>{value}</span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </span>
  )
  return href ? <Link href={href} className="group rounded-sm hover:underline">{body}</Link> : body
}

function fmtDate(iso: string | null): string {
  if (!iso) return "finished"
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" })
}

function Verdict({ bulk }: { bulk: BenchmarkDashboard["latestFinishedBulk"] }) {
  const { data, isLoading } = useBulkVerdicts(bulk?.id ?? null)
  if (!bulk) {
    return (
      <Row>
        <Eyebrow>Verdict</Eyebrow>
        <p className="text-2xl leading-snug" style={{ textWrap: "balance" }}>No bulk has finished yet.</p>
        <p className="text-sm text-muted-foreground">
          A verdict needs a finished bulk. <Link href="/bulks" className="text-primary hover:underline">Launch one →</Link>
        </p>
      </Row>
    )
  }
  const summary = data ? summarizeBulkVerdicts(data) : null
  return (
    <Row>
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow>Verdict</Eyebrow>
        {summary && <DecisionChip decision={summary.tone} />}
        <span className="text-xs text-muted-foreground">{bulk.name} · {fmtDate(bulk.completedAt)}{bulk.status === "partial" ? " · some cells failed" : ""}</span>
      </div>
      {isLoading || !summary ? (
        <div className="h-8 w-2/3 animate-pulse rounded bg-muted" />
      ) : (
        <p className="max-w-[40ch] text-2xl leading-snug" style={{ textWrap: "balance" }}>
          {summary.leadName && <span className="font-semibold">{summary.leadName} </span>}
          {summary.sentence}
        </p>
      )}
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {summary && <span>{summary.totalCalls} calls scored · {summary.groups} group{summary.groups === 1 ? "" : "s"}</span>}
        <Link href="/results" className="text-primary hover:underline">Open Results →</Link>
        <a href={`${apiBase()}/api/benchmark/bulks/${bulk.id}/verdict.html`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
          Share verdict →
        </a>
      </p>
    </Row>
  )
}

function NeedsHuman({ data }: { data: BenchmarkDashboard["needsHuman"] }) {
  const open = data.spans ? data.spans.total - data.spans.adjudicated : null
  const attention = (n: number | null) => (n != null && n > 0 ? "attention" : "quiet")
  return (
    <Row>
      <Eyebrow>Needs a person</Eyebrow>
      <div className="flex flex-wrap gap-x-10 gap-y-4">
        <Figure value={data.callsAwaitingReview} label="calls awaiting review" href="/corpus" tone={attention(data.callsAwaitingReview)} />
        <Figure value={data.hardCaseCalls} label="hard cases" href="/corpus" tone={attention(data.hardCaseCalls)} />
        <Figure value={open == null ? "—" : open} label="spans to rule on" href="/corpus" tone={attention(open)} />
        <Figure value={data.retryableFailedCells} label="cells a retry could fix" href="/bulks" tone={attention(data.retryableFailedCells)} />
      </div>
      <p className="text-xs text-muted-foreground">
        {data.spans
          ? `${data.spans.adjudicated} of ${data.spans.total} spans ruled on in the latest finished bulk; the AI judge's accuracy is unmeasured until a person rules on 10.`
          : "No finished bulk yet, so nothing to rule on."}
      </p>
    </Row>
  )
}

function RunningNow({ bulk }: { bulk: NonNullable<BenchmarkDashboard["runningBulk"]> }) {
  const { data: detail } = useGetBulk(bulk.id, { query: { queryKey: getGetBulkQueryKey(bulk.id), refetchInterval: 5000 } })
  const p = detail?.progress
  const done = p ? p.cellsOk + p.cellsFailed + p.cellsCancelled + p.cellsSkippedPendingReview : 0
  const pct = p && p.cellsTotal > 0 ? Math.round((done / p.cellsTotal) * 100) : 0
  return (
    <Row>
      <Eyebrow>Running now</Eyebrow>
      <p className="text-2xl leading-snug">
        <span className="font-semibold">{bulk.name}</span>
        {p && <span className="text-muted-foreground"> · {pct}%</span>}
      </p>
      <div className="h-px w-full bg-border">
        <div className="h-px bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="flex flex-wrap gap-x-4 text-sm text-muted-foreground">
        {p ? (
          <>
            <span>{p.cellsOk} ok{p.cellsFailed > 0 ? `, ${p.cellsFailed} failed` : ""} of {p.cellsTotal}</span>
            <span>{p.callsRun}/{p.callsTotal} calls</span>
            <span>STT so far {formatMicrocents(detail?.actualCost.sttCostMicrocents)} · AI check {formatMicrocents(detail?.actualCost.agentCostMicrocents)}</span>
          </>
        ) : (
          <span>Loading…</span>
        )}
        <Link href="/bulks" className="text-primary hover:underline">Open Bulks →</Link>
      </p>
    </Row>
  )
}

function ThisMonth({ month }: { month: BenchmarkDashboard["thisMonth"] }) {
  const { data: health, isError } = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30_000, retry: false } })
  const since = new Date(month.monthStart).toLocaleDateString(undefined, { month: "long" })
  const unpriced = month.sttCellsUnpriced + month.agentJudgementsUnpriced
  return (
    <Row>
      <Eyebrow>Spent in {since}</Eyebrow>
      <div className="flex flex-wrap gap-x-10 gap-y-4">
        <Figure value={formatMicrocents(month.sttMicrocents)} label="transcription" />
        <Figure value={formatMicrocents(month.agentMicrocents)} label="AI judge" />
        <Figure
          value={isError ? "down" : health ? health.commitSha.replace(/-dirty$/, "") : "…"}
          label={isError ? "API not reachable" : health?.commitSha.endsWith("-dirty") ? "API build (uncommitted tree)" : "API build"}
          tone={isError ? "destructive" : "quiet"}
        />
      </div>
      {unpriced > 0 && (
        <p className="text-xs text-warning">{unpriced} item{unpriced === 1 ? "" : "s"} with no recorded cost are not included.</p>
      )}
    </Row>
  )
}

export default function Dashboard() {
  const { data, isLoading, error, refetch } = useGetBenchmarkDashboard()

  if (isLoading) {
    return (
      <div className="max-w-[760px] animate-pulse space-y-8">
        <div className="h-7 w-40 rounded bg-muted" />
        <div className="h-10 w-3/4 rounded bg-muted/60" />
        <div className="h-8 w-1/2 rounded bg-muted/40" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex h-64 flex-col items-center justify-center space-y-4">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <h2 className="text-lg font-semibold">Failed to load the overview</h2>
        <p className="text-muted-foreground">The API server might not be running. {error instanceof Error ? error.message : ""}</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>Retry</Button>
      </div>
    )
  }

  return (
    <div className="max-w-[760px]">
      <h1 className="mb-8 text-3xl font-bold tracking-tight">Overview</h1>
      <Verdict bulk={data.latestFinishedBulk} />
      <NeedsHuman data={data.needsHuman} />
      {data.runningBulk && <RunningNow bulk={data.runningBulk} />}
      <ThisMonth month={data.thisMonth} />
      {data.corpusCount === 0 && (
        <p className="border-t border-border pt-7 text-sm text-muted-foreground">
          No calls imported yet. <Link href="/setup?tab=sources" className="text-primary hover:underline">Import from Vapi →</Link>
        </p>
      )}
    </div>
  )
}
