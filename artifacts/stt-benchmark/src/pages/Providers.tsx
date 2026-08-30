import * as React from "react"
import { formatPerMinute } from "@/lib/utils"
import { TableStateBody, errorMessage } from "@/components/table-state"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListBenchmarkProviders,
  useCreateBenchmarkProvider,
  useUpdateBenchmarkProvider,
  useGetAppSettings,
  useUpdateAppSettings,
  getListBenchmarkProvidersQueryKey,
  getGetAppSettingsQueryKey,
  type Provider,
} from "@workspace/api-client-react"
import { Server, Plus, Check, X, Shield, Activity, Zap, KeyRound, Ban, Power, Settings } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger, DialogDescription } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"

/**
 * 2026-08-27, per Abhishek: "for each of the providers it should have
 * multiple models we can configure." A provider row is one (vendor, model)
 * pairing, so the flat card grid showed "Deepgram" three times with no hint
 * that they were the same vendor. Group by vendor and list its models
 * inside, each independently enable/disable-able -- which is what choosing
 * "what they are using" actually means here.
 */
function groupByVendor(providers: Provider[]): [string, Provider[]][] {
  const byVendor = new Map<string, Provider[]>()
  for (const p of providers) {
    const list = byVendor.get(p.name)
    if (list) list.push(p)
    else byVendor.set(p.name, [p])
  }
  return [...byVendor.entries()].map(
    ([vendor, models]) =>
      [vendor, [...models].sort((a, b) => a.model.localeCompare(b.model))] as [string, Provider[]],
  )
}

export default function Providers() {
  const { data: providers, isLoading, isError, error, refetch } = useListBenchmarkProviders()

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Providers</h2>
          <p className="text-muted-foreground mt-1">Configure candidate models and their capabilities.</p>
        </div>
        <CreateProviderDialog />
      </div>

      {isError ? (
        <div className="text-center py-24 border rounded-md border-destructive/40">
          <TableStateBody state={{ kind: "error", message: errorMessage(error), onRetry: () => void refetch() }} />
        </div>
      ) : isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1,2,3].map(i => <Card key={i} className="h-64 animate-pulse bg-muted/20" />)}
        </div>
      ) : providers?.length === 0 ? (
        <div className="text-center py-24 border rounded-md border-dashed border-muted-foreground/30">
          <Server className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
          <h3 className="text-lg font-semibold">No providers configured</h3>
          <p className="text-muted-foreground mb-4">Add your first STT provider to begin benchmarking.</p>
          <CreateProviderDialog />
        </div>
      ) : (
        <>
          {/* T-74 (E.1): the page's question is "which providers are live?"
              -- live vendors first, the active-production designation on
              the same line as the list it affects, and the unconfigured
              vendors in their own section below. */}
          {(() => {
            const groups = groupByVendor(providers ?? [])
            const isLive = ([, models]: [string, Provider[]]) => models.some((m) => m.status === "ready")
            const live = groups.filter(isLive)
            const notLive = groups.filter((g) => !isLive(g))
            return (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Live now</h2>
                    <p className="text-xs text-muted-foreground">
                      {live.length} vendor{live.length === 1 ? "" : "s"} with at least one enabled, keyed model. These are the candidates a bulk can run.
                    </p>
                  </div>
                  <ActiveProviderControl providers={providers} />
                </div>
                {live.length === 0 ? (
                  <p className="rounded-md border border-dashed border-muted-foreground/30 p-6 text-center text-sm text-muted-foreground">
                    No provider is live. Add an API key as an env var and enable a model below.
                  </p>
                ) : (
                  <VendorGrid groups={live} />
                )}
                {notLive.length > 0 && (
                  <>
                    <div className="pt-2">
                      <h2 className="text-lg font-semibold text-muted-foreground">Not configured</h2>
                      <p className="text-xs text-muted-foreground">
                        Adapter present but no key set, or every model disabled. Not offered to bulks until fixed.
                      </p>
                    </div>
                    <VendorGrid groups={notLive} />
                  </>
                )}
              </>
            )
          })()}
        </>
      )}

      <SystemSettingsCard />
    </div>
  )
}

