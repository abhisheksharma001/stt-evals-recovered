import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * T-01 (2026-08-28): real spend is stored in MICRO-CENTS (1 cent = 10,000
 * microcents, $1 = 1,000,000) because integer cents rounded a real judge
 * call to a failed insert and a real STT cell to 1c. Display rule: never
 * show a sub-cent amount as "$0.00" -- that reads as "this was free" when it
 * means "this was small". null is "not recorded", which is not zero.
 *
 * T-03 (2026-08-28): null now says so in words instead of an em dash. A dash
 * is ambiguous in a money column -- it reads as "nothing" as easily as
 * "unknown". A measured zero still renders "$0.00"; only an unmeasured one
 * says "not recorded".
 */
export function formatMicrocents(microcents: number | null | undefined): string {
  if (microcents == null) return "not recorded"
  return formatDollars(microcents / 1_000_000)
}

/**
 * T-95 (PRD-v4 U-10): one rule for money on screen. Sub-cent amounts show
 * four decimals so $0.0049 is never rounded to $0.00; everything else two.
 * Null is "not recorded" -- a dash reads as "nothing" in a money column.
 */
export function formatDollars(dollars: number | null | undefined): string {
  if (dollars == null) return "not recorded"
  if (dollars > 0 && dollars < 0.01) return `$${dollars.toFixed(4)}`
  return `$${dollars.toFixed(2)}`
}

/** Whole cents (estimates are stored in cents) through the same rule. */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return "not recorded"
  return formatDollars(cents / 100)
}

/** A list price per audio minute: always four decimals, always "/min",
 *  because $0.0043 and $0.0060 differ by 40% and two decimals hide it. */
export function formatPerMinute(dollarsPerMinute: number | null | undefined): string {
  if (dollarsPerMinute == null) return "not recorded"
  return `$${dollarsPerMinute.toFixed(4)}/min`
}

/** A projected monthly figure: rounded for reading, never sub-dollar precision
 *  on a number that is itself a projection (T-24). */
export function formatUsdMonthly(v: number): string {
  return v >= 100 ? `$${Math.round(v).toLocaleString()}` : v >= 10 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`
}
