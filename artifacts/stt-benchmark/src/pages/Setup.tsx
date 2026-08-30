import * as React from "react"
import { useLocation, useSearch } from "wouter"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import Providers from "@/pages/Providers"
import Sources from "@/pages/Import"

// ---------------------------------------------------------------------------
// T-31 (PRD-v4-uiux D.4 / E.1 layer 2): Providers and Call sources were two
// sidebar entries for one question -- "keys, accounts, imports". One page,
// two tabs. The tab is in the URL (?tab=providers|sources) so the old
// /providers and /sources deep links, and links inside the app, still land
// on the right thing. Each tab renders the existing page unchanged.
// ---------------------------------------------------------------------------

export type SetupTab = "providers" | "sources"

export default function Setup({ defaultTab }: { defaultTab?: SetupTab }) {
  const search = useSearch()
  const [location, navigate] = useLocation()
  const fromUrl = new URLSearchParams(search).get("tab")
  const tab: SetupTab = fromUrl === "sources" || fromUrl === "providers" ? fromUrl : (defaultTab ?? "providers")

  const onChange = (next: string) => {
    const path = location.split("?")[0]
    navigate(`${path === "/providers" || path === "/sources" ? "/setup" : path}?tab=${next}`, { replace: true })
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Setup</h1>
        <p className="mt-1 text-muted-foreground">Provider keys and models, and the Vapi accounts calls are imported from.</p>
      </div>
      <Tabs value={tab} onValueChange={onChange}>
        <TabsList>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="sources">Call sources</TabsTrigger>
        </TabsList>
        <TabsContent value="providers" className="pt-4">
          <Providers />
        </TabsContent>
        <TabsContent value="sources" className="pt-4">
          <Sources />
        </TabsContent>
      </Tabs>
    </div>
  )
}
