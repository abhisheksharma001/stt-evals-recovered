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
import { Activity, AlertCircle, ArrowRight, ExternalLink, Gavel, Layers, RotateCcw, Users } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { BulkVerdictBanner } from "@/components/verdict-headline"
import { apiBase } from "@/lib/api-base"
import { formatMicrocents } from "@/lib/utils"

/**
 * T-71 (PRD-v4-uiux E.3): the Overview answers "where do things stand right
 * now", in four blocks, top to bottom -- latest verdict, what needs a human,
 * running now, this month. Every number is computed on the server
 * (api-server/src/lib/overview.ts) from the same tables Bulks, Corpus and
 * Results read, so nothing here can disagree with a detail page. The
 * verdict block reuses <BulkVerdictBanner> against the same endpoint
 * Results uses; it never re-derives a winner.
 *
 * Gone from this page (E.3): corpus-by-vertical, the provider list, recent
 * runs. Each belongs to Corpus, Providers and Bulks and is one click away.
 */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="font-mono text-[11px] uppercase tracking-[0.09em] text-muted-foreground">{children}</h2>
}

function fmtDate(iso: string | null): string {
  if (!iso) return "finished (time not recorded)"
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

function LatestVerdict({ bulk }: { bulk: BenchmarkDashboard["latestFinishedBulk"] }) {
  if (!bulk) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-6 p-5">
          <div>
            <p className="text-base font-semibold">No bulk has completed yet.</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              A verdict needs a finished bulk. Launch one from Bulks; it shows up here when it completes.
            </p>
          </div>
          <Button asChild className="shrink-0">
            <Link href="/bulks">Open Bulks <ArrowRight className="ml-2 h-4 w-4" /></Link>
          </Button>
        </CardContent>
      </Card>
    )
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm">
          <span className="font-medium">{bulk.name}</span>
          <span className="text-muted-foreground"> · {fmtDate(bulk.completedAt)}</span>
          {bulk.status === "partial" && (
            <span className="text-muted-foreground"> · finished with some failed cells</span>
          )}
        </p>
        <div className="flex items-center gap-3 text-xs">
          <Link href="/results" className="text-primary hover:underline">Open in Results →</Link>
          <a
            href={`${apiBase()}/api/benchmark/bulks/${bulk.id}/verdict.html`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            Shareable verdict <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
      <BulkVerdictBanner bulkId={bulk.id} groupLabels={{}} />
    </div>
  )
}

