import React from "react"
import {
  useGetBulkVerdicts,
  getGetBulkVerdictsQueryKey,
  useGetProxyAgreement,
  type BulkVerdicts,
  type HeadlineVerdict,
} from "@workspace/api-client-react"
import { productionLead } from "@workspace/scoring"
import { Trophy, Scale, Hourglass, CircleOff, Radio } from "lucide-react"
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
    label: "Least disagreement",
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

/** T-55/T-89: verdict groups are per org (the Vapi account; the API field
 *  is still named clientLabel); a Rankings card (per assistant) finds the
 *  org its assistant's calls fed. */
export function findGroupVerdict(data: BulkVerdicts | undefined, assistantId: string | null) {
  if (!data) return undefined
  return data.groups.find((g) => g.assistantIds.includes(assistantId))
}

export function clientGroupLabel(g: { clientLabel: string | null }): string {
  return g.clientLabel ?? "No org label on file"
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
 * R-3: production's own reading for one org, in the words scoring owns
 * (productionLead), so the banner, the Overview and the shareable artefact
 * cannot drift apart. Null when there is no comparable number -- a mono bulk
 * heard the assistant too and production's draft is the caller alone (M-8b).
 */
function productionLeadForGroup(
  data: BulkVerdicts,
  group: BulkVerdicts["groups"][number],
  orgLabel?: string | null,
): { lead: string; caveat: string } | null {
  const pd = group.productionDisagreement
  if (!pd) return null
  return productionLead({
    productionLabel: group.production ? `${group.production.vendor}${group.production.model ? ` / ${group.production.model}` : ""}` : null,
    rate: pd.rate,
    leaderName: pd.leaderProviderId ? nameOf(data, pd.leaderProviderId) : null,
    leaderRate: pd.leaderRate,
    calls: pd.calls,
    totalCalls: pd.totalCalls,
    orgLabel,
  })
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
  /** R-3: production's own reading, which the Overview says BEFORE the
   *  verdict. Non-null only when exactly one org in the bulk has a figure:
   *  these rates are pooled per org and cannot be added together into a
   *  bulk-wide number without the word counts behind them, and the Overview
   *  has one sentence's worth of room. With more than one org the per-org
   *  lines are on Results, where the banner prints all of them. */
  productionLead: { lead: string; caveat: string } | null
  counts: { winner: number; too_close: number; too_few_calls: number; insufficient: number }
  totalCalls: number
  groups: number
} {
  const groups = data.groups
  const leads = groups.map((g) => productionLeadForGroup(data, g)).filter((x) => x !== null)
  const productionLead = leads.length === 1 ? leads[0]! : null
  const counts = { winner: 0, too_close: 0, too_few_calls: 0, insufficient: 0 }
  for (const g of groups) counts[g.verdict.decision] += 1
  const winners = groups.filter((g) => g.verdict.decision === "winner")
  const totalCalls = groups.reduce((s, g) => s + g.verdict.evidenceCalls, 0)
  if (groups.length === 0) {
    return { tone: "insufficient", leadName: null, sentence: "No verdict yet: this bulk has no scored calls.", productionLead, counts, totalCalls, groups: 0 }
  }
  if (winners.length > 0) {
    const tally = new Map<string, number>()
    for (const g of winners) tally.set(g.verdict.winnerProviderId ?? "?", (tally.get(g.verdict.winnerProviderId ?? "?") ?? 0) + 1)
    const [topId, topN] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]
    const rest = groups.length - winners.length
    return {
      tone: "winner",
      leadName: nameOf(data, topId),
      sentence: `has the least disagreement in ${topN} of ${groups.length} group${groups.length === 1 ? "" : "s"}${rest > 0 ? `; ${rest} ha${rest === 1 ? "s" : "ve"} nothing decided yet` : ""}.`,
      productionLead, counts, totalCalls, groups: groups.length,
    }
  }
  if (counts.too_close > 0 && counts.too_close >= counts.too_few_calls) {
    return { tone: "too_close", leadName: null, sentence: "Nothing decided: the top providers are too close to call on the calls so far.", productionLead, counts, totalCalls, groups: groups.length }
  }
  return { tone: "too_few_calls", leadName: null, sentence: `Nothing decided yet: ${counts.too_few_calls} of ${groups.length} group${groups.length === 1 ? "" : "s"} need more calls before one can be named.`, productionLead, counts, totalCalls, groups: groups.length }
}

