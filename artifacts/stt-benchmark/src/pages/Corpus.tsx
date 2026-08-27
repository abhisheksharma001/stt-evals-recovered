import * as React from "react"
import { useSearch } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListBenchmarkCalls,
  useCreateBenchmarkCall,
  useUpdateBenchmarkCall,
  useListBenchmarkProviders,
  useListAgentScans,
  getListBenchmarkCallsQueryKey,
  CallStatus,
  Vertical,
} from "@workspace/api-client-react"
import {
  Plus,
  Search,
  Settings2,
  TimerReset,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Trophy,
} from "lucide-react"
import { differenceInCalendarDays } from "date-fns"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { apiBase } from "@/lib/api-base"

// ---------------------------------------------------------------------------
// 2026-08-27, per Abhishek: "for corpus and listen if we can merge both into
// one, so it doesn't make confusion, just put it in layers." Corpus (browse/
// filter/manage) and the old standalone Listen page (audio + transcript for
// one call) were two pages for one task -- find a call, then look at it.
// This is now one page: the table stays the browse/filter surface, and a row
// expands in place to show everything Listen used to on its own page --
// transcript, production-transcriber comparison, and (2026-08-27, same day:
// "bulk calls will also do the agent system working") the automatic agent
// verification result, plus the audio player. No second page, no navigation.
// ---------------------------------------------------------------------------

/** Speaker turns parsed out of a provider transcript ("AI: ...", "User: ..."). */
type Turn = { speaker: string | null; text: string }

function parseTurns(transcript: string | null | undefined): Turn[] {
  if (!transcript) return []
  return transcript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^([A-Za-z][A-Za-z ]{0,14}):\s*(.*)$/.exec(line)
      return match ? { speaker: match[1], text: match[2] } : { speaker: null, text: line }
    })
}

