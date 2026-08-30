// T-135 (backlog "Review workspace polish"): variable playback speed for
// call audio. Reviewers listen to whole calls to judge disputed words --
// 1.5x on the clear stretches is the single cheapest time-saver named in
// the backlog's polish list. Dumb on purpose: the parent owns the rate and
// applies it to its own <audio> element (playbackRate resets when the
// element's src/key changes, so the parent re-applies it onLoadedMetadata).
export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const

export function playbackRateLabel(rate: number): string {
  return `${rate}×`
}

export function PlaybackSpeed({ value, onChange }: { value: number; onChange: (rate: number) => void }) {
  return (
    <div className="flex items-center rounded-md border border-border p-0.5" role="group" aria-label="Playback speed" data-testid="playback-speed">
      {PLAYBACK_RATES.map((rate) => (
        <button
          key={rate}
          type="button"
          aria-pressed={value === rate}
          onClick={() => onChange(rate)}
          className={`rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors ${value === rate ? "bg-secondary font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {playbackRateLabel(rate)}
        </button>
      ))}
    </div>
  )
}