/**
 * M-18 (PRD-v6 D4): the sentence the M-9 legend has been waiting for -- how
 * often the order this page shows matches the order a human transcript
 * produces, on the calls somebody actually transcribed.
 *
 * The floor is 20 calls, and it is NOT this step's invention: M-20 sets the
 * same floor on the same labelled set for the judge's scorecard. M-18 as
 * written said render whenever n > 0, and the two steps would then have
 * contradicted each other on one page. Read off the live corpus while
 * building this, n = 2 and tau-b = 0.017 -- no relationship at all, which
 * "agreed 50% of the time" would have reported as a coin-flip result rather
 * than as nothing. Below the floor the reader is told how far along the
 * check is instead of being given a number that is noise.
 *
 * Nothing renders at all when no call carries a human gold: M-9's line
 * already says the ranking is not scored against one, and a "0 of 20" under
 * it would just be that sentence again with a number on it.
 *
 * top-1 agreement is the figure on screen because it is the one a reader can
 * act on -- did the check pick the same provider. tau-b, which reads the
 * whole order rather than its head, rides in the tooltip.
 *
 * Both counts appear in the sentence on purpose. n is what could be measured;
 * labelledCalls is what a person actually sat and transcribed. Printing only
 * n against the words "a person checked" would credit them with less work
 * than they did, every time a labelled call turned out unrankable.
 */
function ProxyAgreementLine() {
  const { data } = useGetProxyAgreement()
  if (!data || data.labelledCalls === 0) return null

  const detail =
    `${data.labelledCalls} call(s) carry a human transcript; ${data.n} of them had two or more providers ` +
    `scored both ways and an order that was not entirely tied. ` +
    (data.kendallTau === null
      ? "Kendall tau-b: not measured."
      : `Mean Kendall tau-b ${data.kendallTau.toFixed(2)} (-1 opposite, 0 unrelated, 1 identical), which reads the whole order rather than just its head.`)

  return (
    <p className="text-xs text-muted-foreground" title={detail} data-testid="proxy-agreement">
      {data.n >= 20 && data.top1Agreement !== null ? (
        <>
          On {data.n} of the {data.labelledCalls} calls a person has transcribed, this order picked the
          same provider as the human-checked order {Math.round(data.top1Agreement * 100)}% of the time.
        </>
      ) : (
        <>Not enough human-checked calls to measure this yet -- {data.n} of 20.</>
      )}
    </p>
  )
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
        <span className="font-semibold">{nameOf(data, topId)}</span> has the least disagreement in {topN} of {groups.length} org
        {groups.length === 1 ? "" : "s"}
        {winners.length > topN ? <> ({winners.length - topN} other group{winners.length - topN === 1 ? "" : "s"} named a different provider)</> : null}.
        {counts.too_close + counts.too_few_calls + counts.insufficient > 0 && (
          <> The remaining {groups.length - winners.length} have nothing decided yet.</>
        )}
      </>
    )
  } else if (counts.too_close > 0 && counts.too_close >= counts.too_few_calls) {
    tone = "too_close"
    headline = <>Nothing decided in this bulk: the top providers are inside the margin of error in every group with enough calls.</>
  } else {
    tone = "too_few_calls"
    headline = (
      <>
        Nothing decided in this bulk yet: {counts.too_few_calls} of {groups.length} org
        {groups.length === 1 ? "" : "s"} have fewer than 5 calls that both top providers ran, the minimum for a verdict.
      </>
    )
  }

  const meta = DECISION_META[tone]
  // R-3: the transcriber already running in production is the only number on
  // this page the reader is living with, so it goes FIRST and the verdict
  // follows it. One line per org that has a figure -- prefixed with the org's
  // name only when the bulk holds more than one, because these rates are
  // pooled per org and adding them together would need the word counts behind
  // them. When no org has one, nothing here moves.
  const leads = groups
    .map((g) => productionLeadForGroup(data, g, groups.length > 1 ? (g.clientLabel ?? "calls with no org label") : null))
    .filter((x) => x !== null)

  return (
    <Card className={`border-l-4 ${meta.border}`} data-testid="bulk-verdict-banner">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground">Verdict</span>
          <DecisionChip decision={tone} />
        </div>
        {leads.length > 0 && (
          <div className="space-y-1" data-testid="verdict-production-lead">
            {leads.map((l) => (
              <p key={l.lead} className="text-lg leading-snug text-foreground" style={{ textWrap: "balance" }}>{l.lead}</p>
            ))}
            <p className="text-xs text-muted-foreground">{leads[0]!.caveat}</p>
          </div>
        )}
        <p className={`${leads.length > 0 ? "text-sm" : "text-lg"} leading-snug text-foreground`} style={{ textWrap: "balance" }}>{headline}</p>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground font-mono">
          <span>{groups.length} group{groups.length === 1 ? "" : "s"} · {totalCalls} call{totalCalls === 1 ? "" : "s"} scored</span>
          <span title="Gap to the runner-up is bigger than the margin of error (95% bootstrap interval excludes zero)">{counts.winner} decided</span>
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
          Least disagreement = fewest disagreements per 100 words, by more than the margin of error. Lower is better. Anything
          else is undecided, not a tie.
        </p>
        {/* M-9 (PRD-v6 D1): the permanent qualifier that stops "least
            disagreement" being read as "most accurate". It describes the
            METHOD, not this bulk, so it renders ONCE for the page beside the
            legend -- never per org and never per assistant (M-8b's lesson).

            Two words are deliberate. "the same audio", not "the same customer
            audio": every bulk on file has `requireCustomerAudio` unset, so the
            providers all ran the mono mix. And the second sentence is a claim
            about the SCORING, not the corpus -- 2 of 176 calls do carry a
            human-written gold and both sit in runs; the ranking simply never
            reads one (gold-free hybrid flagging, 2026-08-27). A claim about
            the corpus would rot the next time somebody golds a call.

            PRD-v6 D4 appends the measured agreement figure to this line. */}
        <p className="text-xs text-muted-foreground" data-testid="relative-not-accuracy">
          Relative: how often each provider disagreed with the others on the same audio. Not a measured accuracy --
          nothing here is scored against a human-checked transcript.
        </p>
        <ProxyAgreementLine />
      </CardContent>
    </Card>
  )
}

