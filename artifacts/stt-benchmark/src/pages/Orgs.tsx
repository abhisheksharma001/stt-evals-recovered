import * as React from "react"
import {
  useGetBulkTurnSignals,
  useGetBulkVerdicts,
  useGetWatchOverview,
  type LatencyPool,
  type TurnSignalsSummary,
  type WatchBaseline,
  type WatchOverviewAgent,
  type WatchOverviewDay,
} from "@workspace/api-client-react"
import { AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { cn, formatCents } from "@/lib/utils"

// ---------------------------------------------------------------------------
// W-6c: Layer 1 of the daily watch (PRD v8 Part C). One row per account,
// one row per agent under it, and for each agent a 30-day bar of ticks read
// straight off the watch ledger through GET /benchmark/watch/overview.
//
// Nothing on this page is computed here (D-13): the per-day rate, the
// baseline band and its verdict, and the month's estimate all arrive in the
// response. The browser only decides which colour a tick is, and that rule
// is a lookup on fields the server already filled in:
//   grey  -- no ledger row for the day (no run)
//   red   -- the ledger says `refused:<why>` or `failed`
//   amber -- today, and the server's baseline verdict is `moved`
//   green -- everything else that ran
// `too_close` is a Layer 2 verdict (bulkVerdicts) and is not on the ledger,
// so it never colours a Layer 1 tick -- corrected in the register, W-6c grill.
//
// Pattern: status-page tick bars (Better Stack, incident.io, AWS Health on
// Mobbin) -- one row per thing watched, one tick per day, the reason on
// hover. The hover copies OpenAI Platform's status hover: date, then the
// outcome, then the count with its denominator where one exists.
// ---------------------------------------------------------------------------

export type TickTone = "none" | "ran" | "moved" | "bad"

/** Which colour a day's tick gets. Pure, so the test can hold the rule. */
export function tickTone(day: WatchOverviewDay | undefined, isToday: boolean, baseline: WatchBaseline["state"]): TickTone {
  if (!day) return "none"
  if (day.outcome.startsWith("refused:") || day.outcome === "failed") return "bad"
  if (isToday && baseline === "moved") return "moved"
  return "ran"
}

/** Every calendar day from `from` to `to` inclusive, as YYYY-MM-DD, UTC arithmetic. */
export function calendarDays(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return []
  const out: string[] = []
  for (let t = start; t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

function hoverText(day: string, entry: WatchOverviewDay | undefined): string {
  if (!entry) return `${day} · no run`
  const parts = [day, entry.outcome]
  if (typeof entry.rate === "number") parts.push(`${entry.rate.toFixed(1)} per 100 words`)
  if (typeof entry.calls === "number") parts.push(`${entry.calls} calls`)
  return parts.join(" · ")
}

const TONE_CLASS: Record<TickTone, string> = {
  none: "bg-muted-foreground/25",
  ran: "bg-emerald-500",
  moved: "bg-amber-400",
  bad: "bg-destructive",
}

// ---------------------------------------------------------------------------
// W-7: Layer 2, one agent on one day. A tick whose ledger row carries a
// bulkId opens a drawer: the verdict sentence for that bulk scoped to the
// agent, then the five-layer strip (STT · turn-taking · LLM · voice ·
// outcome). Every number arrives pooled from the server with its
// denominators; the lines below only choose words. A call Vapi did not time
// is a denominator, never a 0 -- the acceptance line of the step.
// Pattern: fal's request drawer on Mobbin (a phase strip with durations over
// a key/value list) and Plain's "N/A · No data" for an unmeasured metric.
// ---------------------------------------------------------------------------

/** The two lines of a latency cell. Pure, so the test can hold the rule. */
export function latencyLines(pool: LatencyPool, totalCalls: number, unit: string): { value: string; denominator: string } {
  if (pool.measuredCalls === 0 || pool.medianMs === null) {
    return { value: "not timed", denominator: `not timed on any of ${totalCalls} calls` }
  }
  const untimed = totalCalls - pool.measuredCalls
  return {
    value: `${Math.round(pool.medianMs)} ms median over ${pool.turns} ${unit}`,
    denominator: `timed on ${pool.measuredCalls} of ${totalCalls} calls${untimed > 0 ? `; ${untimed} not timed by Vapi` : ""}`,
  }
}

/** One outcome value with how many calls carried it, and how many are unknown. */
export function outcomeLine(values: { value: string; calls: number }[], knownCalls: number, totalCalls: number, what: string): string {
  if (knownCalls === 0) return `${what} not on file`
  const top = values[0]
  const unknown = totalCalls - knownCalls
  return `${top.value} on ${top.calls} of ${knownCalls}${unknown > 0 ? ` · ${unknown} unknown` : ""}`
}

type StripCell = { layer: string; lines: string[] }

export function stripCells(summary: TurnSignalsSummary, day: WatchOverviewDay): StripCell[] {
  const n = summary.totalCalls
  const stt = typeof day.rate === "number" ? `${day.rate.toFixed(1)} per 100 words${typeof day.calls === "number" ? ` · ${day.calls} calls` : ""}` : "production not measured"
  const transcriber = latencyLines(summary.stt.transcriberLatency, n, "turns")
  const endpointing = latencyLines(summary.turnTaking.endpointingLatency, n, "turns")
  const model = latencyLines(summary.llm.modelLatency, n, "turns")
  const voice = latencyLines(summary.voice.voiceLatency, n, "turns")
  const asked = summary.turnTaking.interruptionsMeasuredCalls
  const interruptions =
    asked === 0
      ? `interruptions not reported on any of ${n} calls`
      : `interrupted on ${summary.turnTaking.interruptedCalls} of ${asked} calls${n - asked > 0 ? ` · ${n - asked} not asked` : ""}`
  return [
    { layer: "STT", lines: [stt, `transcriber ${transcriber.value}`, transcriber.denominator] },
    { layer: "Turn-taking", lines: [`endpointing ${endpointing.value}`, endpointing.denominator, interruptions] },
    { layer: "LLM", lines: [`model ${model.value}`, model.denominator] },
    { layer: "Voice", lines: [`TTS ${voice.value}`, voice.denominator] },
    {
      layer: "Outcome",
      lines: [
        outcomeLine(summary.outcome.endedReasons, summary.outcome.endedReasonKnownCalls, n, "ended reason"),
        outcomeLine(summary.outcome.successEvaluations, summary.outcome.successEvaluationKnownCalls, n, "success evaluation"),
      ],
    },
  ]
}

function DayDrawer({ agent, day, bulkId, onClose }: { agent: WatchOverviewAgent; day: WatchOverviewDay; bulkId: string; onClose: () => void }) {
  const params = agent.assistantId ? { assistantId: agent.assistantId } : undefined
  const verdicts = useGetBulkVerdicts(bulkId, params)
  const signals = useGetBulkTurnSignals(bulkId, params)
  const sentence = verdicts.isLoading
    ? "loading the verdict…"
    : verdicts.error
      ? "the verdict could not be loaded"
      : (verdicts.data?.groups[0]?.verdict.sentence ?? "no verdict for this day")
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md" data-testid="day-drawer">
        <SheetHeader>
          <SheetTitle className="font-mono text-base">{agent.assistantId ?? "all agents"} · {day.day}</SheetTitle>
          <SheetDescription>{day.outcome}</SheetDescription>
        </SheetHeader>
        <p className="mt-4 text-sm" data-testid="day-verdict">{sentence}</p>
        <div className="mt-6 space-y-4">
          {signals.isLoading && <p className="text-sm text-muted-foreground" aria-busy="true">loading what else happened…</p>}
          {signals.error && <p className="text-sm text-destructive">what else happened could not be loaded</p>}
          {signals.data &&
            stripCells(signals.data.summary, day).map((cell) => (
              <div key={cell.layer} data-testid="strip-cell" className="border-t border-border pt-3">
                <p className="font-mono text-[10px] uppercase tracking-[0.09em] text-muted-foreground">{cell.layer}</p>
                {cell.lines.map((line, i) => (
                  <p key={i} className={cn("text-sm", i > 0 && "text-muted-foreground")}>{line}</p>
                ))}
              </div>
            ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function TickBar({ agent, days, today, onOpen }: { agent: WatchOverviewAgent; days: string[]; today: string; onOpen: (day: WatchOverviewDay) => void }) {
  const byDay = new Map(agent.days.map((d) => [d.day, d]))
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-end gap-[3px]" role="img" aria-label={`${days.length} days of watch runs`}>
        {days.map((day) => {
          const entry = byDay.get(day)
          const tone = tickTone(entry, day === today, agent.baseline.state)
          const className = cn("h-5 w-[7px] rounded-[2px]", TONE_CLASS[tone])
          const title = hoverText(day, entry)
          // Only a day with a bulk behind it has a Layer 2 to open.
          return entry?.bulkId ? (
            <button
              key={day}
              type="button"
              data-day={day}
              data-tone={tone}
              title={title}
              aria-label={title}
              onClick={() => onOpen(entry)}
              className={cn(className, "hover:ring-2 hover:ring-ring")}
            />
          ) : (
            <span key={day} data-day={day} data-tone={tone} title={title} className={className} />
          )
        })}
      </div>
      <div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.09em] text-muted-foreground">
        <span>{days.length} days ago</span>
        <span>today</span>
      </div>
    </div>
  )
}

function todayLine(agent: WatchOverviewAgent, today: string): string {
  const entry = agent.days.find((d) => d.day === today)
  if (!entry) return "no run today"
  if (typeof entry.rate !== "number") return `no measurement today (${entry.outcome})`
  const calls = typeof entry.calls === "number" ? ` · ${entry.calls} calls` : ""
  return `${entry.rate.toFixed(1)} per 100 words today${calls}`
}

function baselineLine(b: WatchBaseline): { text: string; moved: boolean } {
  if (b.state === "forming") return { text: `baseline forming · ${b.priorDays} of 7 days`, moved: false }
  const band = b.low != null && b.high != null ? ` ${b.low.toFixed(1)}–${b.high.toFixed(1)}` : ""
  if (b.state === "moved") return { text: `moved against baseline${band}`, moved: true }
  return { text: `within baseline${band}`, moved: false }
}

function AgentRow({ agent, days, today }: { agent: WatchOverviewAgent; days: string[]; today: string }) {
  const [open, setOpen] = React.useState<WatchOverviewDay | null>(null)
  const baseline = baselineLine(agent.baseline)
  const production = agent.production
    ? `runs ${agent.production.vendor}${agent.production.model ? ` ${agent.production.model}` : ""}`
    : "production transcriber not on file"
  return (
    <div
      data-testid="agent-row"
      data-baseline={agent.baseline.state}
      className={cn("grid grid-cols-[minmax(160px,1fr)_auto_minmax(200px,1fr)] items-center gap-6 py-4", !agent.enabled && "opacity-50")}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm">{agent.assistantId ?? "no agent named"}</span>
          {!agent.enabled && (
            <span className="rounded-full border border-border px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.09em] text-muted-foreground">
              paused
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{production}</p>
      </div>
      <TickBar agent={agent} days={days} today={today} onOpen={setOpen} />
      {open?.bulkId && <DayDrawer agent={agent} day={open} bulkId={open.bulkId} onClose={() => setOpen(null)} />}
      <div className="space-y-1 text-sm">
        <p>{todayLine(agent, today)}</p>
        <p className={cn(baseline.moved ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>{baseline.text}</p>
        <p className="text-muted-foreground">
          {formatCents(agent.monthEstimatedCents)} this month, estimated
        </p>
      </div>
    </div>
  )
}

export default function Orgs() {
  const { data, isLoading, error, refetch } = useGetWatchOverview()

  if (isLoading) {
    return (
      <div className="max-w-[960px] animate-pulse space-y-8" aria-busy="true" aria-label="Loading page">
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
        <h2 className="text-lg font-semibold">Failed to load the watch ledger</h2>
        <p className="text-muted-foreground">The API server might not be running. {error instanceof Error ? error.message : ""}</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>Retry</Button>
      </div>
    )
  }

  const days = calendarDays(data.windowStart, data.today)

  return (
    <div className="max-w-[960px]">
      <h1 className="mb-2 text-3xl font-bold tracking-tight">Orgs</h1>
      <p className="mb-8 max-w-[64ch] text-sm text-muted-foreground">
        Every agent under daily watch, one tick per day. Green ran, amber moved against its own baseline, red refused or
        failed (hover for why), grey no run. Rates are the production transcriber's disagreement per 100 words on that
        day's calls.
      </p>

      {data.accounts.length === 0 ? (
        <p className="border-t border-border pt-7 text-sm text-muted-foreground">No agent is under watch yet.</p>
      ) : (
        data.accounts.map((account) => (
          <section key={account.accountId} className="border-t border-border py-6 first:border-t-0 first:pt-0">
            <h2 className="mb-2 text-lg font-semibold">
              {account.accountLabel ?? <span className="font-mono text-base">{account.accountId}</span>}
            </h2>
            <div className="divide-y divide-border">
              {account.agents.map((agent) => (
                <AgentRow key={agent.scheduleId} agent={agent} days={days} today={data.today} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