export default function Corpus() {
  const { data: calls, isLoading, isError, error } = useListBenchmarkCalls()
  const search = useSearch()
  const [expandedId, setExpandedId] = React.useState<string | null>(null)
  const [searchText, setSearchText] = React.useState("")
  // UX review 2026-08-25: label/id substring search alone couldn't answer
  // "show me the needs_review trucking calls" on a 1000-row corpus.
  const [statusFilter, setStatusFilter] = React.useState("all")
  const [verticalFilter, setVerticalFilter] = React.useState("all")

  // Deep link support (replaces the old /review?call=<id> link): "expand
  // this call and scroll to it" from anywhere that still passes ?call=<id>.
  const appliedDeepLink = React.useRef(false)
  React.useEffect(() => {
    if (appliedDeepLink.current || !calls) return
    const requested = new URLSearchParams(search).get("call")
    if (requested && calls.some((c) => c.id === requested)) {
      appliedDeepLink.current = true
      setExpandedId(requested)
      requestAnimationFrame(() => {
        document.getElementById(`call-row-${requested}`)?.scrollIntoView({ block: "center" })
      })
    }
  }, [calls, search])

  const filteredCalls = React.useMemo(() => {
    if (!calls) return []
    const q = searchText.toLowerCase()
    return calls.filter(c =>
      (c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) &&
      (statusFilter === "all" || c.status === statusFilter) &&
      (verticalFilter === "all" || c.vertical === verticalFilter)
    )
  }, [calls, searchText, statusFilter, verticalFilter])

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Corpus</h1>
          <p className="text-muted-foreground mt-1">Calls pulled from Vapi, ready to run against any configured provider. No gold transcript or sign-off step required.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative w-56">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search calls..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger aria-label="Filter by status" className="h-9 w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="needs_review">Needs review</SelectItem>
              <SelectItem value="ready_to_run">Ready to run</SelectItem>
            </SelectContent>
          </Select>
          <Select value={verticalFilter} onValueChange={setVerticalFilter}>
            <SelectTrigger aria-label="Filter by vertical" className="h-9 w-48 capitalize"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All verticals</SelectItem>
              <SelectItem value="rush">Rush</SelectItem>
              <SelectItem value="property_management">Property management</SelectItem>
              <SelectItem value="trucking">Trucking</SelectItem>
            </SelectContent>
          </Select>
          <span className="font-mono text-xs text-muted-foreground whitespace-nowrap">
            {filteredCalls.length}{calls ? ` / ${calls.length}` : ""}
          </span>
          <CreateCallDialog />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Call ID / Label</TableHead>
                <TableHead>Vertical</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Hard Cases</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isError ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-destructive text-sm">
                    Failed to load corpus: {error instanceof Error ? error.message : String(error)}
                  </TableCell>
                </TableRow>
              ) : isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">Loading corpus data...</TableCell>
                </TableRow>
              ) : filteredCalls.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">No calls found.</TableCell>
                </TableRow>
              ) : (
                filteredCalls.map(call => {
                  const expanded = call.id === expandedId
                  return (
                    <React.Fragment key={call.id}>
                      <TableRow id={`call-row-${call.id}`} className={expanded ? "bg-muted/20" : undefined}>
                        <TableCell className="pr-0">
                          <button
                            onClick={() => setExpandedId(expanded ? null : call.id)}
                            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
                            aria-label={expanded ? "Collapse" : "Expand"}
                          >
                            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium text-foreground">{call.label}</div>
                          <div className="text-xs font-mono text-muted-foreground">{call.id.substring(0, 8)}...</div>
                        </TableCell>
                        <TableCell>
                          <span className="capitalize text-xs font-mono px-2 py-0.5 rounded-md border border-border bg-secondary text-secondary-foreground">
                            {call.vertical.replace('_', ' ')}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-sm tabular-nums">{Math.floor(call.durationSeconds / 60)}:{(call.durationSeconds % 60).toString().padStart(2, '0')}</span>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <StatusBadge status={call.status} />
                            <RetentionWarning sourceStartedAt={call.sourceStartedAt} />
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1 flex-wrap">
                            {call.hardCases.map((hc, i) => (
                              <span key={i} className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border border-border bg-muted text-muted-foreground">
                                {hc}
                              </span>
                            ))}
                            {call.hardCases.length === 0 && <span className="text-muted-foreground text-xs">—</span>}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              variant={expanded ? "secondary" : "outline"}
                              size="sm"
                              onClick={() => setExpandedId(expanded ? null : call.id)}
                            >
                              {expanded ? "Hide" : "Listen"}
                            </Button>
                            <CallDetailsDialog call={call} />
                          </div>
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow>
                          <TableCell colSpan={7} className="bg-muted/10 p-0">
                            <ExpandedCallDetail call={call} />
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

// The expanded panel -- everything the old standalone Listen page showed for
// one call, now inline. `useListAgentScans()` is unfiltered/shared across
// every expanded row rather than one query per row (corpus-sized dataset,
// cheap either way, and avoids a waterfall as rows expand).
function ExpandedCallDetail({ call }: { call: any }) {
  const { toast } = useToast()
  const { data: scans } = useListAgentScans()
  const latestScan = React.useMemo(
    () =>
      (scans ?? [])
        .filter((s) => s.callId === call.id)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null,
    [scans, call.id],
  )
  const draftTurns = React.useMemo(() => parseTurns(call.draftTranscript), [call.draftTranscript])

  return (
    <div className="space-y-5 border-t border-border p-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          <div>
            <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Provider draft transcript
            </h4>
            {draftTurns.length === 0 ? (
              <p className="text-sm text-muted-foreground">No provider draft transcript on file for this call.</p>
            ) : (
              <div className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
                {draftTurns.map((turn, i) => (
                  <div key={i} className="flex gap-3">
                    {turn.speaker && (
                      <span className="w-12 shrink-0 pt-1 font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {turn.speaker}
                      </span>
                    )}
                    <p className="rounded-md bg-muted/40 p-2.5 font-serif text-sm leading-relaxed text-foreground">
                      {turn.text}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Audio</h4>
            {call.audioObjectPath ? (
              <audio
                key={call.id}
                src={`${apiBase()}/api/benchmark/calls/${call.id}/audio`}
                controls
                onError={() =>
                  toast({
                    title: "Couldn't load audio",
                    description: "The recording link may have expired on Vapi's side, or no Vapi account is configured on the server.",
                    variant: "destructive",
                  })
                }
                className="h-9 w-full"
              />
            ) : (
              <p className="text-xs text-muted-foreground">No audio URL on this call.</p>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <ProductionTranscriberPanel call={call} />
          {call.entityNotes && (
            <div className="rounded-lg border border-card-border bg-card p-3">
              <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Curator notes
              </h4>
              <p className="font-serif text-sm leading-relaxed text-muted-foreground">{call.entityNotes}</p>
            </div>
          )}
        </div>
      </div>

      {/* Full-width: needs room for several transcripts side by side --
          2026-08-27, per Abhishek: "get all the comparisons, like a normal
          transcript, from the different providers ... which one is the
          perfect one and why in a one-liner, and which are the low-
          confidence ones." Reuses the exact same scan data the narrow
          panel used to show (no new storage -- candidates/transcripts and
          the hybrid-flag detail were already being persisted per call). */}
      <ProviderComparisonPanel scan={latestScan} />
    </div>
  )
}

/**
 * 2026-08-27, per Abhishek ("get all the comparisons, like a normal
 * transcript, from the different providers, below show what the changes
 * are, which one is the perfect one and why in a one-liner, and which are
 * the other low-confidence ones"): every bulk/run now auto-verifies its own
 * calls (run-executor.ts -> lib/agent-verify.ts), so this reads straight
 * from what was already computed and stored -- no new storage, no separate
 * page. `scan === null` means the call has never been through a run yet,
 * not that verification failed.
 *
 * Transparency note (also per Abhishek, "I'm hoping this whole decision is
 * coming through the AI"): only the winner pick + its one-liner come from a
 * real LLM call (OpenAI, only spent when the free check below actually
 * found something). The free check itself -- cross-provider disagreement,
 * per-word confidence, entity mismatches -- is deterministic text
 * comparison, not an LLM guess. Both are real signal; neither is hidden.
 */
function ProviderComparisonPanel({ scan }: { scan: any | null }) {
  const [expandedProviderId, setExpandedProviderId] = React.useState<string | null>(null)

  if (!scan) {
    return (
      <DetailSection title="Provider comparison">
        <p className="text-xs text-muted-foreground">
          Not checked yet -- runs automatically the next time this call is included in a run or bulk.
        </p>
      </DetailSection>
    )
  }

  if (scan.status === "scanning" || scan.status === "error") {
    const statusMeta: Record<string, { icon: React.ElementType; className: string; label: string }> = {
      scanning: { icon: Loader2, className: "text-muted-foreground", label: "Checking..." },
      error: { icon: AlertTriangle, className: "text-destructive", label: "Check failed" },
    }
    const meta = statusMeta[scan.status]
    const Icon = meta.icon
    return (
      <DetailSection title="Provider comparison">
        <div className={`flex items-center gap-1.5 text-sm ${meta.className}`}>
          <Icon className="h-3.5 w-3.5" />
          <span className="font-medium">{meta.label}</span>
        </div>
        {scan.errorMessage && <p className="text-xs text-destructive">{scan.errorMessage}</p>}
      </DetailSection>
    )
  }

  const candidates: Array<{ providerId: string; providerName: string; status: string; transcript: string | null }> =
    scan.candidates ?? []
  const flags = scan.hybridFlags
  const lowConfByProvider: Record<string, Array<{ words: string[]; avgConfidence: number; severity: string }>> =
    flags?.lowConfidenceSpans ?? {}
  const disagreementByProvider = new Map<string, number>(
    (flags?.crossProviderDisagreements ?? []).map((d: any) => [d.providerId, d.disagreementRate]),
  )
  const entityMismatchCountByProvider = new Map<string, number>()
  for (const m of flags?.entityMismatches ?? []) {
    for (const pid of [...Object.keys(m.valuesByProvider ?? {}), ...(m.missingProviderIds ?? [])]) {
      entityMismatchCountByProvider.set(pid, (entityMismatchCountByProvider.get(pid) ?? 0) + 1)
    }
  }

  const flagScoreOf = (providerId: string): number =>
    (lowConfByProvider[providerId]?.length ?? 0) + (entityMismatchCountByProvider.get(providerId) ?? 0)

  const sorted = [...candidates]
    .filter((c) => c.status === "ok" && c.transcript)
    .sort((a, b) => {
      if (a.providerId === scan.agentPickProviderId) return -1
      if (b.providerId === scan.agentPickProviderId) return 1
      return flagScoreOf(a.providerId) - flagScoreOf(b.providerId)
    })

  const oneLiner = scan.agentPickReasoning ? scan.agentPickReasoning.split(/(?<=[.!?])\s/)[0] : null

  return (
    <DetailSection title="Provider comparison">
      {scan.status === "clean" ? (
        <div className="flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 className="h-3.5 w-3.5" />
          <span className="font-medium">Clean</span>
          <span className="text-xs text-muted-foreground">
            -- {candidates.length} provider{candidates.length === 1 ? "" : "s"} compared, no disagreement, low-confidence span, or entity mismatch found.
          </span>
        </div>
      ) : (
        <>
          {/* The one real LLM call in this whole panel -- everything else
              on this page is deterministic. Said plainly so it's never
              mistaken for more AI than it is. B-107 (found live 2026-08-27,
              screenshot review): when agentPickProviderId is genuinely null
              (a scan that predates the pick-matching fallback fix), `sorted`
              still orders by fewest-flags as a display fallback -- that
              used to get the SAME "OpenAI pick" trophy badge as a real
              pick, mislabeling a flag-count sort as an AI decision it never
              made. Only ever show the trophy/badge when there's an actual
              agentPickProviderId; otherwise say plainly that OpenAI didn't
              return a usable pick for this one. */}
          {scan.agentPickProviderId ? (
            <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
              <div className="flex items-center gap-1.5 text-sm">
                <Trophy className="h-3.5 w-3.5 text-primary" />
                <span className="font-semibold text-foreground">
                  {candidates.find((c) => c.providerId === scan.agentPickProviderId)?.providerName ?? scan.agentPickProviderId}
                </span>
                <Badge variant="outline" className="text-[9px] uppercase">OpenAI pick</Badge>
              </div>
              {oneLiner && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{oneLiner}</p>}
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
              OpenAI didn't return a usable pick for this call -- providers below are ordered by fewest flags
              instead, not an AI decision.
              {oneLiner && <p className="mt-1 leading-relaxed">{oneLiner}</p>}
            </div>
          )}

          {(flags?.entityMismatches ?? []).length > 0 && (
            <div className="space-y-1 rounded-md border border-warning/25 bg-warning/5 p-2.5 text-xs">
              <span className="font-medium uppercase tracking-wide text-warning">Entities disagree</span>
              {flags.entityMismatches.map((m: any, i: number) => (
                <p key={i} className="text-muted-foreground">
                  <span className="font-medium text-foreground">{m.type.replace(/_/g, " ")}: </span>
                  {Object.entries(m.valuesByProvider ?? {})
                    .map(([pid, vals]) => `${candidates.find((c) => c.providerId === pid)?.providerName ?? pid}: ${(vals as string[]).join(", ")}`)
                    .join(" vs. ")}
                  {m.missingProviderIds?.length > 0 &&
                    ` -- ${m.missingProviderIds.map((pid: string) => candidates.find((c) => c.providerId === pid)?.providerName ?? pid).join(", ")} said nothing.`}
                </p>
              ))}
            </div>
          )}
        </>
      )}

      {/* Every candidate's real transcript, winner first -- click a row to
          read it in full alongside exactly which spans it was flagged for. */}
      <div className="overflow-hidden rounded-md border border-border">
        {sorted.map((c) => {
          const isPicked = c.providerId === scan.agentPickProviderId
          const spans = lowConfByProvider[c.providerId] ?? []
          const disagreement = disagreementByProvider.get(c.providerId)
          const entityCount = entityMismatchCountByProvider.get(c.providerId) ?? 0
          const expanded = expandedProviderId === c.providerId
          return (
            <div key={c.providerId} className="border-b border-border last:border-b-0">
              <button
                onClick={() => setExpandedProviderId(expanded ? null : c.providerId)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/30"
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <span className="text-sm font-medium">{c.providerName}</span>
                {isPicked && (
                  <Badge className="text-[9px] uppercase">
                    <Trophy className="mr-1 h-2.5 w-2.5" /> Picked
                  </Badge>
                )}
                <span className="ml-auto flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
                  {spans.length > 0 && <span title="Low-confidence spans">{spans.length} low-conf</span>}
                  {disagreement != null && disagreement > 0.15 && (
                    <span className="text-warning" title="Disagrees with the other candidates on this share of words">
                      {Math.round(disagreement * 100)}% disagree
                    </span>
                  )}
                  {entityCount > 0 && <span className="text-warning">{entityCount} entity mismatch</span>}
                  {spans.length === 0 && (disagreement == null || disagreement <= 0.15) && entityCount === 0 && (
                    <span className="text-success">clean</span>
                  )}
                </span>
              </button>
              {expanded && (
                <div className="space-y-2 border-t border-border bg-muted/20 p-3">
                  <p className="whitespace-pre-wrap font-serif text-sm leading-relaxed text-foreground">
                    {c.transcript}
                  </p>
                  {spans.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {spans.map((s, i) => (
                        <span
                          key={i}
                          className="rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning"
                          title={`Avg confidence ${(s.avgConfidence * 100).toFixed(0)}%`}
                        >
                          "{s.words.join(" ")}" ({(s.avgConfidence * 100).toFixed(0)}%)
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </DetailSection>
  )
}

// Status carries meaning through the same three semantic tokens the app
// uses elsewhere: not-started stays neutral, in-progress is the accent,
// done is success. No raw Tailwind palette colors here -- that's what let
// green-500/amber-500/purple-500 leak in and clash with the rest of the app.
function StatusBadge({ status }: { status: CallStatus }) {
  const styles: Record<CallStatus, string> = {
    needs_review: "bg-secondary text-muted-foreground border-border",
    ready_for_gold: "bg-secondary text-muted-foreground border-border",
    gold_in_review: "bg-primary/10 text-primary border-primary/25",
    ready_to_run: "bg-success/10 text-success border-success/25",
    archived: "bg-secondary text-muted-foreground/60 border-border",
  }

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wider border ${styles[status]}`}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

// ux-fixes UX-9: Vapi's plan only retains a call's recording for 14 days --
// past that, no provider can ever get a fresh copy of the audio again (see
// docs/PRD-technical-fixes.md FIX-2). Once a run has successfully cached a
// call's bytes, that call is no longer actually at risk -- but this page
// doesn't know per-call cache state, so this warns from age alone. That
// means a cached call can still show a stale warning after day 14 --
// conservative false positive, not a false "all clear," which is the
// direction that's safe to be wrong in for a review-effort warning.
const RETENTION_WINDOW_DAYS = 14
const RETENTION_WARNING_DAYS = 10

function RetentionWarning({ sourceStartedAt }: { sourceStartedAt?: string | null }) {
  if (!sourceStartedAt) return null
  const age = differenceInCalendarDays(new Date(), new Date(sourceStartedAt))
  if (age >= RETENTION_WINDOW_DAYS) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-destructive/25 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-mono uppercase text-destructive"
        title={`This call's recording is ${age} days old -- past Vapi's 14-day retention window. If it hasn't already been successfully run, its audio may be permanently unfetchable now.`}
      >
        <TimerReset className="h-2.5 w-2.5" /> expired?
      </span>
    )
  }
  if (age >= RETENTION_WARNING_DAYS) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-warning/25 bg-warning/10 px-1.5 py-0.5 text-[10px] font-mono uppercase text-warning"
        title={`This call's recording is ${age} days old. Vapi stops serving it after day 14 -- review and run it soon if it hasn't been run yet.`}
      >
        <TimerReset className="h-2.5 w-2.5" /> {RETENTION_WINDOW_DAYS - age}d left
      </span>
    )
  }
  return null
}

function CreateCallDialog() {
  const [open, setOpen] = React.useState(false)
  const [label, setLabel] = React.useState("")
  const [vertical, setVertical] = React.useState<Vertical>("rush")
  const [duration, setDuration] = React.useState("120")

  const queryClient = useQueryClient()
  const { toast } = useToast()
  const createCall = useCreateBenchmarkCall()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    createCall.mutate({
      data: {
        label,
        vertical,
        durationSeconds: (() => {
          // B-54: parseInt("1e3") === 1 — a "1000"-second call stored as 1s,
          // corrupting every duration-based cost estimate. Number() rejects
          // the partial parse.
          const parsed = Number(duration)
          return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
        })(),
        hardCases: []
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBenchmarkCallsQueryKey() })
        setOpen(false)
        setLabel("")
        toast({ title: "Call added", description: "Successfully added to corpus." })
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to add call.", variant: "destructive" })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="w-4 h-4 mr-2" /> Add Call</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register Benchmark Call</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Label / Identifier</label>
            <Input value={label} onChange={e => setLabel(e.target.value)} required minLength={2} placeholder="e.g. Call-1029-A" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Vertical</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={vertical}
                onChange={(e) => setVertical(e.target.value as Vertical)}
              >
                <option value="rush">Rush</option>
                <option value="property_management">Property Management</option>
                <option value="trucking">Trucking</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Duration (sec)</label>
              <Input type="number" value={duration} onChange={e => setDuration(e.target.value)} required min={1} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={createCall.isPending}>
              {createCall.isPending ? 'Saving...' : 'Add Call'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// Everything content-related (transcript, audio, agent verification) lives
// inline in the expanded row now -- this dialog is deliberately narrow: a
// manual status override for edge cases (e.g. archiving a bad recording).
function ProductionTranscriberPanel({ call }: { call: any }) {
  const { data: providers } = useListBenchmarkProviders()
  const vendor: string | null = call.sourceTranscriberProvider ?? null
  const model: string | null = call.sourceTranscriberModel ?? null

  if (!vendor && !model) {
    return (
      <DetailSection title="Transcribed in production by">
        <p className="text-xs text-muted-foreground">
          Not recorded. Calls imported before per-call transcriber capture don&rsquo;t carry this, so
          there&rsquo;s nothing to compare against for this one.
        </p>
      </DetailSection>
    )
  }

  // Vendor/model strings come from Vapi in the vendor's own casing
  // ("flux-general-en"), while provider rows use display casing ("Flux
  // General EN"). Compare on alphanumerics only so the two forms match.
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "")
  const benchmarked = (providers ?? []).find(
    (p) =>
      norm(p.name) === norm(vendor ?? "") && (model ? norm(p.model) === norm(model) : false),
  )
  const isEnabled = benchmarked?.status === "ready"

  return (
    <DetailSection title="Transcribed in production by">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">
          {vendor ?? "unknown"}
          {model ? ` / ${model}` : ""}
        </span>
        {benchmarked ? (
          <Badge variant={isEnabled ? "default" : "secondary"} className="text-[10px] uppercase">
            {isEnabled ? "benchmarked" : "in catalog, disabled"}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] uppercase">not benchmarked</Badge>
        )}
      </div>
      {!benchmarked && (
        <p className="text-xs text-warning">
          No enabled provider matches this model, so every candidate is being compared against a
          baseline this benchmark never measures. Add or enable it on the Providers page to make the
          comparison meaningful.
        </p>
      )}
      {benchmarked && !isEnabled && (
        <p className="text-xs text-muted-foreground">
          This model exists as a provider but is disabled, so it isn&rsquo;t being run.
        </p>
      )}
    </DetailSection>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </h4>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

function DetailRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={`text-right break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  )
}

function CallDetailsDialog({ call }: { call: any }) {
  const [open, setOpen] = React.useState(false)
  const [status, setStatus] = React.useState<CallStatus>(call.status)
  // B-53: the dialog is mounted per row, but `call` is a fresh object after
  // every refetch — a dialog reopened mid-refetch used to edit against the
  // STALE saved status, so Save silently reverted what had just been saved.
  // Re-sync local state from the latest props each time the dialog opens.
  React.useEffect(() => {
    if (open) setStatus(call.status)
  }, [open, call.status])

  const queryClient = useQueryClient()
  const { toast } = useToast()
  const updateCall = useUpdateBenchmarkCall()


  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    updateCall.mutate({
      callId: call.id,
      data: { status },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBenchmarkCallsQueryKey() })
        setOpen(false)
        toast({ title: "Call updated" })
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err?.message ?? "Failed to update call.", variant: "destructive" })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setStatus(call.status) }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm"><Settings2 className="w-4 h-4" /></Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{call.label}</DialogTitle>
        </DialogHeader>

        {/* Grouped into labelled sections rather than one undifferentiated
            stack: identity, recording, what transcribed it in production,
            then the one editable control. */}
        <div className="space-y-5">
          <DetailSection title="Identity">
            <DetailRow label="Vapi call id" value={call.sourceCallId ?? "--"} mono />
            <DetailRow label="Corpus id" value={call.id} mono />
            <DetailRow label="Assistant" value={call.sourceAssistantId ?? "--"} mono />
            <DetailRow label="Vapi account" value={call.sourceAccountLabel || "--"} />
            <DetailRow label="Vertical" value={call.vertical ?? "--"} />
          </DetailSection>

          <DetailSection title="Recording">
            <DetailRow
              label="Started"
              value={call.sourceStartedAt ? new Date(call.sourceStartedAt).toLocaleString() : "not recorded"}
            />
            <DetailRow
              label="Duration"
              value={call.durationSeconds ? `${call.durationSeconds}s` : "--"}
              mono
            />
            <DetailRow label="Audio cached" value={call.audioObjectPath ? "yes" : "no"} />
          </DetailSection>

          <ProductionTranscriberPanel call={call} />

        </div>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">Status</label>
            {/* 2026-08-27: gold-transcript statuses (ready_for_gold,
                gold_in_review) are vestigial now that import lands a call
                directly at ready_to_run, no gate in between -- dropped
                from the picker so nobody manually parks a call in a stage
                nothing reads anymore. Still valid on old rows (schema
                unchanged), just not offered going forward. */}
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono uppercase text-xs"
              value={status}
              onChange={(e) => setStatus(e.target.value as CallStatus)}
            >
              <option value="needs_review">Needs Review</option>
              <option value="ready_to_run">Ready to Run</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={updateCall.isPending}>
              {updateCall.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
