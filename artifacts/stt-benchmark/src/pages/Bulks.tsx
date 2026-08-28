import * as React from "react"
import { formatMicrocents } from "@/lib/utils"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListBulks,
  useGetBulk,
  useCreateBulk,
  useLaunchBulk,
  useRetryBulkFailed,
  useCancelBulk,
  useGetBulkManifest,
  useListBulkTemplates,
  useCreateBulkTemplate,
  useLaunchBulkTemplate,
  useListBenchmarkProviders,
  useListVapiAssistants,
  useListVapiAccounts,
  useListBenchmarkCalls,
  getListBulksQueryKey,
  getGetBulkQueryKey,
  getListBulkTemplatesQueryKey,
  getListBenchmarkRunsQueryKey,
  BulkStatus,
  type Bulk,
  type BulkFailureGroup,
  type BulkTemplate,
  type BulkSelectionCriteria,
  type Provider,
  type VapiAssistant,
} from "@workspace/api-client-react"
import { Layers, Play, RotateCw, XCircle, FileJson, Plus, Rocket, Database, Server, AlertTriangle } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"

function BulkStatusBadge({ status }: { status: BulkStatus }) {
  const styles: Record<BulkStatus, string> = {
    draft: "bg-secondary text-muted-foreground border-border",
    estimating: "bg-secondary text-muted-foreground border-border",
    awaiting_confirmation: "bg-warning/10 text-warning border-warning/25",
    running: "bg-primary/15 text-primary animate-pulse border-primary/30",
    complete: "bg-success/10 text-success border-success/25",
    partial: "bg-warning/10 text-warning border-warning/25",
    failed: "bg-destructive/10 text-destructive border-destructive/25",
    cancelled: "bg-secondary text-muted-foreground border-border line-through",
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold font-mono uppercase tracking-widest border ${styles[status]}`}>
      {status.replaceAll("_", " ")}
    </span>
  )
}

/**
 * Three bulks in a row were created, launched, and reported a green COMPLETE
 * while running exactly nothing -- all 280 cells came back
 * skipped_pending_review because none of the 56 frozen calls had cleared the
 * de-identification gate, and nothing in the creation flow said so.
 *
 * That gate is gone (2026-08-27, per Abhishek), so every matched call now
 * runs. The count stays, because the other half of that bug is still live:
 * a bulk can match zero calls and still launch. It also still calls out
 * calls excluded purely because they carry no sourceStartedAt -- a NULL
 * start date never satisfies the server's gte/lte window, which is the
 * non-obvious reason a date-filtered bulk comes back empty.
 *
 * Mirrors the server's own matcher (resolveCriteriaCallIds +
 * resolveDateWindow in api-server/src/lib/bulks.ts). Keep the two in sync.
 */
type CriteriaDraft = {
  assistantIds: string[]
  accountLabel: string
  lastNDays: string
  minDurationSeconds: string
  // T-10: empty string = no cap.
  maxDurationSeconds: string
  // T-13: outcome filters. Empty = no filter. A call with no captured
  // outcome (null) never passes either list -- same rule as the server.
  includeEndedReasons: string[]
  excludeEndedReasons: string[]
  // "" = any, else exact match on the stored string ("true" / "false").
  successEvaluation: string
}

// T-13 "worth benchmarking" preset -- mirrors WORTH_BENCHMARKING_ENDED_REASONS
// in lib/db/src/schema/benchmark-bulks.ts (the UI does not import that package).
const WORTH_BENCHMARKING_ENDED_REASONS = [
  "customer-ended-call",
  "assistant-forwarded-call",
  "assistant-ended-call",
  "assistant-said-end-call-phrase",
]

function outcomePasses(
  endedReason: string | null | undefined,
  successEvaluation: string | null | undefined,
  criteria: Pick<CriteriaDraft, "includeEndedReasons" | "excludeEndedReasons" | "successEvaluation">,
): boolean {
  const reason = endedReason ?? null
  if (criteria.includeEndedReasons.length > 0 && (reason === null || !criteria.includeEndedReasons.includes(reason))) return false
  if (criteria.excludeEndedReasons.length > 0 && (reason === null || criteria.excludeEndedReasons.includes(reason))) return false
  if (criteria.successEvaluation && (successEvaluation ?? null) !== criteria.successEvaluation) return false
  return true
}

const EMPTY_CRITERIA: CriteriaDraft = {
  assistantIds: [],
  accountLabel: "",
  lastNDays: "",
  minDurationSeconds: "60",
  maxDurationSeconds: "120",
  includeEndedReasons: [],
  excludeEndedReasons: [],
  successEvaluation: "",
}

type Eligibility = {
  matched: number
  /** Calls excluded from a date window purely for having no start date. */
  excludedForNoStartDate: number
  loading: boolean
}

function useCriteriaEligibility(criteria: CriteriaDraft): Eligibility {
  const { data: calls, isLoading } = useListBenchmarkCalls()

  return React.useMemo(() => {
    const all = calls ?? []
    const minDuration = Number.parseInt(criteria.minDurationSeconds, 10) || 0
    const maxDuration = parseMaxDuration(criteria.maxDurationSeconds)
    const days = Number.parseInt(criteria.lastNDays, 10)
    const from =
      Number.isFinite(days) && days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : undefined

    const matchesNonDate = (c: (typeof all)[number]) => {
      if (criteria.assistantIds.length > 0 && !criteria.assistantIds.includes(c.sourceAssistantId ?? "")) return false
      if (criteria.accountLabel && c.sourceAccountLabel !== criteria.accountLabel) return false
      if ((c.durationSeconds ?? 0) < minDuration) return false
      if (maxDuration !== null && (c.durationSeconds ?? 0) > maxDuration) return false
      if (!outcomePasses(c.sourceEndedReason, c.sourceSuccessEvaluation, criteria)) return false
      return true
    }
    const matchesDate = (c: (typeof all)[number]) => {
      if (from === undefined) return true
      const started = c.sourceStartedAt ? Date.parse(c.sourceStartedAt) : NaN
      return Number.isFinite(started) && started >= from
    }

    const matched = all.filter((c) => matchesNonDate(c) && matchesDate(c))
    const excludedForNoStartDate = all.filter(
      (c) => matchesNonDate(c) && !matchesDate(c) && !c.sourceStartedAt,
    )

    return {
      matched: matched.length,
      excludedForNoStartDate: excludedForNoStartDate.length,
      loading: isLoading,
    }
  }, [calls, isLoading, criteria])
}

function EligibilityNotice({ eligibility }: { eligibility: Eligibility }) {
  const { matched, excludedForNoStartDate, loading } = eligibility
  if (loading) return null

  const blocked = matched === 0
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs space-y-1 ${
        blocked ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-secondary/40"
      }`}
    >
      <div className="flex items-center gap-2 font-medium">
        {blocked && <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
        <span>
          {matched} call{matched === 1 ? "" : "s"} match and will run
        </span>
      </div>
      {blocked && <p>Nothing matches these filters, so this bulk would run nothing.</p>}
      {excludedForNoStartDate > 0 && (
        <p className={blocked ? "" : "text-warning"}>
          {excludedForNoStartDate} call{excludedForNoStartDate === 1 ? " is" : "s are"} excluded by the
          date filter because {excludedForNoStartDate === 1 ? "it has" : "they have"} no start date on
          record. Clear &ldquo;last N days&rdquo; to include {excludedForNoStartDate === 1 ? "it" : "them"}.
        </p>
      )}
    </div>
  )
}