/**
 * M-8b: how far the transcript production actually produced sat from the
 * candidates' consensus.
 *
 * R-3 correction: this line used to claim it was "on the same 100-word scale
 * the ranking table uses". It never was. Its numerator is mismatched WORDS on
 * the caller's turns; the table's is filtered FLAGS over the whole call's word
 * basis. Same three words of unit, a factor of six between them on bulk
 * 42769f26. The sentence now names its own units (scoring's productionLead)
 * and docs/scoring-policy.md carries the two-rate table.
 *
 * It lives HERE, at org level beside the verdict, and not in Rankings'
 * per-assistant ProductionBaselineNote, because `productionDisagreement` is
 * a property of the verdict GROUP -- and a group is an org. On the corpus
 * as it stands one org group covers 22 assistants, so the per-assistant
 * card would print this one org-level number 22 times, each time reading
 * as that assistant's own. T-55/T-88 already settled the same question for
 * the verdict itself.
 *
 * Null renders NOTHING: no zero, no dash, no "0%". Null here means the
 * candidates and production did not hear the same audio (a mono bulk) or
 * no call had both a caller turn and three candidates -- neither of which
 * is agreement. Why it is null on a mono bulk is said once at page level,
 * where the channel is already named, rather than repeated per org.
 */
export function ProductionDisagreementLine({
  data,
  group,
}: {
  data: BulkVerdicts | undefined
  group: BulkVerdicts["groups"][number] | undefined
}) {
  const copy = data && group ? productionLeadForGroup(data, group) : null
  if (!copy) return null
  return (
    <div className="flex items-start gap-3 border-b bg-muted/10 px-4 py-3" data-testid="production-disagreement">
      <Radio className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-col gap-1 min-w-0">
        <p className="text-sm text-foreground" style={{ textWrap: "balance" }}>{copy.lead}</p>
        <p className="text-[11px] text-muted-foreground">{copy.caveat}</p>
      </div>
    </div>
  )
}

export function GroupVerdictHeadline({
  verdict,
  scope,
}: {
  verdict: HeadlineVerdict | undefined
  /** T-55: the org this verdict was computed over, so a
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
            Verdict is for all of <span className="font-medium">{scope.clientLabel ?? "calls with no org label"}</span>'s{" "}
            {scope.assistantCount} assistant{scope.assistantCount === 1 ? "" : "s"} together ({scope.callCount} call{scope.callCount === 1 ? "" : "s"}).
            One assistant alone has too few calls.
          </p>
        )}
      </div>
    </div>
  )
}