function VendorGrid({ groups }: { groups: [string, Provider[]][] }) {
  return (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {groups.map(([vendor, models]) => (
            <Card
              key={vendor}
              className={`border-t-4 ${models.some((m) => m.status === "ready") ? "border-t-primary" : "border-t-muted"}`}
            >
              <CardHeader>
                <div className="flex justify-between items-start">
                  <div>
                    <CardTitle className="text-xl">{vendor}</CardTitle>
                    <CardDescription className="mt-1 text-xs">
                      {models.length} model{models.length === 1 ? "" : "s"} &middot;{" "}
                      {models.filter((m) => m.status === "ready").length} enabled
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {models.map((provider) => (
                  <div key={provider.id} className="rounded-lg border border-border p-3 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-mono text-sm font-semibold">{provider.model}</div>
                      <Badge variant={provider.status === "ready" ? "default" : "secondary"} className="uppercase text-[10px]">
                        {provider.status.replace("_", " ")}
                      </Badge>
                    </div>

                    {!provider.apiKeyConfigured && provider.hasAdapter && (
                      <div className="flex items-center gap-2 text-xs p-2.5 rounded-md border border-warning/25 bg-warning/10 text-warning">
                        <KeyRound className="w-3.5 h-3.5 shrink-0" />
                        API key not set. Add it as an env var to make this model ready.
                      </div>
                    )}
                    {!provider.hasAdapter && (
                      <div className="flex items-center gap-2 text-xs p-2.5 rounded border border-destructive/20 bg-destructive/10 text-destructive">
                        <Ban className="w-3.5 h-3.5 shrink-0" />
                        No adapter registered for this provider id -- runs will fail this cell.
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-y-2 text-xs">
                      <div className="text-muted-foreground">Streaming</div>
                      <div className="flex justify-end">
                        {provider.supportsStreaming ? <Check className="w-3.5 h-3.5 text-success" /> : <X className="w-3.5 h-3.5 text-muted-foreground" />}
                      </div>
                      <div className="text-muted-foreground">Diarization</div>
                      <div className="flex justify-end">
                        {provider.supportsDiarization ? <Check className="w-3.5 h-3.5 text-success" /> : <X className="w-3.5 h-3.5 text-muted-foreground" />}
                      </div>
                      <div className="text-muted-foreground">Keyword Boost</div>
                      <div className="flex justify-end">
                        {provider.keywordBoosting ? <Check className="w-3.5 h-3.5 text-success" /> : <X className="w-3.5 h-3.5 text-muted-foreground" />}
                      </div>
                      <div className="text-muted-foreground">Cost / Min</div>
                      <div className="flex justify-end font-mono text-primary font-bold">
                        {formatPerMinute(provider.costPerMinute)}
                      </div>
                    </div>

                    {provider.configNote && (
                      <div className="text-[11px] leading-relaxed p-2.5 bg-muted rounded border border-border text-muted-foreground">
                        {provider.configNote}
                      </div>
                    )}

                    <DisableToggle providerId={provider.id} status={provider.status} />
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
  )
}

/**
 * T-74 (E.1 proximity): the active-production designation sits on the same
 * line as the provider list it affects (it used to be one of two fields in
 * a settings card above the list). Same PATCH as before, only this field.
 * Still a label this tool records -- it never reconfigures a live Vapi
 * assistant.
 */
function ActiveProviderControl({ providers }: { providers: Provider[] | undefined }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { data: settings, isLoading } = useGetAppSettings()
  const [activeProviderId, setActiveProviderId] = React.useState("")
  React.useEffect(() => {
    if (settings) setActiveProviderId(settings.activeProviderId ?? "")
  }, [settings])
  const updateSettings = useUpdateAppSettings({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetAppSettingsQueryKey() })
        toast({ title: "Active provider saved" })
      },
      onError: (err) => {
        toast({ title: "Error", description: err instanceof Error ? err.message : "Failed to save.", variant: "destructive" })
      },
    },
  })
  const dirty = !isLoading && (settings?.activeProviderId ?? "") !== activeProviderId
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
      <Label className="text-xs whitespace-nowrap" title="Which provider real production calls use today. A label this tool records -- it does not reconfigure any live Vapi assistant. Results highlights this provider's row and shows every other row's delta against it.">
        Active in production
      </Label>
      <Select value={activeProviderId || "none"} onValueChange={(v) => setActiveProviderId(v === "none" ? "" : v)}>
        <SelectTrigger className="h-8 w-[260px] text-xs"><SelectValue placeholder="None designated" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">None designated</SelectItem>
          {providers?.map((p) => (
            <SelectItem key={p.id} value={p.id}>{p.name} ({p.model})</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant={dirty ? "default" : "outline"}
        disabled={!dirty || updateSettings.isPending}
        onClick={() => updateSettings.mutate({ data: { activeProviderId: activeProviderId || null } })}
      >
        {updateSettings.isPending ? "Saving…" : "Save"}
      </Button>
    </div>
  )
}

// Known OpenAI chat-completions models this agent's judge pass is likely to
// be pointed at. Free-text is also accepted below (an "Other" input) --
// this list is a convenience, not a hard allowlist; the server accepts
// whatever string is sent and just uses it verbatim as the `model` field on
// the OpenAI call (lib/agent.ts).
const KNOWN_AGENT_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o3", "o4-mini"]

/**
 * 2026-08-26, per Abhishek: a system-wide, changeable choice of (a) which
 * provider real production calls actually use -- separate from which
 * providers a bulk run benchmarks -- and (b) which OpenAI model powers the
 * transcript-quality agent's judge pass. This is a recorded designation
 * within this tool only: choosing a provider here does not itself change
 * any live Vapi assistant's transcriber config (that would be a separate,
 * higher-risk action against production assistants -- not built here
 * without an explicit ask, since it's outward-facing and hard to reverse).
 */
function SystemSettingsCard() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { data: settings, isLoading } = useGetAppSettings()
  const [agentModel, setAgentModel] = React.useState("")
  const [customModel, setCustomModel] = React.useState("")

  React.useEffect(() => {
    if (!settings) return
    const known = settings.agentModel && KNOWN_AGENT_MODELS.includes(settings.agentModel)
    setAgentModel(known ? settings.agentModel! : settings.agentModel ? "other" : "")
    setCustomModel(known ? "" : settings.agentModel ?? "")
  }, [settings])

  const updateSettings = useUpdateAppSettings({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetAppSettingsQueryKey() })
        toast({ title: "Settings saved" })
      },
      onError: (err) => {
        toast({ title: "Error", description: err instanceof Error ? err.message : "Failed to save settings.", variant: "destructive" })
      },
    },
  })

  const resolvedAgentModel =
    agentModel === "other" ? customModel.trim() : agentModel === "default" || !agentModel ? "" : agentModel

  const save = () => {
    // T-74: only this field -- the active provider has its own control
    // beside the provider list now.
    updateSettings.mutate({ data: { agentModel: resolvedAgentModel || null } })
  }

  const dirty = !isLoading && (settings?.agentModel ?? "") !== resolvedAgentModel

  return (
    <Card className="border-t-4 border-t-accent">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-accent" />
          <CardTitle className="text-lg">System settings</CardTitle>
        </div>
        <CardDescription>
          Changeable anytime. The active production provider is set beside the provider list above.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Agent judge model</Label>
          <Select value={agentModel || "default"} onValueChange={setAgentModel}>
            <SelectTrigger><SelectValue placeholder="Default (gpt-4o)" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Default (gpt-4o)</SelectItem>
              {KNOWN_AGENT_MODELS.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
              <SelectItem value="other">Other…</SelectItem>
            </SelectContent>
          </Select>
          {agentModel === "other" && (
            <Input
              className="mt-2"
              placeholder="Exact OpenAI model id"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
            />
          )}
        </div>
      </CardContent>
      <CardFooter>
        <Button size="sm" onClick={save} disabled={!dirty || updateSettings.isPending}>
          {updateSettings.isPending ? "Saving…" : "Save settings"}
        </Button>
      </CardFooter>
    </Card>
  )
}

function DisableToggle({ providerId, status }: { providerId: string; status: string }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const updateProvider = useUpdateBenchmarkProvider()
  const isDisabled = status === 'disabled'
  // Bug found live 2026-08-26 (kimi-webbridge QA pass): this toggle only
  // checked status === 'disabled', so clicking it on a not_configured
  // provider (no API key yet) sent disabled:true anyway. syncProviderReadiness()
  // checks manuallyDisabled BEFORE checking the key, so the provider was
  // locked into "disabled" and would stay stuck there even after a real key
  // was added later -- confirmed live: elevenlabs-scribe went
  // not_configured -> disabled with one click, reverted by hand afterward.
  // A provider with no key has nothing to toggle yet; the button is inert
  // until it's at least ready or already manually disabled.
  const canToggle = status === 'ready' || isDisabled

  const toggle = () => {
    if (!canToggle) return
    updateProvider.mutate({
      providerId,
      data: { disabled: !isDisabled }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBenchmarkProvidersQueryKey() })
        toast({ title: isDisabled ? "Provider re-enabled" : "Provider disabled", description: "Historical results are kept (FR-P3)." })
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to update provider.", variant: "destructive" })
      }
    })
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="w-full"
      onClick={toggle}
      disabled={!canToggle || updateProvider.isPending}
      title={canToggle ? undefined : "Add an API key to make this provider ready before disabling it."}
    >
      <Power className="w-3.5 h-3.5 mr-2" />
      {isDisabled ? "Re-enable" : "Disable"}
    </Button>
  )
}