function criteriaSummary(c: BulkSelectionCriteria): string {
  const parts: string[] = []
  if (c.assistantIds?.length) parts.push(`${c.assistantIds.length} assistant${c.assistantIds.length === 1 ? "" : "s"}`)
  if (c.lastNDays) parts.push(`last ${c.lastNDays}d`)
  if (c.startedAtFrom) parts.push(`from ${c.startedAtFrom.slice(0, 10)}`)
  if (c.accountLabel) parts.push(c.accountLabel)
  if (c.callIds?.length && !c.resolvedCallIds) parts.push(`${c.callIds.length} picked`)
  if (c.resolvedCallIds) parts.push(`${c.resolvedCallIds.length} calls frozen`)
  if (c.minDurationSeconds || c.maxDurationSeconds) {
    parts.push(c.maxDurationSeconds ? `${c.minDurationSeconds ?? 0}–${c.maxDurationSeconds}s` : `≥${c.minDurationSeconds}s`)
  }
  if (c.includeEndedReasons?.length) parts.push(`outcome in ${c.includeEndedReasons.join("/")}`)
  if (c.excludeEndedReasons?.length) parts.push(`outcome not ${c.excludeEndedReasons.join("/")}`)
  if (c.successEvaluation) parts.push(`success=${c.successEvaluation}`)
  return parts.join(" · ") || "whole corpus"
}

/**
 * 2026-08-26, per Abhishek: bulk selection should pick real assistants
 * directly, not be divided by vertical (rush/leasing/others). Fetches every
 * assistant across every configured Vapi account (verified live: 138 + 70
 * assistants, one request each, well under Vapi's page cap -- see
 * lib/vapi.ts's fetchVapiAssistants). A text filter keeps that list usable;
 * a plain checkbox grid of 200+ items would not be.
 */
