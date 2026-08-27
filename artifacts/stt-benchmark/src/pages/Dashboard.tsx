import * as React from "react"
import { Link, useLocation } from "wouter"
import {
  useGetBenchmarkDashboard,
  useListBenchmarkCalls,
  useListBenchmarkProviders,
} from "@workspace/api-client-react"
import { Activity, AlertCircle, ArrowRight, Check, CloudDownload, GitMerge, AudioLines, ShieldCheck } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

const VERTICAL_LABEL: Record<string, string> = {
  rush: "Rush",
  trucking: "Trucking",
  property_management: "Property management",
}

function StageCard({
  step,
  label,
  tone,
  value,
  detail,
  current,
}: {
  step: number
  label: string
  tone: "done" | "current" | "blocked" | "pending"
  value: React.ReactNode
  detail: string
  current?: boolean
}) {
  const toneClasses = {
    done: "border-success/25 bg-success/5",
    current: "border-primary bg-primary/5 shadow-[0_0_0_1px_theme(colors.primary/15%)]",
    blocked: "border-destructive/25 bg-destructive/5",
    pending: "border-dashed border-border bg-transparent",
  }[tone]

  return (
    <div className={`flex flex-1 flex-col gap-2 rounded-xl border p-4 ${toneClasses}`}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.09em] text-muted-foreground">
          {String(step).padStart(2, "0")} · {label}
        </span>
        {current && (
          <span className="rounded-full bg-primary px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-primary-foreground">
            Here
          </span>
        )}
      </div>
      <div className="font-mono text-2xl font-semibold leading-none">{value}</div>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}

