import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListVapiAccounts,
  usePreviewVapiCalls,
  useImportVapiCalls,
  getListBenchmarkCallsQueryKey,
  Vertical,
  VapiPreviewCall,
  VapiImportResult,
} from "@workspace/api-client-react"
import { useLocation } from "wouter"
import {
  AlertCircle,
  ArrowRight,
  Check,
  CloudDownload,
  Copy,
  KeyRound,
  ListChecks,
  Play,
  Search,
} from "lucide-react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

/**
 * Turns a native <input type="date"> value ("2026-08-01") into an ISO
 * instant at the edge of that day *in the operator's own timezone* -- they
 * mean "calls from Aug 1 my time", not "from Aug 1 UTC".
 */
function dayBoundaryIso(value: string, edge: "start" | "end"): string | undefined {
  if (!value) return undefined
  const [year, month, day] = value.split("-").map(Number)
  if (!year || !month || !day) return undefined
  const date =
    edge === "start"
      ? new Date(year, month - 1, day, 0, 0, 0, 0)
      : new Date(year, month - 1, day, 23, 59, 59, 999)
  return date.toISOString()
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "--"
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${String(secs).padStart(2, "0")}`
}

function StepHeading({ step, title, hint }: { step: number; title: string; hint: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-xs font-semibold text-primary">
        {step}
      </div>
      <div>
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p>
      </div>
    </div>
  )
}

/**
 * Full identifier with click-to-copy. Ids here are the join key back to
 * Vapi's own dashboard, so they have to be complete and copyable, not
 * decorative.
 */
function CopyableId({ value, label, muted }: { value: string; label?: string; muted?: boolean }) {
  const [copied, setCopied] = React.useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      },
      () => setCopied(false),
    )
  }
  return (
    <button
      type="button"
      onClick={copy}
      title={`Click to copy ${value}`}
      className={`group flex items-center gap-1 font-mono text-[11px] break-all text-left hover:text-foreground ${
        muted ? "text-muted-foreground" : ""
      }`}
    >
      {label && <span className="shrink-0">{label}</span>}
      <span>{value}</span>
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-success" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
      )}
    </button>
  )
}

export default function Import() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [, navigate] = useLocation()

  const { data: accounts, isLoading: accountsLoading } = useListVapiAccounts()
  const preview = usePreviewVapiCalls()
  const importCalls = useImportVapiCalls()

  const [accountId, setAccountId] = React.useState("")
  const [startDate, setStartDate] = React.useState("")
  const [endDate, setEndDate] = React.useState("")
  const [limit, setLimit] = React.useState("50")
  const [assistantId, setAssistantId] = React.useState("")
  const [vertical, setVertical] = React.useState<Vertical>("rush")

  const [previewCalls, setPreviewCalls] = React.useState<VapiPreviewCall[] | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [importResult, setImportResult] = React.useState<VapiImportResult | null>(null)
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  // UX review 2026-08-25: the preview result is bound to the account it was
  // fetched for. Switching the account dropdown afterwards used to leave the
  // old call ids ticked, and Import would send them under the NEW account --
  // every row failing or mis-skipping. Track the binding; gate on it.
  const [previewedAccountId, setPreviewedAccountId] = React.useState<string | null>(null)
  // B-16: stale = there IS a preview loaded whose binding doesn't match the
  // currently selected account. (Comparing — not just clearing — matters:
  // clearing the binding on a filter change must leave stalePreview TRUE,
  // otherwise the old ticked rows import under the new account silently.)
  const stalePreview = previewCalls !== null && previewedAccountId !== accountId

  // Default to the first configured account once they load.
  React.useEffect(() => {
    if (!accountId && accounts && accounts.length > 0) setAccountId(accounts[0].id)
  }, [accounts, accountId])

  const importable = React.useMemo(
    () => (previewCalls ?? []).filter((c) => c.hasRecording && !c.alreadyImported),
    [previewCalls],
  )

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handlePreview = (e: React.FormEvent) => {
    e.preventDefault()
    setErrorMessage(null)
    setImportResult(null)
    preview.mutate(
      {
        data: {
          accountId,
          limit: Math.max(1, Math.min(500, parseInt(limit, 10) || 50)),
          startDate: dayBoundaryIso(startDate, "start"),
          endDate: dayBoundaryIso(endDate, "end"),
          assistantId: assistantId.trim() || undefined,
        },
      },
      {
        onSuccess: (result) => {
          setPreviewCalls(result.calls)
          setPreviewedAccountId(result.accountId)
          // Pre-tick everything that can actually be imported; the operator
          // unticks rather than hunting for the valid rows.
          setSelected(
            new Set(
              result.calls
                .filter((c) => c.hasRecording && !c.alreadyImported)
                .map((c) => c.vapiCallId),
            ),
          )
        },
        onError: (err) => {
          setPreviewCalls(null)
          setErrorMessage(err instanceof Error ? err.message : "Vapi preview failed.")
        },
      },
    )
  }

  const handleImport = () => {
    setErrorMessage(null)
    // API contract caps a single import batch at 200 ids (VapiImportInput
    // maxItems). Select-all could tick up to the preview limit of 500, which
    // used to guarantee a 400 after the full curation pass (UX review
    // 2026-08-25) -- clamp here, visibly.
    const ids = Array.from(selected).slice(0, 200)
    importCalls.mutate(
      { data: { accountId, vertical, vapiCallIds: ids } },
      {
        onSuccess: (result) => {
          setImportResult(result)
          // Imported ids are done -- untick them so a second click can't
          // re-submit duplicates.
          setSelected((prev) => {
            const next = new Set(prev)
            for (const r of result.results) {
              if (r.outcome !== "failed") next.delete(r.vapiCallId)
            }
            return next
          })
          queryClient.invalidateQueries({ queryKey: getListBenchmarkCallsQueryKey() })
          toast({
            title: `Imported ${result.importedCount} call${result.importedCount === 1 ? "" : "s"}`,
            description: "They are in the corpus as needs_review -- two de-identification approvals are still required.",
          })
        },
        onError: (err) => {
          setErrorMessage(err instanceof Error ? err.message : "Import failed.")
        },
      },
    )
  }

  const noAccounts = !accountsLoading && (accounts?.length ?? 0) === 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Import Calls</h1>
        <p className="mt-1 text-muted-foreground">
          Pull real recordings from Vapi into the corpus. Step 1 of the benchmark pipeline.
        </p>
      </div>

      {noAccounts && (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="flex gap-3 p-4">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <div className="space-y-2 text-sm">
              <p className="font-medium">No Vapi accounts configured on the server.</p>
              <p className="text-muted-foreground">
                API keys are read from environment variables and never stored in the database.
                Set one of these on the API server and restart it:
              </p>
              <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
{`VAPI_API_KEY=...              # shows up as "Default"
VAPI_API_KEY_ELLAVOX=...      # shows up as "Ellavox"
VAPI_API_KEY_CLIENT_ACME=...  # shows up as "Client Acme"`}
              </pre>
            </div>
          </CardContent>
        </Card>
      )}

      {errorMessage && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="flex gap-3 p-4">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <p className="text-sm">{errorMessage}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <StepHeading
            step={1}
            title="Pick a source"
            hint="Which Vapi account, which time window, and how many calls to look at."
          />
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePreview} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">Vapi account</label>
                <select
                  className={selectClass}
                  value={accountId}
                  onChange={(e) => {
                    setAccountId(e.target.value)
                    // Any filter change invalidates the preview binding --
                    // the ticked rows belong to the previously previewed
                    // account/window (UX review 2026-08-25).
                    setPreviewedAccountId(null)
                    setImportResult(null)
                  }}
                  disabled={noAccounts}
                >
                  {accountsLoading && <option value="">Loading accounts...</option>}
                  {accounts?.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label} ({account.envVar} &middot; key {account.keyFingerprint})
                    </option>
                  ))}
                  {noAccounts && <option value="">None configured</option>}
                </select>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <KeyRound className="h-3 w-3" />
                  Key fingerprint confirms which key the server loaded. The key itself never leaves the server.
                </p>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Assistant ID (optional)</label>
                <Input
                  value={assistantId}
                  onChange={(e) => {
                    setAssistantId(e.target.value)
                    // B-37: narrowing the scope after preview must invalidate
                    // the binding like every other filter (B-16 family).
                    setPreviewedAccountId(null)
                    setImportResult(null)
                  }}
                  placeholder="Leave blank for all assistants"
                />
                <p className="text-xs text-muted-foreground">
                  Filtered on our side, not by Vapi's own filter, which returns empty results.
                </p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <label className="text-sm font-medium">From date</label>
                <Input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setPreviewedAccountId(null) }} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">To date</label>
                <Input type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); setPreviewedAccountId(null) }} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Max calls</label>
                <Input
                  type="number"
                  min={1}
                  max={500}
                  value={limit}
                  onChange={(e) => {
                    setLimit(e.target.value)
                    // B-37: limit is part of the preview scope too.
                    setPreviewedAccountId(null)
                    setImportResult(null)
                  }}
                  onBlur={(e) => {
                    // Silent clamping used to lie about coverage (typed 1000,
                    // got 50) -- write the applied value back so the operator
                    // sees it (UX review 2026-08-25).
                    const applied = String(Math.max(1, Math.min(500, parseInt(e.target.value, 10) || 50)))
                    if (e.target.value !== applied) setLimit(applied)
                  }}
                />
              </div>
            </div>
            {/* Timezone visibility: the day boundaries are resolved in the
                browser's timezone; say which one so a machine set to a
                different zone than the call center doesn't silently import
                the wrong day (UX review 2026-08-25). */}
            <p className="font-mono text-xs text-muted-foreground">
              Day boundaries resolved in: {Intl.DateTimeFormat().resolvedOptions().timeZone}
            </p>

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!accountId || preview.isPending}>
                <Search className="mr-2 h-4 w-4" />
                {preview.isPending ? "Fetching from Vapi..." : "Preview calls"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Preview only reads from Vapi. Nothing is written until you import.
              </span>
            </div>
          </form>
        </CardContent>
      </Card>

      {previewCalls && (
        <Card>
          <CardHeader>
            <StepHeading
              step={2}
              title={`Choose what to import (${importable.length} importable of ${previewCalls.length} found)`}
              hint="Calls already in the corpus, or with no recording, cannot be selected."
            />
          </CardHeader>
          <CardContent className="p-0">
            {previewCalls.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                No calls in that window. Widen the date range or raise the max.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={importable.length > 0 && selected.size === importable.length}
                        onCheckedChange={(checked) =>
                          setSelected(
                            checked ? new Set(importable.map((c) => c.vapiCallId)) : new Set(),
                          )
                        }
                        aria-label="Select all importable calls"
                      />
                    </TableHead>
                    <TableHead>Vapi call</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Length</TableHead>
                    <TableHead>Vapi draft</TableHead>
                    <TableHead>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewCalls.map((call) => {
                    const blocked = !call.hasRecording || call.alreadyImported
                    return (
                      <TableRow key={call.vapiCallId} className={blocked ? "opacity-60" : undefined}>
                        <TableCell>
                          <Checkbox
                            checked={selected.has(call.vapiCallId)}
                            disabled={blocked}
                            onCheckedChange={() => toggle(call.vapiCallId)}
                            aria-label={`Select call ${call.vapiCallId}`}
                          />
                        </TableCell>
                        {/* 2026-08-27, per Abhishek: show the call id, not a
                            truncated stub. An 8-character prefix can't be
                            pasted into Vapi's dashboard or matched against a
                            support thread, which is the whole reason to look
                            at it here. */}
                        <TableCell>
                          <CopyableId value={call.vapiCallId} />
                          {call.assistantId && (
                            <CopyableId value={call.assistantId} label="assistant" muted />
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {call.startedAt ? new Date(call.startedAt).toLocaleString() : "--"}
                        </TableCell>
                        <TableCell className="font-mono text-sm tabular-nums">
                          {formatDuration(call.durationSeconds)}
                        </TableCell>
                        <TableCell className="max-w-sm">
                          {call.draftTranscriptChars > 0 ? (
                            <span className="line-clamp-2 text-xs text-muted-foreground">
                              {call.draftTranscriptPreview}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">no draft</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {call.alreadyImported ? (
                            <Badge variant="secondary">already imported</Badge>
                          ) : !call.hasRecording ? (
                            <Badge variant="outline">no recording</Badge>
                          ) : (
                            <Badge>importable</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {previewCalls && previewCalls.length > 0 && (
        <Card>
          <CardHeader>
            <StepHeading
              step={3}
              title="Tag and import"
              hint="Every imported call lands in needs_review. It needs two de-identification approvals before it can be run -- no transcript work required."
            />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">Vertical for this batch</label>
                <select
                  className={selectClass}
                  value={vertical}
                  onChange={(e) => setVertical(e.target.value as Vertical)}
                >
                  <option value="rush">Rush</option>
                  <option value="property_management">Property Management</option>
                  <option value="trucking">Trucking</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  Applies to every call in this import. Import one vertical at a time to keep it accurate.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {stalePreview && (
                <p className="text-xs text-warning flex items-center gap-1.5">
                  <AlertCircle className="h-3 w-3" />
                  Account or filters changed since this preview — re-run Preview before importing.
                </p>
              )}
              <Button
                onClick={handleImport}
                disabled={stalePreview || selected.size === 0 || importCalls.isPending}
              >
                <CloudDownload className="mr-2 h-4 w-4" />
                {importCalls.isPending
                  ? "Importing..."
                  : `Import ${Math.min(selected.size, 200)} call${Math.min(selected.size, 200) === 1 ? "" : "s"}${selected.size > 200 ? ` (of ${selected.size} ticked — 200 max per batch)` : ""}`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {importResult && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ListChecks className="h-4 w-4" /> Import result
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3 text-sm">
              <Badge>{importResult.importedCount} imported</Badge>
              <Badge variant="secondary">{importResult.skippedCount} skipped</Badge>
              {importResult.failedCount > 0 && (
                <Badge variant="destructive">{importResult.failedCount} failed</Badge>
              )}
            </div>
            {importResult.results.some((r) => r.outcome !== "imported") && (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {importResult.results
                  .filter((r) => r.outcome !== "imported")
                  .map((r) => (
                    <li key={r.vapiCallId} className="font-mono">
                      {r.vapiCallId.slice(0, 8)} &mdash; {r.outcome}
                      {r.message ? `: ${r.message}` : ""}
                    </li>
                  ))}
              </ul>
            )}
            <div className="flex items-center gap-3 border-t pt-4">
              <Button variant="outline" onClick={() => navigate("/corpus")}>
                Go to Corpus <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
              <span className="text-xs text-muted-foreground">
                Next step: get two de-identification approvals on each call.
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-dashed">
        <CardContent className="flex items-start gap-3 p-4 text-sm text-muted-foreground">
          <Play className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Import &rarr; de-id (Corpus) &rarr; queue a run (Runs) &rarr;
            compare providers (Rankings). Each stage blocks the next until its prerequisites exist.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
