import React from "react"
import { useGetBenchmarkTrend, getGetBenchmarkTrendQueryKey } from "@workspace/api-client-react"
import { buildTrend, TREND_MIN_CALLS_FOR_DIRECTION, type TrendScope, type TrendSeries } from "@workspace/scoring"
import { CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts"
import { TrendingDown, TrendingUp, Minus, HelpCircle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, type ChartConfig } from "@/components/ui/chart"

/**
 * T-23: where each provider was, bulk by bulk, on one metric -- peer flags
 * per 100 words (T-19, the rankings' own basis; lower is better). One line
 * per provider, x = finished bulks in time order, so a regression between
 * two bulks is a visible kink rather than a number that quietly changed
 * between two visits. The delta list under the chart says it in words:
 * last bulk vs the one before, per provider, with the evidence size.
 *
 * Scope is whatever the caller passes: a client (Vapi account label), one
 * assistant, or everything. Pooling is exact -- the API sends summed
 * totals, never rates (see @workspace/scoring buildTrend).
 */

export function useBenchmarkTrend() {
  return useGetBenchmarkTrend({ query: { queryKey: getGetBenchmarkTrendQueryKey() } })
}

const PALETTE = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"]
function seriesColor(index: number): string {
  const v = PALETTE[index]
  if (v) return `hsl(var(${v}))`
  // More providers than palette slots: spread the rest around the wheel.
  return `hsl(${(index * 67) % 360} 45% 55%)`
}

const fmtRate = (v: number | null) => (v === null ? "—" : v.toFixed(2))
const fmtDelta = (v: number) => (Math.abs(v) < 0.005 ? "±0.00" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`)
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
/** Axis labels must be unique per bulk -- recharts keys categories by
 * label, so two same-day bulks would collapse into one x position (and the
 * "this bulk" marker would land on the wrong one). Add the time whenever a
 * date repeats. */
function axisLabels(bulks: { at: string }[]): string[] {
  const dates = bulks.map((b) => fmtDate(b.at))
  return bulks.map((b, i) => (dates.filter((d) => d === dates[i]).length > 1 ? `${dates[i]} ${fmtTime(b.at)}` : dates[i]!))
}

function DirectionChip({ s }: { s: TrendSeries }) {
  const base = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
  if (s.direction === "worse")
    return <span className={`${base} border-destructive/40 bg-destructive/10 text-destructive`}><TrendingUp className="h-3 w-3" /> worse</span>
  if (s.direction === "better")
    return <span className={`${base} border-success/40 bg-success/10 text-success`}><TrendingDown className="h-3 w-3" /> better</span>
  if (s.direction === "flat")
    return <span className={`${base} border-border bg-muted text-muted-foreground`}><Minus className="h-3 w-3" /> flat</span>
  return (
    <span
      className={`${base} border-border bg-muted text-muted-foreground`}
      title={`Fewer than ${TREND_MIN_CALLS_FOR_DIRECTION} scored calls on one of the two bulks -- the delta is shown but not called a direction.`}
    >
      <HelpCircle className="h-3 w-3" /> too few calls
    </span>
  )
}

type Props = {
  scope: TrendScope
  /** Bulk currently open on the page; drawn as a dashed marker. */
  highlightBulkId?: string | null
  title?: string
  /** Smaller chart, no card chrome -- for inside an assistant card. */
  compact?: boolean
}

export function TrendStrip({ scope, highlightBulkId, title = "Trend across bulks", compact = false }: Props) {
  const { data, isLoading, isError } = useBenchmarkTrend()
  const trend = React.useMemo(() => (data ? buildTrend(data.cells, data.bulks, scope) : null), [data, scope])

  if (isLoading) return null
  const body = (() => {
    if (isError || !data || !trend) return <p className="text-sm text-destructive">Could not load the trend.</p>
    if (trend.bulks.length < 2)
      return (
        <p className="text-sm text-muted-foreground">
          Needs two finished bulks to draw a trend; {trend.bulks.length === 0 ? "none have" : "only one has"} finished so far.
        </p>
      )
    if (trend.series.length === 0)
      return <p className="text-sm text-muted-foreground">No flag-scored calls in this scope on any finished bulk.</p>

    const config: ChartConfig = Object.fromEntries(
      trend.series.map((s, i) => [s.providerId, { label: s.providerName, color: seriesColor(i) }]),
    )
    const labels = axisLabels(trend.bulks)
    const rows = trend.bulks.map((b, bi) => {
      const row: Record<string, string | number | null> = { bulkId: b.id, name: b.name, at: b.at, label: labels[bi]! }
      for (const s of trend.series) {
        const p = s.points[bi]!
        row[s.providerId] = p.peerFlagsPer100Words
        row[`${s.providerId}__calls`] = p.callsScored
        row[`${s.providerId}__clean`] = p.cleanCallRate
      }
      return row
    })

    return (
      <div className="space-y-3">
        <ChartContainer config={config} className={compact ? "aspect-[5/1] max-h-36 w-full" : "aspect-[4/1] max-h-56 w-full"}>
          <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} interval={0} />
            <YAxis
              tickLine={false}
              axisLine={false}
              fontSize={11}
              width={34}
              domain={[0, "auto"]}
            />
            {highlightBulkId && rows.some((r) => r.bulkId === highlightBulkId) && (
              <ReferenceLine
                x={rows.find((r) => r.bulkId === highlightBulkId)?.label as string}
                stroke="hsl(var(--primary))"
                strokeDasharray="4 3"
                label={compact ? undefined : { value: "this bulk", position: "top", fontSize: 10, fill: "hsl(var(--primary))" }}
              />
            )}
            <Tooltip
              cursor={{ stroke: "hsl(var(--border))" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const row = payload[0]!.payload as Record<string, string | number | null>
                return (
                  <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
                    <div className="mb-1 font-medium">{row.name as string}</div>
                    <div className="mb-1.5 text-[10px] text-muted-foreground">{fmtDate(row.at as string)} · flags / 100 words · scored calls</div>
                    {trend.series.map((s, i) => {
                      const v = row[s.providerId] as number | null
                      const calls = row[`${s.providerId}__calls`] as number
                      return (
                        <div key={s.providerId} className="flex items-center gap-2 font-mono tabular-nums">
                          <span className="inline-block h-2 w-2 rounded-full" style={{ background: seriesColor(i) }} />
                          <span className="w-36 truncate font-sans">{s.providerName}</span>
                          <span className="w-10 text-right">{fmtRate(v)}</span>
                          <span className="w-14 text-right text-muted-foreground">{calls === 0 ? "not run" : `${calls} calls`}</span>
                        </div>
                      )
                    })}
                  </div>
                )
              }}
            />
            {trend.series.map((s, i) => (
              <Line
                key={s.providerId}
                type="monotone"
                dataKey={s.providerId}
                name={s.providerName}
                stroke={seriesColor(i)}
                strokeWidth={2}
                dot={{ r: 3, strokeWidth: 0, fill: seriesColor(i) }}
                activeDot={{ r: 5 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ChartContainer>

        {/* Last bulk vs the one before, in words. This is the regression
            check: the chart shows it, this line says it. */}
        <ul className={`grid gap-x-6 gap-y-1 text-xs ${compact ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3"}`} data-testid="trend-deltas">
          {trend.series.map((s, i) => (
            <li key={s.providerId} className="flex flex-wrap items-center gap-2">
              <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: seriesColor(i) }} />
              <span className="font-medium">{s.providerName}</span>
              {s.deltaPer100Words === null || !s.latest || !s.previous ? (
                <span className="text-muted-foreground">
                  {s.latest ? `${fmtRate(s.latest.peerFlagsPer100Words)} on one bulk only (${s.latest.callsScored} calls)` : "no evidence"}
                </span>
              ) : (
                <>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {fmtRate(s.previous.peerFlagsPer100Words)} → {fmtRate(s.latest.peerFlagsPer100Words)}
                  </span>
                  <span className={`font-mono tabular-nums ${s.direction === "worse" ? "text-destructive" : s.direction === "better" ? "text-success" : ""}`}>
                    {fmtDelta(s.deltaPer100Words)}
                  </span>
                  <DirectionChip s={s} />
                  <span className="text-muted-foreground">{s.previous.callsScored}→{s.latest.callsScored} calls</span>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    )
  })()

  if (compact) {
    return (
      <div className="border-b bg-muted/5 px-4 py-3" data-testid="trend-strip-compact">
        <div className="mb-2 text-[10px] font-mono uppercase tracking-wide text-muted-foreground">{title}</div>
        {body}
      </div>
    )
  }
  return (
    <Card data-testid="trend-strip">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">
          Peer flags per 100 words, per provider, on every finished bulk, oldest to newest. Lower is better. A line
          that rises between two bulks is a regression; the list below says by how much and on how many calls.
        </p>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  )
}

/**
 * The client picker above the page-level strip. Clients are the Vapi
 * account labels seen on scored calls; a null label (calls imported before
 * per-account labelling, never backfilled) is its own visible bucket, not
 * folded into a named client. Defaults to the client of the bulk on screen.
 */
export function ClientTrendSection({ highlightBulkId }: { highlightBulkId: string | null }) {
  const { data } = useBenchmarkTrend()
  const clients = React.useMemo(() => {
    const seen = new Map<string | null, number>()
    for (const c of data?.cells ?? []) seen.set(c.accountLabel, (seen.get(c.accountLabel) ?? 0) + c.callsScored)
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label)
  }, [data])
  const [picked, setPicked] = React.useState<string | null | undefined>(undefined)

  // "undefined" = every client. Default to whichever client the open bulk
  // scored most calls for, so the strip answers the question the page is
  // already on; fall back to every client when the bulk isn't finished yet.
  const defaultClient = React.useMemo<string | null | undefined>(() => {
    if (!data || !highlightBulkId) return undefined
    const tally = new Map<string | null, number>()
    for (const c of data.cells) if (c.bulkId === highlightBulkId) tally.set(c.accountLabel, (tally.get(c.accountLabel) ?? 0) + c.callsScored)
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]
    return top ? top[0] : undefined
  }, [data, highlightBulkId])
  const active = picked === undefined ? defaultClient : picked
  const scope = React.useMemo<TrendScope>(() => (active === undefined ? {} : { accountLabel: active }), [active])

  if (!data || data.bulks.length === 0) return null
  const chip = (label: string | null | undefined, text: string) => {
    const isOn = label === active
    return (
      <button
        key={label === undefined ? "__all__" : label === null ? "__null__" : label}
        type="button"
        onClick={() => setPicked(label)}
        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${isOn ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
        aria-pressed={isOn}
      >
        {text}
      </button>
    )
  }
  return (
    <div className="space-y-2" data-testid="client-trend">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground">Client</span>
        <div className="flex flex-wrap rounded-lg border border-border p-0.5">
          {chip(undefined, "All clients")}
          {clients.map((c) => chip(c, c ?? "Unlabelled account"))}
        </div>
      </div>
      <TrendStrip
        scope={scope}
        highlightBulkId={highlightBulkId}
        title={active === undefined ? "Trend across bulks — all clients" : `Trend across bulks — ${active ?? "unlabelled account"}`}
      />
    </div>
  )
}
