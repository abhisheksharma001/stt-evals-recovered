import * as React from "react"
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
  getListBulksQueryKey,
  getGetBulkQueryKey,
  getListBulkTemplatesQueryKey,
  getListBenchmarkRunsQueryKey,
  BulkStatus,
  type Bulk,
  type BulkTemplate,
  type BulkSelectionCriteria,
  type Provider,
  type VapiAssistant,
} from "@workspace/api-client-react"
import { Layers, Play, RotateCw, XCircle, FileJson, Plus, Rocket, Database, Server } from "lucide-react"
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

function criteriaSummary(c: BulkSelectionCriteria): string {
  const parts: string[] = []
  if (c.assistantIds?.length) parts.push(`${c.assistantIds.length} assistant${c.assistantIds.length === 1 ? "" : "s"}`)
  if (c.lastNDays) parts.push(`last ${c.lastNDays}d`)
  if (c.startedAtFrom) parts.push(`from ${c.startedAtFrom.slice(0, 10)}`)
  if (c.accountLabel) parts.push(c.accountLabel)
  if (c.callIds?.length && !c.resolvedCallIds) parts.push(`${c.callIds.length} picked`)
  if (c.resolvedCallIds) parts.push(`${c.resolvedCallIds.length} calls frozen`)
  if (c.minDurationSeconds) parts.push(`≥${c.minDurationSeconds}s`)
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
  criteria: { assistantIds: string[]; accountLabel: string; lastNDays: string; minDurationSeconds: string }
  setCriteria: (c: { assistantIds: string[]; accountLabel: string; lastNDays: string; minDurationSeconds: string }) => void
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

function buildCriteria(input: { assistantIds: string[]; accountLabel: string; lastNDays: string; minDurationSeconds: string }): BulkSelectionCriteria {
  const criteria: BulkSelectionCriteria = {}
  if (input.assistantIds.length > 0) criteria.assistantIds = input.assistantIds
  if (input.accountLabel) criteria.accountLabel = input.accountLabel
  const days = Number.parseInt(input.lastNDays, 10)
  if (Number.isFinite(days) && days > 0) criteria.lastNDays = days
  const minDuration = Number.parseInt(input.minDurationSeconds, 10)
  if (Number.isFinite(minDuration) && minDuration > 0) criteria.minDurationSeconds = minDuration
  return criteria
}

function CreateBulkDialog() {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [criteria, setCriteria] = React.useState({ assistantIds: [] as string[], accountLabel: "", lastNDays: "", minDurationSeconds: "5" })
  const [providerIds, setProviderIds] = React.useState<string[]>([])
  const [shardSize, setShardSize] = React.useState("50")
  const { data: providers } = useListBenchmarkProviders()
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
        minDurationSeconds: Number.parseInt(criteria.minDurationSeconds, 10) || 5,
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
          <p className="text-xs text-muted-foreground">
            Only <span className="font-mono">ready_to_run</span> calls execute; the rest are recorded as
            skipped pending review (FR-BLK-11). Creating a 4th bulk evicts the oldest (FR-BLK-10).
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={providerIds.length === 0 || createBulk.isPending}>
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
  const [criteria, setCriteria] = React.useState({ assistantIds: [] as string[], accountLabel: "", lastNDays: "7", minDurationSeconds: "5" })
  const [providerIds, setProviderIds] = React.useState<string[]>([])
  const [shardSize, setShardSize] = React.useState("50")
  const { data: providers } = useListBenchmarkProviders()
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
                  minDurationSeconds: Number.parseInt(criteria.minDurationSeconds, 10) || 5,
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
            {current.estimatedCostCents != null && (
              <> · est. ${(current.estimatedCostCents / 100).toFixed(2)}</>
            )}
          </div>

          {current.notes && (
            <div className="rounded-md border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-warning">
              {current.notes}
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
          {(current.status === "complete" || current.status === "partial" || current.status === "failed") && (
            <Button variant="outline" onClick={() => retry.mutate({ bulkId: bulk.id })} disabled={retry.isPending}>
              <RotateCw className="mr-2 h-4 w-4" /> Retry failed cells
            </Button>
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
