import React from "react"
import {
  useGetBulkVerdicts,
  getGetBulkVerdictsQueryKey,
  type BulkVerdicts,
  type HeadlineVerdict,
} from "@workspace/api-client-react"
import { Trophy, Scale, Hourglass, CircleOff } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"

/**
 * T-21: the verdict, in one sentence, where a non-technical reader sees it
 * before any table. Two pieces, both fed by GET /benchmark/bulks/{id}/verdicts
 * (T-20), which is the only place a "winner" may come from -- this file
 * never re-derives one from ranking rows.
 *
 * - <BulkVerdictBanner> sits at the top of the Results page and rolls the
 *   per-group decisions up: how many groups have a named winner, how many
 *   are too close, how many have too few calls. When nothing in the bulk
 *   has a winner it says so plainly instead of hiding it (T-55 is the
 *   reason that happens at today's volume; the banner names it).
 * - <GroupVerdictHeadline> sits inside each assistant card above its table
 *   and shows that group's sentence with a decision chip.
 *
 * Null/absent verdicts never render as "winner" or as an empty string --
 * every branch below is explicit.
 */

const DECISION_META: Record<
  HeadlineVerdict["decision"],
  { label: string; Icon: React.ComponentType<{ className?: string }>; chip: string; border: string }
> = {
  winner: {
    label: "Winner",
    Icon: Trophy,
    chip: "bg-success/15 text-success border-success/30",
    border: "border-l-success",
  },
  too_close: {
    label: "Too close to call",
    Icon: Scale,
    chip: "bg-warning/15 text-warning border-warning/30",
    border: "border-l-warning",
  },
  too_few_calls: {
    label: "Not enough calls",
    Icon: Hourglass,
    chip: "bg-muted text-muted-foreground border-border",
    border: "border-l-muted-foreground/40",
  },
  insufficient: {
    label: "Only one provider",
    Icon: CircleOff,
    chip: "bg-muted text-muted-foreground border-border",
    border: "border-l-muted-foreground/40",
  },
}

