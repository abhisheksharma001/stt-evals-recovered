import * as React from "react"
import { AlertCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TableCell, TableRow } from "@/components/ui/table"

/**
 * T-91 (PRD-v4 U-8): every table has three states a reader can tell apart
 * -- loading, failed to load (with a retry), and genuinely empty (with the
 * one action that fills it). Before this, several tables rendered "empty"
 * and "failed" as the same blank row, and a filter that matched nothing
 * read the same as a corpus with nothing in it.
 */
export type TableState =
  | { kind: "loading"; message?: string }
  | { kind: "error"; message: string; onRetry?: () => void }
  | { kind: "empty"; message: string; action?: React.ReactNode }

export function TableStateRow({ colSpan, state, height = "h-32" }: { colSpan: number; state: TableState; height?: string }) {
  return (
    <TableRow data-testid={`table-state-${state.kind}`}>
      <TableCell colSpan={colSpan} className={`${height} text-center align-middle`}>
        <TableStateBody state={state} />
      </TableCell>
    </TableRow>
  )
}

/** The same three states outside a table (card grids, lists). */
export function TableStateBody({ state }: { state: TableState }) {
  if (state.kind === "loading") {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {state.message ?? "Loading…"}
      </span>
    )
  }
  if (state.kind === "error") {
    return (
      <span className="inline-flex flex-wrap items-center justify-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Failed to load: {state.message}</span>
        {state.onRetry && (
          <Button variant="outline" size="sm" className="ml-1 h-7" onClick={state.onRetry}>
            Retry
          </Button>
        )}
      </span>
    )
  }
  return (
    <span className="inline-flex flex-wrap items-center justify-center gap-3 text-sm text-muted-foreground">
      <span>{state.message}</span>
      {state.action}
    </span>
  )
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
