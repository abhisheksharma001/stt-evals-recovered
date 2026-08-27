import * as React from "react"
import { Link, useLocation } from "wouter"
import {
  LayoutGrid,
  Database,
  AudioLines,
  GitMerge,
  Layers,
  BarChart3,
  Server,
  Radio,
} from "lucide-react"
import { getHealthCheckQueryKey, useHealthCheck } from "@workspace/api-client-react"
import { cn } from "@/lib/utils"
import { runNavGuard } from "@/lib/nav-guard"

interface SidebarItemProps {
  href: string
  icon: React.ElementType
  label: string
  /** Right-aligned count. Rendered as a coral pill when it needs attention. */
  badge?: string | number
  badgeTone?: "quiet" | "attention"
}

function SidebarItem({ href, icon: Icon, label, badge, badgeTone = "quiet" }: SidebarItemProps) {
  const [location] = useLocation()
  // wouter's location includes the query string: a Corpus -> "Open in
  // Review" deep link (/review?call=<id>) left every nav item unselected
  // (UX review 2026-08-25). Match on the path portion only.
  const isActive = location.split("?")[0] === href
  // B-14: the active page may hold unsaved work (Review's gold editor).
  // Consult its guard before letting wouter unmount it.
  const handleNavClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (href !== location && !runNavGuard()) e.preventDefault()
  }

  return (
    <Link
      href={href}
      onClick={handleNavClick}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <Icon className={cn("w-4 h-4 shrink-0", isActive && "text-primary")} />
      <span>{label}</span>
      {badge !== undefined && (
        <span
          className={cn(
            "ml-auto font-mono text-[10px] tabular-nums",
            badgeTone === "attention"
              ? "rounded-full bg-primary px-1.5 py-0.5 font-semibold text-primary-foreground"
              : "text-muted-foreground",
          )}
        >
          {badge}
        </span>
      )}
    </Link>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-2 pt-5 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-muted-foreground">
      {children}
    </div>
  )
}

/**
 * T-05 (2026-08-28): the API server has no watch mode -- a backend change only
 * takes effect after `node ./build.mjs` AND a manual process restart, two steps
 * that are easy to half-do. Twice this project tested behaviour against a
 * process running older code and drew the wrong conclusion from it.
 *
 * T-04 made the running process able to say which commit it is. This renders
 * that answer permanently on screen, so "did my rebuild actually land?" is
 * answered by looking, not by remembering.
 *
 * The SHA describes the BUNDLE the API process is running, not this UI build
 * and not the working tree -- hence the explicit "api" label. A UI served from
 * a stale browser cache is a different failure and is not what this reports.
 */
function BuildBadge() {
  const { data, isPending, isError } = useHealthCheck({
    query: {
      queryKey: getHealthCheckQueryKey(),
      // Deliberately louder than the app-wide defaults (staleTime 30s,
      // refetchOnWindowFocus false). Restarting the API is exactly the moment
      // this number has to change, and the user is in another window doing it.
      // /api/healthz does no database work (T-04), so this poll is cheap.
      //
      // retry 0 on purpose, against the app-wide retry: 2. A liveness badge
      // that retries is a badge that lies for several seconds while the API is
      // already dead -- and react-query pauses retries while the tab is in the
      // background, so a retrying badge can sit on "checking..." indefinitely
      // (reproduced 2026-08-28). The next poll is the retry.
      retry: 0,
      staleTime: 10_000,
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
    },
  })

  if (isPending) {
    return (
      <BuildBadgeShell tone="quiet" title="Asking the API which build it is running.">
        checking…
      </BuildBadgeShell>
    )
  }

  if (isError || !data) {
    // Worth shouting about: this is also what a killed or crashed API server
    // looks like, and every page in the app is broken while it is true.
    return (
      <BuildBadgeShell tone="down" title="No answer from /api/healthz. The API server is not running, or is not reachable at this origin.">
        unreachable
      </BuildBadgeShell>
    )
  }

  // "-dirty" = built from a tree with uncommitted changes; "dev" = running from
  // source (tsx), not a bundle; "unknown" = built outside a git checkout. None
  // are errors, but all three mean the SHA does not identify a real commit, so
  // they are marked rather than shown as if they did.
  const sha = data.commitSha
  const isProvisional = sha.endsWith("-dirty") || sha === "dev" || sha === "unknown"

  const title = [
    `commit  ${sha}`,
    `built   ${data.builtAt ?? "not a bundle (running from source)"}`,
    `started ${data.startedAt}`,
    `keys    ${data.providersConfigured.length} provider(s) configured`,
    data.providersConfigured.join(", "),
  ].join("\n")

  return (
    <BuildBadgeShell tone={isProvisional ? "provisional" : "quiet"} title={title}>
      {sha}
    </BuildBadgeShell>
  )
}

