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
  Bot,
} from "lucide-react"
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
          <SidebarItem href="/review" icon={AudioLines} label="Review" />
          <SidebarItem href="/runs" icon={GitMerge} label="Runs" />
          <SidebarItem href="/bulks" icon={Layers} label="Bulks" />
          <SidebarItem href="/results" icon={BarChart3} label="Results" />
          <SidebarItem href="/agent" icon={Bot} label="Agent" />
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
    </div>
  )
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation()
  // The review workspace runs full-bleed: it manages its own three-column
  // layout and needs every pixel, so the page padding is skipped there.
  // Path-only match -- /review?call=<id> deep links used to lose the
  // full-bleed treatment (UX review 2026-08-25).
  const fullBleed = location.split("?")[0] === "/review"

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background selection:bg-primary/25">
      <Sidebar />
      <main className="relative flex-1 overflow-auto">
        {fullBleed ? (
          children
        ) : (
          <div className="mx-auto min-h-full max-w-[1400px] p-7">{children}</div>
        )}
      </main>
    </div>
  )
}