function AssistantMultiSelect({
  selectedIds,
  onChange,
  accountLabel,
  onAccountLabelChange,
}: {
  selectedIds: string[]
  onChange: (ids: string[]) => void
  accountLabel: string
  onAccountLabelChange: (label: string) => void
}) {
  const [filter, setFilter] = React.useState("")
  const { data: assistants, isLoading, isError } = useListVapiAssistants()
  // 2026-08-27, per Abhishek: this multi-account setup (Default, Land And
  // Apartment, ...) had no ORG picker at all -- assistants from every
  // configured Vapi account were shown mixed together, with only a small
  // per-row label as a hint. accountLabel is a real BulkSelectionCriteria
  // field the server already filters on (bulks.ts's
  // resolveCriteriaCallIds) -- this was the only place that never set it.
  const { data: accounts } = useListVapiAccounts()
  const showAccountLabel = new Set((assistants ?? []).map((a) => a.accountId)).size > 1

  const filtered = (assistants ?? []).filter(
    (a) =>
      a.name.toLowerCase().includes(filter.toLowerCase()) &&
      (!accountLabel || a.accountLabel === accountLabel),
  )

  const toggle = (id: string) =>
    onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>Assistants (empty = all)</Label>
        {selectedIds.length > 0 && (
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => onChange([])}>
            Clear ({selectedIds.length})
          </button>
        )}
      </div>
      {accounts && accounts.length > 1 && (
        <Select
          value={accountLabel || "__all__"}
          onValueChange={(v) => onAccountLabelChange(v === "__all__" ? "" : v)}
        >
          <SelectTrigger>
            <SelectValue placeholder="All Vapi accounts" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All Vapi accounts</SelectItem>
            {accounts.map((acc) => (
              <SelectItem key={acc.id} value={acc.label}>{acc.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Input
        placeholder="Filter assistants by name…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="max-h-48 overflow-y-auto rounded-md border border-border">
        {isError ? (
          <div className="p-3 text-sm text-destructive">Failed to load assistants from Vapi.</div>
        ) : isLoading ? (
          <div className="p-3 text-sm text-muted-foreground">Loading assistants…</div>
        ) : filtered.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">No assistants match "{filter}".</div>
        ) : (
          filtered.map((a: VapiAssistant) => (
            <label key={a.id} className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-sm last:border-b-0 hover:bg-muted/40">
              <Checkbox checked={selectedIds.includes(a.id)} onCheckedChange={() => toggle(a.id)} />
              <span className="truncate">{a.name}</span>
              {showAccountLabel && (
                <span className="ml-auto shrink-0 font-mono text-[10px] uppercase text-muted-foreground">{a.accountLabel}</span>
              )}
            </label>
          ))
        )}
      </div>
    </div>
  )
}

/** Shared criteria/provider form fields for both the bulk and template dialogs. */
function CriteriaFields({
  providers,
  criteria,
  setCriteria,
  providerIds,
  setProviderIds,
  shardSize,
  setShardSize,
}: {
  providers: Provider[] | undefined
  criteria: CriteriaDraft
  setCriteria: (c: CriteriaDraft) => void
  providerIds: string[]
  setProviderIds: (ids: string[]) => void
  shardSize: string
  setShardSize: (s: string) => void
}) {
  return (
    <div className="space-y-4">
      <AssistantMultiSelect
        accountLabel={criteria.accountLabel}
        onAccountLabelChange={(label) => setCriteria({ ...criteria, accountLabel: label, assistantIds: [] })}
        selectedIds={criteria.assistantIds}
        onChange={(ids) => setCriteria({ ...criteria, assistantIds: ids })}
      />
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label>Window (last N days, empty = all time)</Label>
          <Input
            type="number"
            min={1}
            placeholder="e.g. 7"
            value={criteria.lastNDays}
            onChange={(e) => setCriteria({ ...criteria, lastNDays: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label>Min call duration (s)</Label>
          <Input
            type="number"
            min={0}
            value={criteria.minDurationSeconds}
            onChange={(e) => setCriteria({ ...criteria, minDurationSeconds: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label>Max call duration (s, empty = no cap)</Label>
          <Input
            type="number"
            min={0}
            value={criteria.maxDurationSeconds}
            onChange={(e) => setCriteria({ ...criteria, maxDurationSeconds: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label>Shard size (calls per run)</Label>
          <Input
            type="number"
            min={1}
            max={500}
            value={shardSize}
            onChange={(e) => setShardSize(e.target.value)}
          />
        </div>
      </div>
      <OutcomeFilter criteria={criteria} setCriteria={setCriteria} />
      <div className="space-y-2">
        <Label>Providers</Label>
        <div className="grid grid-cols-2 gap-2">
          {providers?.map((p) => (
            <label key={p.id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-sm">
              <Checkbox
                checked={providerIds.includes(p.id)}
                onCheckedChange={(checked) =>
                  setProviderIds(
                    checked
                      ? [...providerIds, p.id]
                      : providerIds.filter((id) => id !== p.id),
                  )
                }
              />
              <span>{p.name} <span className="text-muted-foreground">{p.model}</span></span>
              {p.status !== "ready" && (
                <span className="ml-auto font-mono text-[10px] uppercase text-muted-foreground">{p.status.replaceAll("_", " ")}</span>
              )}
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

/** T-10: empty/invalid max = no cap (null); the server default only applies when the field is omitted. */
/**
 * T-13: outcome filters. The reason list is whatever the corpus actually
 * holds (distinct sourceEndedReason values), so the UI never offers a value
 * Vapi has not sent. Calls with no captured outcome are listed separately so
 * "null" is visible as its own bucket rather than quietly passing.
 */
function OutcomeFilter({ criteria, setCriteria }: { criteria: CriteriaDraft; setCriteria: (c: CriteriaDraft) => void }) {
  const { data: calls } = useListBenchmarkCalls()
  const reasons = React.useMemo(() => {
    const counts = new Map<string, number>()
    let unknown = 0
    for (const c of calls ?? []) {
      if (c.sourceEndedReason) counts.set(c.sourceEndedReason, (counts.get(c.sourceEndedReason) ?? 0) + 1)
      else unknown += 1
    }
    return { list: [...counts.entries()].sort((a, b) => b[1] - a[1]), unknown }
  }, [calls])
  const mode: "include" | "exclude" = criteria.excludeEndedReasons.length > 0 ? "exclude" : "include"
  const selected = mode === "include" ? criteria.includeEndedReasons : criteria.excludeEndedReasons
  const setSelected = (next: string[], nextMode = mode) =>
    setCriteria({
      ...criteria,
      includeEndedReasons: nextMode === "include" ? next : [],
      excludeEndedReasons: nextMode === "exclude" ? next : [],
    })
  const isPreset =
    mode === "include" &&
    selected.length === WORTH_BENCHMARKING_ENDED_REASONS.length &&
    WORTH_BENCHMARKING_ENDED_REASONS.every((r) => selected.includes(r))

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Call outcome (Vapi endedReason)</Label>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={isPreset ? "default" : "outline"}
            onClick={() => setSelected(isPreset ? [] : [...WORTH_BENCHMARKING_ENDED_REASONS], "include")}
            title="Only real conversations: customer-ended, forwarded, assistant-ended, end-call phrase. Drops voicemail, silence timeouts, misdials, and calls with no captured outcome."
          >
            Worth benchmarking
          </Button>
          <Select value={mode} onValueChange={(v) => setSelected(selected, v as "include" | "exclude")}>
            <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="include">Only these</SelectItem>
              <SelectItem value="exclude">All except these</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border p-3">
        {reasons.list.map(([reason, n]) => (
          <label key={reason} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={selected.includes(reason)}
              onCheckedChange={(v) => setSelected(v ? [...selected, reason] : selected.filter((r) => r !== reason))}
            />
            <span className="font-mono text-xs">{reason}</span>
            <span className="text-muted-foreground">({n})</span>
          </label>
        ))}
        {reasons.list.length === 0 && <span className="text-sm text-muted-foreground">No outcomes captured yet.</span>}
      </div>
      <p className="text-xs text-muted-foreground">
        {selected.length === 0
          ? "No outcome filter."
          : `${reasons.unknown} call${reasons.unknown === 1 ? "" : "s"} with no captured outcome never match an outcome filter.`}
      </p>
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label>Vapi success evaluation</Label>
          <Select value={criteria.successEvaluation || "__any__"} onValueChange={(v) => setCriteria({ ...criteria, successEvaluation: v === "__any__" ? "" : v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__any__">Any</SelectItem>
              <SelectItem value="true">true</SelectItem>
              <SelectItem value="false">false</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  )
}

function parseMaxDuration(raw: string): number | null {
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function buildCriteria(input: CriteriaDraft): BulkSelectionCriteria {
  const criteria: BulkSelectionCriteria = {}
  if (input.assistantIds.length > 0) criteria.assistantIds = input.assistantIds
  if (input.accountLabel) criteria.accountLabel = input.accountLabel
  const days = Number.parseInt(input.lastNDays, 10)
  if (Number.isFinite(days) && days > 0) criteria.lastNDays = days
  const minDuration = Number.parseInt(input.minDurationSeconds, 10)
  if (Number.isFinite(minDuration) && minDuration > 0) criteria.minDurationSeconds = minDuration
  criteria.maxDurationSeconds = parseMaxDuration(input.maxDurationSeconds)
  if (input.includeEndedReasons.length > 0) criteria.includeEndedReasons = input.includeEndedReasons
  if (input.excludeEndedReasons.length > 0) criteria.excludeEndedReasons = input.excludeEndedReasons
  if (input.successEvaluation) criteria.successEvaluation = input.successEvaluation
  return criteria
}

function CreateBulkDialog() {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [criteria, setCriteria] = React.useState<CriteriaDraft>(EMPTY_CRITERIA)
  const [providerIds, setProviderIds] = React.useState<string[]>([])
  const [shardSize, setShardSize] = React.useState("50")
  const { data: providers } = useListBenchmarkProviders()
  const eligibility = useCriteriaEligibility(criteria)
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const createBulk = useCreateBulk({
    mutation: {
      onSuccess: (bulk) => {
        queryClient.invalidateQueries({ queryKey: getListBulksQueryKey() })
        queryClient.invalidateQueries({ queryKey: getListBenchmarkRunsQueryKey() })
        setOpen(false)
        if (bulk.status === "awaiting_confirmation") {
          // FR-BLK-5: over the server cost threshold -- not launched. The
          // detail dialog's Launch button is the explicit confirmation.
          toast({
            title: "Cost gate",
            description: `Estimate $${((bulk.estimatedCostCents ?? 0) / 100).toFixed(2)} exceeds the threshold. Open the bulk and confirm launch.`,
          })
        } else {
          toast({ title: "Bulk launched", description: `"${bulk.name}" is running.` })
        }
      },
      onError: (err) => {
        toast({ title: "Bulk creation failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" })
      },
    },
  })

  const submit = () => {
    createBulk.mutate({
      data: {
        name: name.trim() || undefined,
        criteria: buildCriteria(criteria),
        providerIds,
        shardSize: Number.parseInt(shardSize, 10) || 50,
        minDurationSeconds: Number.parseInt(criteria.minDurationSeconds, 10) || 60,
        maxDurationSeconds: parseMaxDuration(criteria.maxDurationSeconds),
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="mr-2 h-4 w-4" /> New bulk</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New bulk evaluation</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name (default: today's date)</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={new Date().toISOString().slice(0, 10)} />
          </div>
          <CriteriaFields
            providers={providers}
            criteria={criteria}
            setCriteria={setCriteria}
            providerIds={providerIds}
            setProviderIds={setProviderIds}
            shardSize={shardSize}
            setShardSize={setShardSize}
          />
          <EligibilityNotice eligibility={eligibility} />
          <p className="text-xs text-muted-foreground">
            Every matched call runs. Creating a 4th bulk evicts the oldest (FR-BLK-10).
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={providerIds.length === 0 || createBulk.isPending || eligibility.matched === 0}
          >
            {createBulk.isPending ? "Creating..." : "Create & launch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreateTemplateDialog() {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [criteria, setCriteria] = React.useState<CriteriaDraft>({ ...EMPTY_CRITERIA, lastNDays: "7" })
  const [providerIds, setProviderIds] = React.useState<string[]>([])
  const [shardSize, setShardSize] = React.useState("50")
  const { data: providers } = useListBenchmarkProviders()
  const eligibility = useCriteriaEligibility(criteria)
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const createTemplate = useCreateBulkTemplate({
    mutation: {
      onSuccess: (template) => {
        queryClient.invalidateQueries({ queryKey: getListBulkTemplatesQueryKey() })
        setOpen(false)
        toast({ title: "Template saved", description: `"${template.name}" re-resolves its window on every launch.` })
      },
      onError: (err) => {
        toast({ title: "Template creation failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" })
      },
    },
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline"><Plus className="mr-2 h-4 w-4" /> New template</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Save a reusable template (FR-BLK-9)</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly rush check" />
          </div>
          <CriteriaFields
            providers={providers}
            criteria={criteria}
            setCriteria={setCriteria}
            providerIds={providerIds}
            setProviderIds={setProviderIds}
            shardSize={shardSize}
            setShardSize={setShardSize}
          />
          <EligibilityNotice eligibility={eligibility} />
          <p className="text-xs text-muted-foreground">
            Criteria stay unfrozen: "last N days" re-resolves against launch time every launch.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            onClick={() =>
              createTemplate.mutate({
                data: {
                  name: name.trim(),
                  criteria: buildCriteria(criteria),
                  providerIds,
                  shardSize: Number.parseInt(shardSize, 10) || 50,
                  minDurationSeconds: Number.parseInt(criteria.minDurationSeconds, 10) || 60,
                  maxDurationSeconds: parseMaxDuration(criteria.maxDurationSeconds),
                },
              })
            }
            disabled={!name.trim() || providerIds.length === 0 || createTemplate.isPending}
          >
            {createTemplate.isPending ? "Saving..." : "Save template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ManifestView({ bulkId }: { bulkId: string }) {
  const [enabled, setEnabled] = React.useState(false)
  const { data: manifest, isFetching } = useGetBulkManifest(bulkId, {
    query: { enabled, queryKey: ["bulk-manifest", bulkId] },
  })

  const download = () => {
    if (!manifest) return
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `bulk-manifest-${bulkId.slice(0, 8)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setEnabled((v) => !v)}>
          <FileJson className="mr-2 h-3.5 w-3.5" /> {enabled ? "Hide manifest" : isFetching ? "Loading..." : "View manifest"}
        </Button>
        {manifest && (
          <Button variant="outline" size="sm" onClick={download}>Download JSON</Button>
        )}
      </div>
      {enabled && manifest && (
        <pre className="max-h-72 overflow-auto rounded-md border border-border bg-secondary/50 p-3 font-mono text-[11px] leading-relaxed">
          {JSON.stringify(manifest, null, 2)}
        </pre>
      )}
    </div>
  )
}

/**
 * T-07: how each failure class is named and explained on screen.
 *
 * The wording is the whole point of the task. "45 cells failed" reads as
 * "the tool is broken"; "30 recordings expired before we asked for them"
 * reads as what actually happened, and stops an operator paying to retry
 * something that can never succeed.
 *
 * Two entries deserve their difference spelled out, because they look
 * interchangeable and are not:
 *   - "unknown" is a CLASSIFIED failure whose cause was not identified. It
 *     is retryable, because nothing has shown it to be permanent.
 *   - null is an UNCLASSIFIED row -- written before the class column
 *     existed, and left alone by the T-40 backfill because its stored error
 *     text named no cause. It is not retryable: guessing that it was
 *     transient would spend real provider money on a maybe.
 */
const FAILURE_CLASS_COPY: Record<string, { label: string; detail: string }> = {
  retention_expired: {
    label: "Recording expired",
    detail: "Vapi keeps a recording 14 days. Past that the audio is gone for everyone, permanently.",
  },
  audio_url_forbidden: {
    label: "Audio URL forbidden (403)",
    detail: "The signed storage URL refused the download. Bucket-specific and not fixable from here.",
  },
  provider_timeout: {
    label: "Provider timed out",
    detail: "The provider took the audio and never returned a final transcript inside its deadline.",
  },
  provider_5xx: {
    label: "Provider server error",
    detail: "The provider's own side failed the request, or dropped the stream mid-transfer.",
  },
  rate_limited: {
    label: "Rate limited",
    detail: "The provider refused on quota. Worth re-running once the window clears.",
  },
  audio_decode: {
    label: "Audio could not be decoded",
    detail: "The bytes arrived but were not usable audio. The source file has to be fixed first.",
  },
  unknown: {
    label: "Unknown cause",
    detail: "Classified as a failure, but the cause was not identified. Counted as retryable until it is.",
  },
}

const UNCLASSIFIED_COPY = {
  label: "Unclassified (predates classification)",
  detail:
    "Recorded before failures carried a cause, and its stored error text names none. Not guessed, and not retried — re-running it would be paying for a maybe.",
}

/**
 * T-07: replaces the bare "cells failed" number with what it is made of,
 * and states in one line how much of it a retry could actually fix.
 */
function FailureBreakdown({
  groups,
  cellsFailed,
  retryableCells,
}: {
  groups: BulkFailureGroup[]
  cellsFailed: number
  retryableCells: number
}) {
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-baseline justify-between border-b border-border px-3 py-2">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Why {cellsFailed} cell(s) failed
        </div>
        <div className="font-mono text-xs tabular-nums text-muted-foreground">
          {retryableCells} retryable
        </div>
      </div>
      <div className="divide-y divide-border">
        {groups.map((group) => {
          const copy = group.failureClass ? (FAILURE_CLASS_COPY[group.failureClass] ?? UNCLASSIFIED_COPY) : UNCLASSIFIED_COPY
          return (
            <div key={group.failureClass ?? "__unclassified__"} className="flex items-start gap-3 px-3 py-2.5">
              <div className="w-10 shrink-0 font-mono text-lg font-semibold tabular-nums">{group.cells}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{copy.label}</span>
                  <span
                    className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest ${
                      group.retryable
                        ? "border-warning/25 bg-warning/10 text-warning"
                        : "border-border bg-secondary text-muted-foreground"
                    }`}
                  >
                    {group.retryable ? "retryable" : "permanent"}
                  </span>
                </div>
                <div className="text-xs leading-relaxed text-muted-foreground">{copy.detail}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function BulkDetailDialog({ bulk, children }: { bulk: Bulk; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const queryClient = useQueryClient()
  const { toast } = useToast()

  // Poll while the bulk is in flight; stop when terminal (same pattern as
  // the Runs page -- no websocket, FR-EXC-4 explicitly says polled).
  const { data: detail } = useGetBulk(bulk.id, {
    query: {
      queryKey: getGetBulkQueryKey(bulk.id),
      enabled: open,
      refetchInterval: (query) => {
        const status = query.state.data?.status
        return status === "running" || status === "estimating" ? 2000 : false
      },
    },
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListBulksQueryKey() })
    queryClient.invalidateQueries({ queryKey: getGetBulkQueryKey(bulk.id) })
    queryClient.invalidateQueries({ queryKey: getListBenchmarkRunsQueryKey() })
  }
  const onError = (err: unknown) =>
    toast({ title: "Action failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" })

  const launch = useLaunchBulk({ mutation: { onSuccess: invalidate, onError } })
  const retry = useRetryBulkFailed({ mutation: { onSuccess: invalidate, onError } })
  const cancel = useCancelBulk({ mutation: { onSuccess: invalidate, onError } })

  const current = detail ?? bulk
  const p = detail?.progress

  // T-07: the retry button's count comes from the server's own retryable
  // flag (isRetryableFailureClass, the same function the enum ships with) --
  // never re-decided here, so the button and the executor can never
  // disagree about what is worth paying to re-run.
  const failureBreakdown = detail?.failureBreakdown ?? []
  const retryableCells = failureBreakdown.reduce((sum, g) => sum + (g.retryable ? g.cells : 0), 0)
  // A retry also picks up cells that never got a verdict at all -- never
  // written, skipped by the old de-identification gate, or cancelled
  // mid-flight. Those carry no failure class because they never failed, so
  // they have to be counted separately or the button would sit disabled on
  // a bulk that still has real work left in it.
  const unfinishedCells =
    (p?.cellsPending ?? 0) + (p?.cellsSkippedPendingReview ?? 0) + (p?.cellsCancelled ?? 0)
  const retryTargets = retryableCells + unfinishedCells

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            {current.name} <BulkStatusBadge status={current.status} />
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="text-sm text-muted-foreground">
            {criteriaSummary(current.selectionCriteria)} · shard size {current.shardSize} ·{" "}
            {current.providerIds.length} provider(s)
            {/* 2026-08-27, per Abhishek: STT and OpenAI agent-verification
                cost shown separately, not combined -- they're different
                budgets to someone deciding whether to launch this. */}
            {current.estimatedSttCostCents != null && (
              <> · est. STT ${(current.estimatedSttCostCents / 100).toFixed(2)}</>
            )}
            {current.estimatedAgentCostCents != null && (
              <> + agent ${(current.estimatedAgentCostCents / 100).toFixed(2)}</>
            )}
          </div>

          {detail?.actualCost && (p?.cellsOk ?? 0) > 0 && (
            <div className="grid grid-cols-3 gap-3 rounded-md border border-border bg-muted/20 px-3 py-2.5 text-sm">
              <div>
                <div className="text-[10px] font-mono uppercase text-muted-foreground">Actual STT cost</div>
                <div className="font-mono font-semibold">{formatMicrocents(detail.actualCost.sttCostMicrocents)}</div>
              </div>
              <div>
                <div className="text-[10px] font-mono uppercase text-muted-foreground">Actual agent cost</div>
                <div className="font-mono font-semibold">{formatMicrocents(detail.actualCost.agentCostMicrocents)}</div>
              </div>
              <div>
                <div className="text-[10px] font-mono uppercase text-muted-foreground">Agent coverage</div>
                <div className="font-mono font-semibold">
                  {detail.actualCost.agentCallsChecked} checked, {detail.actualCost.agentCallsFlagged} flagged
                  {detail.actualCost.agentCallsErrored > 0 && (
                    <span className="text-destructive">, {detail.actualCost.agentCallsErrored} errored</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* T-03 (2026-08-28): an errored scan is not a finding, it is a
              gap in what was checked. Say that out loud where the coverage
              number is, so "N checked" is never read as "N verified". */}
          {detail?.actualCost && detail.actualCost.agentCallsErrored > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Agent verification failed on {detail.actualCost.agentCallsErrored} of{" "}
                {detail.actualCost.agentCallsChecked} call(s). Those calls are unchecked, not clean &mdash;
                nothing is known about them either way. Provider scores and rankings below are unaffected;
                they come from the transcripts, not from the agent.
              </span>
            </div>
          )}

          {current.notes && (
            <div className="whitespace-pre-line rounded-md border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-warning">
              {current.notes}
            </div>
          )}

          {/* A finished bulk whose cells were ALL skipped is not a success --
              say so where the numbers are. Only historical bulks can be in
              this state now that the de-identification gate is removed. */}
          {p && p.cellsTotal > 0 && p.cellsSkippedPendingReview === p.cellsTotal && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Nothing ran. All {p.cellsTotal} cells were skipped by the de-identification gate that
                applied when this bulk was launched. No provider was billed. That gate is gone &mdash;
                create a new bulk and these calls will run.
              </span>
            </div>
          )}

          {p && (
            <div className="grid grid-cols-4 gap-3">
              {[
                ["Calls in bulk", p.callsTotal],
                ["Calls run", p.callsRun],
                ["Skipped pending review", p.cellsSkippedPendingReview],
                ["Cells total", p.cellsTotal],
                ["Cells ok", p.cellsOk],
                ["Cells failed", p.cellsFailed],
                ["Cells pending", p.cellsPending],
                ["Cells cancelled", p.cellsCancelled],
              ].map(([label, value]) => (
                <div key={label as string} className="rounded-md border border-border px-3 py-2">
                  <div className="font-mono text-lg font-semibold tabular-nums">{value}</div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
                </div>
              ))}
            </div>
          )}

          {failureBreakdown.length > 0 && (
            <FailureBreakdown
              groups={failureBreakdown}
              cellsFailed={p?.cellsFailed ?? 0}
              retryableCells={retryableCells}
            />
          )}

          {detail && detail.runs.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Shard runs</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Shard</TableHead>
                    <TableHead>Run</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Calls</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.runs.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell className="font-mono text-xs">#{run.shardIndex + 1}</TableCell>
                      <TableCell className="font-mono text-xs">{run.id.slice(0, 8)}</TableCell>
                      <TableCell className="font-mono text-xs uppercase">{run.status}</TableCell>
                      <TableCell className="font-mono text-xs">{run.callCount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <ManifestView bulkId={bulk.id} />
        </div>

        <DialogFooter>
          {(current.status === "awaiting_confirmation" || current.status === "draft") && (
            <Button onClick={() => launch.mutate({ bulkId: bulk.id })} disabled={launch.isPending}>
              <Play className="mr-2 h-4 w-4" /> Confirm & launch
            </Button>
          )}
          {/* T-07: the button says how much it would actually re-run, and
              refuses when that is nothing. Before this it was always
              enabled and always said "Retry failed cells" -- on bulk
              7d2585da that meant offering to re-bill 45 cells whose audio
              is permanently gone. The reason is stated next to the button,
              not hidden in a tooltip. */}
          {(current.status === "complete" || current.status === "partial" || current.status === "failed") && (
            <div className="flex items-center gap-3">
              {detail && retryTargets === 0 && (
                <span className="text-xs text-muted-foreground">
                  {(p?.cellsFailed ?? 0) > 0
                    ? "Nothing to retry — every failure here is permanent."
                    : "Nothing to retry — every cell already succeeded."}
                </span>
              )}
              <Button
                variant="outline"
                onClick={() => retry.mutate({ bulkId: bulk.id })}
                disabled={retry.isPending || !detail || retryTargets === 0}
              >
                <RotateCw className="mr-2 h-4 w-4" />
                {detail ? `Retry ${retryTargets} cell(s)` : "Retry failed cells"}
              </Button>
            </div>
          )}
          {current.status === "running" && (
            <Button variant="destructive" onClick={() => cancel.mutate({ bulkId: bulk.id })} disabled={cancel.isPending}>
              <XCircle className="mr-2 h-4 w-4" /> Cancel bulk
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TemplateRow({ template }: { template: BulkTemplate }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const launch = useLaunchBulkTemplate({
    mutation: {
      onSuccess: (bulk) => {
        queryClient.invalidateQueries({ queryKey: getListBulksQueryKey() })
        queryClient.invalidateQueries({ queryKey: getListBenchmarkRunsQueryKey() })
        toast({
          title: bulk.status === "awaiting_confirmation" ? "Cost gate" : "Bulk launched",
          description:
            bulk.status === "awaiting_confirmation"
              ? `"${bulk.name}" needs cost confirmation -- open it below.`
              : `"${bulk.name}" created from template and running.`,
        })
      },
      onError: (err) =>
        toast({ title: "Launch failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" }),
    },
  })

  return (
    <TableRow>
      <TableCell className="font-medium">{template.name}</TableCell>
      <TableCell className="text-sm text-muted-foreground">{criteriaSummary(template.selectionCriteria)}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        <span className="inline-flex items-center"><Server className="mr-1 h-3 w-3" />{template.providerIds.length}</span>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {formatDistanceToNow(new Date(template.createdAt), { addSuffix: true })}
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" variant="outline" onClick={() => launch.mutate({ templateId: template.id, data: {} })} disabled={launch.isPending}>
          <Rocket className="mr-2 h-3.5 w-3.5" /> {launch.isPending ? "Launching..." : "Launch"}
        </Button>
      </TableCell>
    </TableRow>
  )
}

export default function Bulks() {
  // Poll while any bulk is in flight (same reasoning as the Runs page).
  const { data: bulks, isLoading, isError, error } = useListBulks(undefined, {
    query: {
      queryKey: getListBulksQueryKey(),
      refetchInterval: (query) =>
        query.state.data?.some((b) => b.status === "running" || b.status === "estimating") ? 3000 : false,
    },
  })
  const { data: templates } = useListBulkTemplates()

  return (
    <div className="space-y-8">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Bulk Evaluations</h1>
          <p className="mt-1 text-muted-foreground">
            Shard large call slices into runs, with cost gates, retry and cancel. Max 3 live bulks -- the oldest is evicted.
          </p>
        </div>
        <div className="flex gap-2">
          <CreateTemplateDialog />
          <CreateBulkDialog />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Selection</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isError ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-sm text-destructive">
                    Failed to load bulks: {error instanceof Error ? error.message : String(error)}
                  </TableCell>
                </TableRow>
              ) : isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">Loading bulks...</TableCell>
                </TableRow>
              ) : bulks?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    No bulks yet. Create one to evaluate a large call slice.
                  </TableCell>
                </TableRow>
              ) : (
                bulks?.map((bulk) => (
                  <TableRow key={bulk.id}>
                    <TableCell className="font-medium">{bulk.name}</TableCell>
                    <TableCell><BulkStatusBadge status={bulk.status} /></TableCell>
                    <TableCell className="max-w-xs truncate text-sm text-muted-foreground" title={criteriaSummary(bulk.selectionCriteria)}>
                      {criteriaSummary(bulk.selectionCriteria)}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      <span className="mr-3 inline-flex items-center"><Database className="mr-1 h-3 w-3" />{bulk.selectionCriteria.resolvedCallIds?.length ?? 0}</span>
                      <span className="inline-flex items-center"><Server className="mr-1 h-3 w-3" />{bulk.providerIds.length}</span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDistanceToNow(new Date(bulk.createdAt), { addSuffix: true })}
                    </TableCell>
                    <TableCell className="text-right">
                      <BulkDetailDialog bulk={bulk}>
                        <Button size="sm" variant="outline">Open</Button>
                      </BulkDetailDialog>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Layers className="h-4 w-4" /> Reusable templates
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Criteria</TableHead>
                <TableHead>Providers</TableHead>
                <TableHead>Saved</TableHead>
                <TableHead className="text-right">Launch</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No templates. Save one to re-run the same slice (e.g. "last 7 days") on a schedule.
                  </TableCell>
                </TableRow>
              ) : (
                templates?.map((template) => <TemplateRow key={template.id} template={template} />)
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