export function DecisionChip({ decision }: { decision: HeadlineVerdict["decision"] }) {
  const meta = DECISION_META[decision]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${meta.chip}`}
      data-decision={decision}
    >
      <meta.Icon className="h-3 w-3" />
      {meta.label}
    </span>
  )
}

/** T-55: verdict groups are per client; a Rankings card (per assistant)
 *  finds the client group its assistant's calls fed. */
export function findGroupVerdict(data: BulkVerdicts | undefined, assistantId: string | null) {
  if (!data) return undefined
  return data.groups.find((g) => g.assistantIds.includes(assistantId))
}

export function clientGroupLabel(g: { clientLabel: string | null }): string {
  return g.clientLabel ?? "No account label on file"
}

export function useBulkVerdicts(bulkId: string | null | undefined) {
  return useGetBulkVerdicts(bulkId ?? "", {
    query: { queryKey: getGetBulkVerdictsQueryKey(bulkId ?? ""), enabled: !!bulkId },
  })
}

function nameOf(data: BulkVerdicts, id: string | null): string {
  if (!id) return "?"
  return data.providers.find((p) => p.id === id)?.name ?? id
}

/**
 * T-84: the banner's rolled-up reading of a bulk, as data, so the Overview
 * can say the same sentence flat on the page without a card. Still the
 * only source is GET /bulks/{id}/verdicts -- nothing here re-derives a
 * winner.
 */
export function summarizeBulkVerdicts(data: BulkVerdicts): {
  tone: HeadlineVerdict["decision"]
  leadName: string | null
  sentence: string
  counts: { winner: number; too_close: number; too_few_calls: number; insufficient: number }
  totalCalls: number
  groups: number
} {
  const groups = data.groups
  const counts = { winner: 0, too_close: 0, too_few_calls: 0, insufficient: 0 }
  for (const g of groups) counts[g.verdict.decision] += 1
  const winners = groups.filter((g) => g.verdict.decision === "winner")
  const totalCalls = groups.reduce((s, g) => s + g.verdict.evidenceCalls, 0)
  if (groups.length === 0) {
    return { tone: "insufficient", leadName: null, sentence: "No verdict yet: this bulk has no scored calls.", counts, totalCalls, groups: 0 }
  }
  if (winners.length > 0) {
    const tally = new Map<string, number>()
    for (const g of winners) tally.set(g.verdict.winnerProviderId ?? "?", (tally.get(g.verdict.winnerProviderId ?? "?") ?? 0) + 1)
    const [topId, topN] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]
    const rest = groups.length - winners.length
    return {
      tone: "winner",
      leadName: nameOf(data, topId),
      sentence: `wins ${topN} of ${groups.length} group${groups.length === 1 ? "" : "s"} outright${rest > 0 ? `; ${rest} ha${rest === 1 ? "s" : "ve"} no clear winner yet` : ""}.`,
      counts, totalCalls, groups: groups.length,
    }
  }
  if (counts.too_close > 0 && counts.too_close >= counts.too_few_calls) {
    return { tone: "too_close", leadName: null, sentence: "No clear winner: the top providers are too close to call on the calls so far.", counts, totalCalls, groups: groups.length }
  }
  return { tone: "too_few_calls", leadName: null, sentence: `No clear winner yet: ${counts.too_few_calls} of ${groups.length} group${groups.length === 1 ? "" : "s"} need more calls before one can be named.`, counts, totalCalls, groups: groups.length }
}

export function BulkVerdictBanner({ bulkId, groupLabels }: { bulkId: string; groupLabels: Record<string, string> }) {
  const { data, isLoading, isError } = useBulkVerdicts(bulkId)

  if (isLoading) return <Card className="h-24 animate-pulse bg-muted/20" />
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-destructive">Could not load the verdict for this bulk.</CardContent>
      </Card>
    )
  }

  const groups = data.groups
  const counts = { winner: 0, too_close: 0, too_few_calls: 0, insufficient: 0 }
  for (const g of groups) counts[g.verdict.decision] += 1
  const winners = groups.filter((g) => g.verdict.decision === "winner")
  const totalCalls = groups.reduce((s, g) => s + g.verdict.evidenceCalls, 0)

  // Headline: the single sentence a CEO reads and stops scrolling.
  let headline: React.ReactNode
  let tone: HeadlineVerdict["decision"]
  if (groups.length === 0) {
    tone = "insufficient"
    headline = <>No verdict yet: this bulk has no scored calls.</>
  } else if (winners.length > 0) {
    tone = "winner"
    // Tally which provider wins how many groups so one name can lead.
    const tally = new Map<string, number>()
    for (const g of winners) tally.set(g.verdict.winnerProviderId ?? "?", (tally.get(g.verdict.winnerProviderId ?? "?") ?? 0) + 1)
    const [topId, topN] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]
    headline = (
      <>
        <span className="font-semibold">{nameOf(data, topId)}</span> wins {topN} of {groups.length} assistant group
        {groups.length === 1 ? "" : "s"} outright
        {winners.length > topN ? <> ({winners.length - topN} other group{winners.length - topN === 1 ? "" : "s"} have a different winner)</> : null}.
        {counts.too_close + counts.too_few_calls + counts.insufficient > 0 && (
          <> The remaining {groups.length - winners.length} have no winner yet.</>
        )}
      </>
    )
  } else if (counts.too_close > 0 && counts.too_close >= counts.too_few_calls) {
    tone = "too_close"
    headline = <>No winner in this bulk: the top providers are inside the margin of error in every group with enough calls.</>
  } else {
    tone = "too_few_calls"
    headline = (
      <>
        No winner in this bulk yet: {counts.too_few_calls} of {groups.length} client group
        {groups.length === 1 ? "" : "s"} have fewer than 5 calls that both top providers ran, the minimum for a verdict.
      </>
    )
  }

  const meta = DECISION_META[tone]

  return (
    <Card className={`border-l-4 ${meta.border}`} data-testid="bulk-verdict-banner">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground">Verdict</span>
          <DecisionChip decision={tone} />
        </div>
        <p className="text-lg leading-snug text-foreground" style={{ textWrap: "balance" }}>{headline}</p>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground font-mono">
          <span>{groups.length} group{groups.length === 1 ? "" : "s"} · {totalCalls} call{totalCalls === 1 ? "" : "s"} scored</span>
          <span title="Gap to the runner-up is bigger than the margin of error (95% bootstrap interval excludes zero)">{counts.winner} winner{counts.winner === 1 ? "" : "s"}</span>
          <span title="Gap to the runner-up is inside the margin of error">{counts.too_close} too close</span>
          <span title="Fewer than 5 calls that both top providers ran">{counts.too_few_calls} not enough calls</span>
          {counts.insufficient > 0 && <span title="Fewer than two providers scored">{counts.insufficient} only one provider</span>}
        </div>
        {winners.length > 0 && (
          <ul className="space-y-1 text-sm">
            {winners.map((g) => (
              <li key={g.clientLabel ?? "__none__"} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{groupLabels[g.clientLabel ?? "__none__"] ?? clientGroupLabel(g)}</span>
                <span className="text-muted-foreground">{g.verdict.sentence}</span>
              </li>
            ))}
          </ul>
        )}
        <p
          className="text-xs text-muted-foreground"
          title="Mechanism: disagreements = cross-provider word disagreements + entity mismatches, a provider's own low-confidence spans excluded. Margin of error = 95% bootstrap interval over 1,000 reshuffles of the calls both providers scored."
        >
          Winner = fewest disagreements per 100 words, by more than the margin of error. Lower is better. Anything else is undecided, not a tie.
        </p>
      </CardContent>
    </Card>
  )
}

export function GroupVerdictHeadline({
  verdict,
  scope,
}: {
  verdict: HeadlineVerdict | undefined
  /** T-55: the client group this verdict was computed over, so a
   *  per-assistant card never implies the verdict is about that assistant
   *  alone. */
  scope?: { clientLabel: string | null; assistantCount: number; callCount: number }
}) {
  if (!verdict) {
    return (
      <div className="border-b bg-muted/20 px-4 py-3 text-sm text-muted-foreground" data-testid="group-verdict-headline">
        No verdict for this group in this bulk.
      </div>
    )
  }
  const meta = DECISION_META[verdict.decision]
  return (
    <div className={`flex items-start gap-3 border-b border-l-4 ${meta.border} bg-muted/20 px-4 py-3`} data-testid="group-verdict-headline">
      <div className="flex flex-col gap-1.5 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <DecisionChip decision={verdict.decision} />
          <span className="text-[11px] font-mono text-muted-foreground">
            {verdict.evidenceCalls} call{verdict.evidenceCalls === 1 ? "" : "s"} scored
            {verdict.provisional ? " · early read (under 20)" : ""}
            {verdict.noiseFloor ? ` · ${verdict.noiseFloor.sharedCalls} calls both ran` : ""}
            {verdict.callsToSettle != null ? ` · about ${verdict.callsToSettle} calls both ran would decide it` : ""}
          </span>
        </div>
        <p className="text-sm text-foreground" style={{ textWrap: "balance" }}>{verdict.sentence}</p>
        {scope && (
          <p className="text-[11px] text-muted-foreground" data-testid="group-verdict-scope">
            Verdict is for all of <span className="font-medium">{scope.clientLabel ?? "calls with no account label"}</span>'s{" "}
            {scope.assistantCount} assistant{scope.assistantCount === 1 ? "" : "s"} together ({scope.callCount} call{scope.callCount === 1 ? "" : "s"}).
            One assistant alone has too few calls.
          </p>
        )}
      </div>
    </div>
  )
}