function HumanRow({
  icon: Icon,
  count,
  label,
  detail,
  href,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>
  count: number
  label: string
  detail: string
  href: string
  action: string
}) {
  const quiet = count === 0
  return (
    <div className={`flex items-center gap-3.5 rounded-lg border px-3.5 py-3 ${quiet ? "border-border bg-transparent" : "border-warning/30 bg-warning/5"}`}>
      <Icon className={`h-4 w-4 shrink-0 ${quiet ? "text-muted-foreground" : "text-warning"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xl font-semibold tabular-nums leading-none">{count.toLocaleString()}</span>
          <span className="text-sm font-medium">{label}</span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      </div>
      <Link href={href} className="shrink-0 text-xs text-primary hover:underline">{action} →</Link>
    </div>
  )
}

function NeedsHuman({ data }: { data: BenchmarkDashboard["needsHuman"] }) {
  const spans = data.spans
  const open = spans ? spans.total - spans.adjudicated : null
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <HumanRow
        icon={Users}
        count={data.callsAwaitingReview}
        label="calls awaiting review"
        detail="Imported but not yet ready to run. Normally 0 -- the review gate was retired 2026-08-27."
        href="/corpus"
        action="Corpus"
      />
      <HumanRow
        icon={AlertCircle}
        count={data.hardCaseCalls}
        label="calls tagged hard case"
        detail="Marked by a person as unusually hard audio; worth a listen before trusting the score."
        href="/corpus"
        action="Corpus"
      />
      <div className={`flex items-center gap-3.5 rounded-lg border px-3.5 py-3 ${open ? "border-warning/30 bg-warning/5" : "border-border"}`}>
        <Gavel className={`h-4 w-4 shrink-0 ${open ? "text-warning" : "text-muted-foreground"}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xl font-semibold tabular-nums leading-none">
              {open === null ? "—" : open.toLocaleString()}
            </span>
            <span className="text-sm font-medium">disagreement spans not yet adjudicated</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {spans
              ? `${spans.adjudicated.toLocaleString()} of ${spans.total.toLocaleString()} ruled on in the latest finished bulk. The judge's accuracy is unmeasured until a person rules on at least 10.`
              : "No finished bulk yet, so there are no spans to rule on."}
          </p>
        </div>
        <Link href="/corpus" className="shrink-0 text-xs text-primary hover:underline">Corpus →</Link>
      </div>
      <HumanRow
        icon={RotateCcw}
        count={data.retryableFailedCells}
        label="failed cells a retry could fix"
        detail="In stopped bulks; timeouts, 5xx and rate limits only. Expired or forbidden audio is not counted -- a retry cannot fix it."
        href="/bulks"
        action="Bulks"
      />
    </div>
  )
}

function ProgressBar({ ok, failed, total }: { ok: number; failed: number; total: number }) {
  const pct = (n: number) => (total > 0 ? `${(n / total) * 100}%` : "0%")
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-secondary">
      <div className="bg-success" style={{ width: pct(ok) }} />
      <div className="bg-destructive" style={{ width: pct(failed) }} />
    </div>
  )
}

function RunningNow({ bulk }: { bulk: NonNullable<BenchmarkDashboard["runningBulk"]> }) {
  const { data: detail } = useGetBulk(bulk.id, {
    query: { queryKey: getGetBulkQueryKey(bulk.id), refetchInterval: 5000 },
  })
  const p = detail?.progress
  const done = p ? p.cellsOk + p.cellsFailed + p.cellsCancelled + p.cellsSkippedPendingReview : 0
  return (
    <Card className="border-primary/40">
      <CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 animate-pulse text-primary" />
            <span className="font-medium">{bulk.name}</span>
          </div>
          <Link href="/bulks" className="text-xs text-primary hover:underline">Open in Bulks →</Link>
        </div>
        {p ? (
          <>
            <ProgressBar ok={p.cellsOk} failed={p.cellsFailed} total={p.cellsTotal} />
            <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs tabular-nums text-muted-foreground">
              <span>{done.toLocaleString()} / {p.cellsTotal.toLocaleString()} cells</span>
              <span className="text-success">{p.cellsOk.toLocaleString()} ok</span>
              {p.cellsFailed > 0 && <span className="text-destructive">{p.cellsFailed.toLocaleString()} failed</span>}
              <span>{p.callsRun.toLocaleString()} / {p.callsTotal.toLocaleString()} calls</span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <div className="font-mono text-[10px] uppercase text-muted-foreground">STT est.</div>
                <div className="font-mono">{detail?.estimatedSttCostCents != null ? `$${(detail.estimatedSttCostCents / 100).toFixed(2)}` : "not estimated"}</div>
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase text-muted-foreground">STT so far</div>
                <div className="font-mono">{formatMicrocents(detail?.actualCost.sttCostMicrocents)}</div>
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase text-muted-foreground">Agent est.</div>
                <div className="font-mono">{detail?.estimatedAgentCostCents != null ? `$${(detail.estimatedAgentCostCents / 100).toFixed(2)}` : "not estimated"}</div>
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase text-muted-foreground">Agent so far</div>
                <div className="font-mono">{formatMicrocents(detail?.actualCost.agentCostMicrocents)}</div>
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Loading progress…</p>
        )}
      </CardContent>
    </Card>
  )
}