function BuildBadgeShell({
  tone,
  title,
  children,
}: {
  tone: "quiet" | "provisional" | "down"
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      title={title}
      className="flex items-center gap-2 border-t border-sidebar-border px-4 py-2 font-mono text-[10px] tabular-nums"
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          tone === "down"
            ? "bg-destructive"
            : tone === "provisional"
              ? "bg-warning"
              : "bg-chart-2",
        )}
      />
      <span className="uppercase tracking-[0.09em] text-muted-foreground">api</span>
      <span
        className={cn(
          "truncate",
          tone === "down"
            ? "text-destructive"
            : tone === "provisional"
              ? "text-warning"
              : "text-muted-foreground",
        )}
      >
        {children}
      </span>
    </div>
  )
}

export function Sidebar() {
  return (
    <div className="flex h-full w-[232px] shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar">
      <div className="flex items-center gap-2.5 px-[18px] pb-5 pt-5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-primary">
          <AudioLines className="h-4 w-4 text-primary-foreground" strokeWidth={2.4} />
        </div>
        <div className="flex flex-col gap-px leading-none">
          <span className="text-sm font-bold tracking-[-0.015em] text-sidebar-foreground">
            Transcribe Bench
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.09em] text-muted-foreground">
            Ellavox
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3">
        <SectionLabel>Pipeline</SectionLabel>
        <div className="flex flex-col gap-px">
          <SidebarItem href="/" icon={LayoutGrid} label="Overview" />
          <SidebarItem href="/corpus" icon={Database} label="Corpus" />
          <SidebarItem href="/runs" icon={GitMerge} label="Runs" />
          <SidebarItem href="/bulks" icon={Layers} label="Bulks" />
          <SidebarItem href="/results" icon={BarChart3} label="Results" />
        </div>

        <SectionLabel>Setup</SectionLabel>
        <div className="flex flex-col gap-px">
          <SidebarItem href="/providers" icon={Server} label="Providers" />
          <SidebarItem href="/sources" icon={Radio} label="Call sources" />
        </div>
      </div>

      <div className="flex items-center gap-2.5 border-t border-sidebar-border px-4 py-3.5">
        <div className="flex h-[26px] w-[26px] items-center justify-center rounded-full border border-border bg-secondary">
          <span className="font-mono text-[10px] font-medium text-muted-foreground">AS</span>
        </div>
        <div className="flex flex-col gap-px leading-none">
          <span className="text-xs text-sidebar-foreground">Abhishek</span>
          <span className="font-mono text-[10px] uppercase tracking-[0.09em] text-muted-foreground">
            Curator
          </span>
        </div>
      </div>

      <BuildBadge />
    </div>
  )
}

export function Layout({ children }: { children: React.ReactNode }) {
  // 2026-08-27: the full-bleed exception for the old standalone /review
  // workspace is gone along with the page itself (merged into Corpus's
  // expandable rows, a normal padded page) -- every route uses the same
  // padded shell now.
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background selection:bg-primary/25">
      <Sidebar />
      <main className="relative flex-1 overflow-auto">
        <div className="mx-auto min-h-full max-w-[1400px] p-7">{children}</div>
      </main>
    </div>
  )
}
