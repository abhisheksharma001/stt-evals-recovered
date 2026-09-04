import { AudioLines, HelpCircle } from "lucide-react"
import type { AudioChannel } from "@/lib/audio-channel"

/**
 * M-5a: the sentence that says which audio a set of numbers was measured
 * on. The wording and the three states live in lib/audio-channel.ts (unit
 * tested, no DOM); this file owns only how they look.
 *
 * Same shape as JudgeChip (T-129) and for the same reason: a chip whose
 * words are decided inside a component can only be checked by rendering a
 * whole page.
 */

const toneClass: Record<AudioChannel["kind"], string> = {
  customer: "border-success/40 bg-success/10 text-success",
  mono: "border-border bg-muted/40 text-muted-foreground",
  // Not a failure -- an honest gap. Warning, so it reads as "this number
  // is missing its provenance", never as a quiet default.
  untracked: "border-warning/40 bg-warning/10 text-warning",
}

/** Card-width line: for a bulk, above its numbers. */
export function ChannelLine({ channel }: { channel: AudioChannel }) {
  const Icon = channel.kind === "untracked" ? HelpCircle : AudioLines
  return (
    <div
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${toneClass[channel.kind]}`}
      data-testid="channel-line"
      data-channel={channel.kind}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{channel.long}</span>
    </div>
  )
}

/** Chip: for one row, next to whatever else that row says about itself. */
export function ChannelChip({ channel }: { channel: AudioChannel }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] ${toneClass[channel.kind]}`}
      data-testid="channel-chip"
      data-channel={channel.kind}
      title={channel.long}
    >
      {channel.short}
    </span>
  )
}
