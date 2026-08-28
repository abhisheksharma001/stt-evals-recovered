import React from "react"
import {
  useGetClientVolume,
  getGetClientVolumeQueryKey,
  useListBenchmarkCalls,
  useListBenchmarkProviders,
  type ClientVolume,
} from "@workspace/api-client-react"
import { Loader2, Wallet } from "lucide-react"

/**
 * T-24: money, not $/min. A provider's list price per minute times the
 * client's real minutes (read from Vapi -- every call on the account in
 * its 14-day retention window, per assistant) gives "$18/month", the
 * number a person deciding whether to switch can actually weigh.
 *
 * Two honesty rules baked in:
 *  - A month is a PROJECTION from 14 days (Vapi keeps no more). Every
 *    figure says "projected"; the basis (calls, minutes, days) is shown.
 *  - No volume, no dollars. If Vapi is unreachable, the assistant had no
 *    calls in the window, or the label matches no account, the cell says
 *    why and shows nothing -- never a made-up $0.
 */

export const DAYS_PER_MONTH = 30

export function projectMonthlyMinutes(minutes: number, windowDays: number): number {
  return windowDays > 0 ? (minutes * DAYS_PER_MONTH) / windowDays : 0
}

export const fmtUsd = (v: number) =>
  v >= 100 ? `$${Math.round(v).toLocaleString()}` : v >= 10 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`

/** The Vapi account behind an assistant group: the most common
 * sourceAccountLabel on its corpus calls. Null when unknown. */
export function useGroupAccountLabel(assistantId: string | null): string | null {
  const { data: calls } = useListBenchmarkCalls()
  return React.useMemo(() => {
    if (!calls) return null
    const tally = new Map<string, number>()
    for (const c of calls) {
      if ((c.sourceAssistantId ?? null) !== assistantId || !c.sourceAccountLabel) continue
      tally.set(c.sourceAccountLabel, (tally.get(c.sourceAccountLabel) ?? 0) + 1)
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }, [calls, assistantId])
}

export function useClientVolume(accountLabel: string | null) {
  return useGetClientVolume(
    { accountLabel: accountLabel ?? "" },
    {
      query: {
        queryKey: getGetClientVolumeQueryKey({ accountLabel: accountLabel ?? "" }),
        enabled: !!accountLabel,
        // The server caches 15 min; the first fetch can take a minute
        // (Vapi pages 1,000 heavy call objects at a time). Don't retry a
        // 502 into a two-minute wait, and don't refetch on every focus.
        retry: false,
        staleTime: 15 * 60 * 1000,
        refetchOnWindowFocus: false,
      },
    },
  )
}

export type GroupVolume = {
  state: "loading" | "no_account" | "error" | "no_calls" | "ok"
  accountLabel: string | null
  volume: ClientVolume | null
  /** This assistant's own numbers in the window. */
  calls: number
  minutes: number
  monthlyMinutes: number | null
}

export function useGroupVolume(assistantId: string | null): GroupVolume {
  const accountLabel = useGroupAccountLabel(assistantId)
  const { data, isLoading, isError } = useClientVolume(accountLabel)
  return React.useMemo(() => {
    const base = { accountLabel, volume: data ?? null, calls: 0, minutes: 0, monthlyMinutes: null }
    if (!accountLabel) return { ...base, state: "no_account" as const }
    if (isLoading) return { ...base, state: "loading" as const }
    if (isError || !data) return { ...base, state: "error" as const }
    const a = data.assistants.find((x) => x.assistantId === assistantId)
    if (!a || a.calls === 0) return { ...base, state: "no_calls" as const }
    return {
      ...base,
      state: "ok" as const,
      calls: a.calls,
      minutes: a.minutes,
      monthlyMinutes: projectMonthlyMinutes(a.minutes, data.windowDays),
    }
  }, [accountLabel, data, isLoading, isError, assistantId])
}

/** List price per minute per provider id -- the provider catalog's own
 * number, not the per-bulk average on the ranking row (which is an
 * average of per-cell costs and moves with call length). */
export function useListPrices(): Map<string, number> {
  const { data: providers } = useListBenchmarkProviders()
  return React.useMemo(() => new Map((providers ?? []).map((p) => [p.id, p.costPerMinute])), [providers])
}

export function monthlyCost(listPricePerMinute: number | undefined, monthlyMinutes: number | null): number | null {
  if (listPricePerMinute === undefined || monthlyMinutes === null) return null
  return listPricePerMinute * monthlyMinutes
}

/** One line under a group's title: what this assistant actually does on
 * Vapi, and the projected monthly minutes every $/month below is built
 * on. Says plainly when there is no basis. */
export function GroupVolumeLine({ gv }: { gv: GroupVolume }) {
  const cls = "flex items-center gap-2 border-b border-border bg-muted/5 px-4 py-2 text-xs text-muted-foreground"
  if (gv.state === "no_account")
    return <div className={cls} data-testid="group-volume"><Wallet className="h-3.5 w-3.5" /> No Vapi account on this group's calls, so no monthly cost can be projected.</div>
  if (gv.state === "loading")
    return <div className={cls} data-testid="group-volume"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Fetching {gv.accountLabel}'s call volume from Vapi (first load can take a minute)…</div>
  if (gv.state === "error")
    return <div className={cls} data-testid="group-volume"><Wallet className="h-3.5 w-3.5" /> Vapi did not return {gv.accountLabel}'s calls -- showing $/min only, no monthly figure.</div>
  if (gv.state === "no_calls")
    return (
      <div className={cls} data-testid="group-volume">
        <Wallet className="h-3.5 w-3.5" /> This assistant took no calls on Vapi in the last {gv.volume?.windowDays ?? 14} days, so there is no volume to price.
      </div>
    )
  const v = gv.volume!
  return (
    <div className={cls} data-testid="group-volume">
      <Wallet className="h-3.5 w-3.5 text-primary" />
      <span>
        <span className="font-medium text-foreground">Volume:</span> {gv.calls.toLocaleString()} calls, {Math.round(gv.minutes).toLocaleString()} min in the last {v.windowDays} days on Vapi
        {" "}→ <span className="font-medium text-foreground">≈ {Math.round(gv.monthlyMinutes ?? 0).toLocaleString()} min/month</span> projected.
        {v.truncated && <span className="text-destructive"> Vapi page cap hit — read as "at least".</span>}
        {" "}$/month below = list $/min × that.
      </span>
    </div>
  )
}

export function MonthlyCostCell({ listPrice, gv }: { listPrice: number | undefined; gv: GroupVolume }) {
  const cost = gv.state === "ok" ? monthlyCost(listPrice, gv.monthlyMinutes) : null
  if (cost === null) {
    const why =
      gv.state === "loading" ? "Fetching volume…" :
      gv.state === "ok" ? "No list price for this provider" :
      "No volume basis (see the line above the table)"
    return <span title={why}>—</span>
  }
  return (
    <span title={`${fmtUsd(cost)}/month = $${listPrice!.toFixed(4)}/min × ≈${Math.round(gv.monthlyMinutes ?? 0).toLocaleString()} min/month (projected from ${gv.volume?.windowDays} days)`}>
      {fmtUsd(cost)}<span className="text-muted-foreground">/mo</span>
    </span>
  )
}

/**
 * The whole client, not one assistant: every provider's list price at the
 * account's full projected monthly minutes. This is the number a person
 * quotes when asked "what would switching cost us" for the client as a
 * whole. Same projection rule and same absent-not-zero rule as above.
 */
export function ClientMonthlyCostLine({ accountLabel, providerIds }: { accountLabel: string | null; providerIds: string[] }) {
  const { data, isLoading, isError } = useClientVolume(accountLabel)
  const { data: providers } = useListBenchmarkProviders()
  if (!accountLabel) return null
  const cls = "flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-muted/5 px-3 py-2 text-xs"
  if (isLoading)
    return <div className={cls} data-testid="client-cost"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Fetching {accountLabel}'s call volume from Vapi (first load can take a minute)…</div>
  if (isError || !data)
    return <div className={cls} data-testid="client-cost"><Wallet className="h-3.5 w-3.5" /> Vapi did not return {accountLabel}'s calls -- no client-wide monthly figure.</div>
  const monthly = projectMonthlyMinutes(data.minutes, data.windowDays)
  const rows = (providers ?? [])
    .filter((p) => providerIds.includes(p.id))
    .map((p) => ({ id: p.id, name: p.name, cost: p.costPerMinute * monthly }))
    .sort((a, b) => a.cost - b.cost)
  return (
    <div className={cls} data-testid="client-cost">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Wallet className="h-3.5 w-3.5 text-primary" />
        <span className="font-medium text-foreground">{accountLabel}, whole account:</span> {data.calls.toLocaleString()} calls, {Math.round(data.minutes).toLocaleString()} min in {data.windowDays} days
        {" "}→ ≈ {Math.round(monthly).toLocaleString()} min/month{data.truncated ? " (at least — page cap hit)" : ""}.
      </span>
      {rows.map((r) => (
        <span key={r.id} className="font-mono tabular-nums" title={`list $/min × projected monthly minutes`}>
          {r.name} <span className="font-semibold">{fmtUsd(r.cost)}</span><span className="text-muted-foreground">/mo</span>
        </span>
      ))}
    </div>
  )
}