export default function Dashboard() {
  const [, setLocation] = useLocation()
  const { data, isLoading, error, refetch } = useGetBenchmarkDashboard()
  const { data: calls } = useListBenchmarkCalls()
  const { data: providers } = useListBenchmarkProviders()

  const byVertical = React.useMemo(() => {
    if (!calls) return []
    const groups = new Map<string, { total: number; done: number }>()
    for (const call of calls) {
      const g = groups.get(call.vertical) ?? { total: 0, done: 0 }
      g.total += 1
      // B-49: "done" must match the server's definition (status ===
      // ready_to_run). The old label+attestations check counted a call done
      // while its status was still gold_in_review — the bar read 100% green
      // while the next-action line demanded de-id sign-off for the same call.
      if (call.status === "ready_to_run") g.done += 1
      groups.set(call.vertical, g)
    }
    return Array.from(groups.entries()).map(([vertical, g]) => ({ vertical, ...g }))
  }, [calls])

  const readyProviders = providers?.filter((p) => p.status === "ready") ?? []
  const notReadyProviders = providers?.filter((p) => p.status !== "ready") ?? []

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-64 rounded bg-muted" />
        <div className="flex gap-2">
          {[1, 2, 3, 4, 5].map((i) => <Card key={i} className="h-28 flex-1 bg-muted/40" />)}
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex h-64 flex-col items-center justify-center space-y-4">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <h2 className="text-lg font-semibold">Failed to load dashboard data</h2>
        <p className="text-muted-foreground">
          The API server might not be running. {error instanceof Error ? error.message : ""}
        </p>
        {/* UX review 2026-08-25: this was a dead end -- the only recovery was
            a manual page reload. */}
        <Button variant="outline" size="sm" onClick={() => void refetch()}>Retry</Button>
      </div>
    )
  }

  const needsReview = data.corpusCount - data.goldReadyCount
  const needsDeid = data.goldReadyCount - data.readyToRunCount
  const runReady = data.readyToRunCount > 0 && data.configuredProviderCount >= 1

  // The single "what do I do next" line the old four-stat-card layout never
  // gave a straight answer to.
  const nextAction =
    // UX review 2026-08-25: an in-flight run means paid provider calls are
    // being made right now -- pointing the operator at "Queue a run" invited
    // a duplicate launch. Monitor instead.
    data.latestRunStatus === "queued" || data.latestRunStatus === "running"
      ? { text: "A benchmark run is in flight right now.", href: "/runs", label: "Monitor run", icon: Activity }
      : data.corpusCount === 0
      ? { text: "Import calls from Vapi to start building the corpus.", href: "/sources", label: "Import calls", icon: CloudDownload }
      : needsReview > 0
        ? { text: `${needsReview} call${needsReview === 1 ? "" : "s"} still need${needsReview === 1 ? "s" : ""} a gold transcript.`, href: "/review", label: "Continue review", icon: AudioLines }
        : needsDeid > 0
          ? { text: `${needsDeid} call${needsDeid === 1 ? "" : "s"} have a gold transcript but are missing de-identification sign-off.`, href: "/corpus", label: "Attest de-ID", icon: ShieldCheck }
          : data.configuredProviderCount === 0
            ? { text: "No provider has an API key configured yet.", href: "/providers", label: "Configure providers", icon: Check }
            // technical-fixes FIX-6 / ux-fixes UX-4: Runs no longer launches
            // anything itself -- launching lives in Bulks now, one surface.
            : { text: `${data.readyToRunCount} calls are ready. Launch a run against ${data.configuredProviderCount} configured provider${data.configuredProviderCount === 1 ? "" : "s"}.`, href: "/bulks", label: "Launch a run", icon: GitMerge }

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
        <p className="mt-1 text-muted-foreground">Where the corpus stands and what unblocks the next step.</p>
      </div>

      {/* pipeline strip -- mirrors the five stages the whole app is built around */}
      <div className="flex gap-2">
        <StageCard
          step={1}
          label="Import"
          tone={data.corpusCount > 0 ? "done" : "current"}
          value={data.corpusCount}
          detail="calls pulled from Vapi"
        />
        <StageCard
          step={2}
          label="Review"
          tone={needsReview === 0 && data.corpusCount > 0 ? "done" : "current"}
          current={needsReview > 0}
          value={`${data.goldReadyCount} / ${data.corpusCount || 0}`}
          detail="have a gold transcript"
        />
        <StageCard
          step={3}
          label="De-ID"
          tone={needsDeid === 0 && data.goldReadyCount > 0 ? "done" : needsReview === 0 && needsDeid > 0 ? "current" : "pending"}
          value={`${data.readyToRunCount} / ${data.goldReadyCount || 0}`}
          detail="two approvers signed off"
        />
        <StageCard
          step={4}
          label="Run"
          tone={data.latestRunStatus === "complete" ? "done" : data.latestRunStatus === "failed" ? "blocked" : runReady ? "current" : "pending"}
          value={data.latestRunStatus === "blocked" ? "—" : data.latestRunStatus.replace("_", " ")}
          detail="latest run status"
        />
        <StageCard
          step={5}
          label="Decide"
          tone={data.latestRunStatus === "complete" ? "current" : "pending"}
          value={data.latestRunStatus === "complete" ? "Ready" : "—"}
          detail="keep, switch, or split by assistant"
        />
      </div>

      {/* single next action */}
      <div className="flex items-center justify-between gap-6 rounded-xl border border-border bg-card p-5">
        <div className="flex items-start gap-3.5">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <nextAction.icon className="h-4 w-4 text-primary" />
          </div>
          <div>
            <p className="text-base font-semibold leading-snug">{nextAction.text}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{data.decisionStatus}</p>
          </div>
        </div>
        <Button onClick={() => setLocation(nextAction.href)} className="shrink-0">
          {nextAction.label} <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.3fr_1fr]">
        <Card>
          <CardContent className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Corpus by vertical</h3>
              <Link href="/corpus" className="text-xs text-primary hover:underline">
                Open corpus →
              </Link>
            </div>
            <div className="flex flex-col gap-4">
              {byVertical.length === 0 ? (
                <p className="text-sm text-muted-foreground">No calls imported yet.</p>
              ) : (
                byVertical.map(({ vertical, total, done }) => (
                  <div key={vertical} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm">{VERTICAL_LABEL[vertical] ?? vertical}</span>
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">{done} / {total}</span>
                    </div>
                    <div className="flex h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div className="bg-primary" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
                    </div>
                  </div>
                ))
              )}
              {data.corpusCount > 0 && data.corpusCount < 50 && (
                <div className="mt-1 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                  The ticket calls for 50–100 calls. {data.corpusCount} is a pilot corpus — enough to prove the
                  pipeline, thin for a per-vertical verdict.
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Providers</h3>
              <Link href="/providers" className="text-xs text-primary hover:underline">
                Configure →
              </Link>
            </div>
            <div className="flex flex-col gap-0.5">
              {readyProviders.map((p) => (
                <div key={p.id} className="flex items-center gap-2.5 rounded-lg bg-secondary/60 px-2.5 py-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                  <div className="flex-1">
                    <div className="text-xs font-medium">{p.name}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{p.model}</div>
                  </div>
                  <span className="font-mono text-[11px] text-muted-foreground">${p.costPerMinute.toFixed(4)}</span>
                </div>
              ))}
              {notReadyProviders.length > 0 && (
                <div className="flex items-center gap-2.5 px-2.5 py-2 opacity-70">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-border" />
                  <span className="flex-1 truncate text-xs text-muted-foreground">
                    {/* B-57: per-provider label — "Disabled / no key" as one
                        group label painted a keyed-but-disabled provider as
                        keyless. */}
                    {notReadyProviders.map((p) => `${p.name} (${p.status === "disabled" ? "disabled" : "no key"})`).join(", ")}
                  </span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
