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
    label: "Clear winner",
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
    label: "Too few calls",
    Icon: Hourglass,
    chip: "bg-muted text-muted-foreground border-border",
    border: "border-l-muted-foreground/40",
  },
  insufficient: {
    label: "Not enough providers",
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

/** Verdict groups are keyed by assistantId with null for "no assistant on the call". */
export function findGroupVerdict(data: BulkVerdicts | undefined, assistantId: string | null) {
  if (!data) return undefined
  return data.groups.find((g) => (g.assistantId ?? null) === assistantId)
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
          <> The remaining {groups.length - winners.length} have no clear winner on this evidence.</>
        )}
      </>
    )
  } else if (counts.too_close > 0 && counts.too_close >= counts.too_few_calls) {
    tone = "too_close"
    headline = <>No clear winner in this bulk: the top providers are inside the noise in every group that has enough calls to judge.</>
  } else {
    tone = "too_few_calls"
    headline = (
      <>
        No clear winner in this bulk yet: {counts.too_few_calls} of {groups.length} assistant group
        {groups.length === 1 ? "" : "s"} have fewer than 5 calls shared by the top two providers, which is the minimum before a noise floor can be drawn.
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
          <span>{groups.length} group{groups.length === 1 ? "" : "s"} · {totalCalls} scored call{totalCalls === 1 ? "" : "s"}</span>
          <span title="Groups where the 95% noise floor excludes zero">{counts.winner} winner{counts.winner === 1 ? "" : "s"}</span>
          <span title="Groups with 5+ shared calls whose gap is inside the noise">{counts.too_close} too close</span>
          <span title="Groups with fewer than 5 calls shared by the top two providers">{counts.too_few_calls} too few calls</span>
          {counts.insufficient > 0 && <span title="Groups with fewer than two providers scored">{counts.insufficient} not enough providers</span>}
        </div>
        {winners.length > 0 && (
          <ul className="space-y-1 text-sm">
            {winners.map((g) => (
              <li key={g.assistantId ?? "__none__"} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{groupLabels[g.assistantId ?? "__none__"] ?? g.vertical}</span>
                <span className="text-muted-foreground">{g.verdict.sentence}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Winner means: fewer cross-provider flags per 100 words, and the gap to the runner-up survived 1,000 reshuffles of the shared calls. Anything else is honestly undecided, not a tie.
        </p>
      </CardContent>
    </Card>
  )
}

export function GroupVerdictHeadline({ verdict }: { verdict: HeadlineVerdict | undefined }) {
  if (!verdict) {
    return (
      <div className="border-b bg-muted/20 px-4 py-3 text-sm text-muted-foreground" data-testid="group-verdict-headline">
        No verdict computed for this group in this bulk.
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
            {verdict.evidenceCalls} call{verdict.evidenceCalls === 1 ? "" : "s"}
            {verdict.provisional ? " · provisional" : ""}
            {verdict.noiseFloor ? ` · ${verdict.noiseFloor.sharedCalls} shared by top two` : ""}
            {verdict.callsToSettle != null ? ` · ~${verdict.callsToSettle} would settle it` : ""}
          </span>
        </div>
        <p className="text-sm text-foreground" style={{ textWrap: "balance" }}>{verdict.sentence}</p>
      </div>
    </div>
  )
}