function CreateProviderDialog() {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [model, setModel] = React.useState("")
  const [cost, setCost] = React.useState("0.005")
  const [supportsStreaming, setSupportsStreaming] = React.useState(false)
  const [supportsDiarization, setSupportsDiarization] = React.useState(false)
  const [keywordBoosting, setKeywordBoosting] = React.useState(false)
  
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const createProvider = useCreateBenchmarkProvider()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    createProvider.mutate({
      data: {
        name,
        model,
        costPerMinute: parseFloat(cost),
        supportsStreaming,
        supportsDiarization,
        keywordBoosting
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBenchmarkProvidersQueryKey() })
        setOpen(false)
        // UX review 2026-08-25: the old toast said "Ready for benchmark
        // runs" but a fresh provider is not_configured until its API-key
        // env var exists -- the toast used to lie about readiness.
        toast({
          title: "Provider saved",
          description: "It becomes ready once its API key env var is set on the API server.",
        })
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to configure provider.", variant: "destructive" })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="w-4 h-4 mr-2" /> Add Provider</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure Provider</DialogTitle>
          <DialogDescription>Add a new API configuration to the benchmark.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Provider Name</label>
              <Input value={name} onChange={e => setName(e.target.value)} required placeholder="e.g. Deepgram" />
              {/* UX review 2026-08-25: the id must match a registered
                  adapter or every run cell for it fails, and there is no
                  delete -- say so before the operator mints a dead row. */}
              <p className="text-xs text-muted-foreground">
                Must match a registered adapter id exactly (e.g. deepgram-nova-3, elevenlabs-scribe).
                A provider whose id has no adapter can never run and cannot be deleted.
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Model ID</label>
              <Input value={model} onChange={e => setModel(e.target.value)} required placeholder="nova-2-general" />
            </div>
          </div>
          
          <div className="space-y-2">
            <label className="text-sm font-medium">Cost per Minute ($)</label>
            <Input type="number" step="0.0001" value={cost} onChange={e => setCost(e.target.value)} required />
          </div>

          <div className="space-y-3 pt-2">
            <label className="text-sm font-medium border-b pb-1 block">Capabilities</label>
            <div className="flex items-center space-x-2">
              <input type="checkbox" id="streaming" className="rounded border-input w-4 h-4 accent-primary" checked={supportsStreaming} onChange={e => setSupportsStreaming(e.target.checked)} />
              <label htmlFor="streaming" className="text-sm">Supports Streaming</label>
            </div>
            <div className="flex items-center space-x-2">
              <input type="checkbox" id="diarization" className="rounded border-input w-4 h-4 accent-primary" checked={supportsDiarization} onChange={e => setSupportsDiarization(e.target.checked)} />
              <label htmlFor="diarization" className="text-sm">Supports Diarization</label>
            </div>
            <div className="flex items-center space-x-2">
              <input type="checkbox" id="keyword" className="rounded border-input w-4 h-4 accent-primary" checked={keywordBoosting} onChange={e => setKeywordBoosting(e.target.checked)} />
              <label htmlFor="keyword" className="text-sm">Supports Keyword Boosting</label>
            </div>
          </div>
          
          <DialogFooter className="pt-4">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={createProvider.isPending}>
              {createProvider.isPending ? 'Saving...' : 'Save Provider'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