function ThisMonth({ month }: { month: BenchmarkDashboard["thisMonth"] }) {
  const { data: health, isError: healthError } = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30_000, retry: false },
  })
  const since = new Date(month.monthStart).toLocaleDateString(undefined, { month: "long", year: "numeric" })
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Card>
        <CardContent className="p-4">
          <div className="font-mono text-[10px] uppercase text-muted-foreground">STT spend · {since}</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{formatMicrocents(month.sttMicrocents)}</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {month.sttCellsPriced.toLocaleString()} priced cell{month.sttCellsPriced === 1 ? "" : "s"}
            {month.sttCellsUnpriced > 0 && (
              <span className="text-warning"> · {month.sttCellsUnpriced.toLocaleString()} with no recorded cost, not included</span>
            )}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="font-mono text-[10px] uppercase text-muted-foreground">Agent (OpenAI judge) spend · {since}</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{formatMicrocents(month.agentMicrocents)}</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {month.agentJudgementsPriced.toLocaleString()} priced judgement{month.agentJudgementsPriced === 1 ? "" : "s"}
            {month.agentJudgementsUnpriced > 0 && (
              <span className="text-warning"> · {month.agentJudgementsUnpriced.toLocaleString()} with no recorded cost, not included</span>
            )}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="font-mono text-[10px] uppercase text-muted-foreground">API build · health</div>
          {healthError ? (
            <div className="mt-1 text-sm text-destructive">API not reachable.</div>
          ) : health ? (
            <>
              <div className="mt-1 font-mono text-sm">
                <span className={health.status === "ok" ? "text-success" : "text-destructive"}>{health.status}</span>
                {" · "}
                {health.commitSha}
                {health.commitSha.endsWith("-dirty") && <span className="text-warning"> (built from an uncommitted tree)</span>}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {health.providersConfigured.length} provider{health.providersConfigured.length === 1 ? "" : "s"} with a key: {health.providersConfigured.join(", ") || "none"}
                {health.builtAt && new Date(health.builtAt) > new Date(health.startedAt) && (
                  <span className="text-warning"> · rebuilt after this process started -- restart to run the new code</span>
                )}
              </p>
            </>
          ) : (
            <div className="mt-1 text-sm text-muted-foreground">Checking…</div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default function Dashboard() {
  const { data, isLoading, error, refetch } = useGetBenchmarkDashboard()

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-64 rounded bg-muted" />
        <Card className="h-32 bg-muted/40" />
        <div className="grid gap-2 sm:grid-cols-2">
          {[1, 2, 3, 4].map((i) => <div key={i} className="h-16 rounded-lg bg-muted/40" />)}
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex h-64 flex-col items-center justify-center space-y-4">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <h2 className="text-lg font-semibold">Failed to load the overview</h2>
        <p className="text-muted-foreground">
          The API server might not be running. {error instanceof Error ? error.message : ""}
        </p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>Retry</Button>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
        <p className="mt-1 text-muted-foreground">The latest verdict, what needs a person, what is running, what this month cost.</p>
      </div>

      <section className="space-y-2.5">
        <SectionLabel>Latest verdict</SectionLabel>
        <LatestVerdict bulk={data.latestFinishedBulk} />
      </section>

      <section className="space-y-2.5">
        <SectionLabel>What needs a human</SectionLabel>
        <NeedsHuman data={data.needsHuman} />
      </section>

      {data.runningBulk && (
        <section className="space-y-2.5">
          <SectionLabel>Running now</SectionLabel>
          <RunningNow bulk={data.runningBulk} />
        </section>
      )}

      <section className="space-y-2.5">
        <SectionLabel>This month</SectionLabel>
        <ThisMonth month={data.thisMonth} />
      </section>

      {data.corpusCount === 0 && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Layers className="h-4 w-4" /> No calls imported yet.{" "}
          <Link href="/setup?tab=sources" className="text-primary hover:underline">Import from Vapi →</Link>
        </p>
      )}
    </div>
  )
}
