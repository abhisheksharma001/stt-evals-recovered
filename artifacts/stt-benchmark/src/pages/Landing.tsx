import { Link } from "wouter"
import { ArrowRight, AudioLines, CheckCircle2, Scale } from "lucide-react"

/**
 * T-83 (PRD-v4 F.2): the public landing page. Static, outside the app shell
 * (no sidebar, no data hooks), same design tokens. It explains what
 * Transcribe Bench does for a client in the order a first-time reader
 * needs: the question it answers, how the evidence is gathered, what the
 * verdict looks like, what it refuses to claim, one call to action.
 *
 * Evidence (visual-and-research, 2026-08-30): hero = one headline, one
 * sentence, one button, then the product (1Password Developer, Frontify on
 * Mobbin); numbered steps in a row (Railway, Grammarly Business); Lenny's
 * "Craft your pitch" (2022-07-19) and Gina Gotthilf (2023-10-19): message
 * and button above the fold, the customer is the hero. Nothing on this
 * page claims what the tool cannot back with a number it computes.
 */

const STEPS: { title: string; body: string }[] = [
  {
    title: "Pull real calls",
    body: "Recorded calls come straight from the client's Vapi account, in the client's own vertical. No vendor demo audio.",
  },
  {
    title: "Run every provider on the same audio",
    body: "Deepgram, AssemblyAI, Cartesia, Gladia, OpenAI and more transcribe the identical recordings, in one batch, with the cost shown before it starts.",
  },
  {
    title: "Count where they disagree",
    body: "Where providers disagree on a word, a name or a number, that call gets a flag. No hand-written reference transcript is needed.",
  },
  {
    title: "Get a verdict with its margin of error",
    body: "The provider with the fewest disagreements per 100 words wins, only if the gap is bigger than the margin of error. Otherwise the page says so.",
  },
]

const HONEST: { title: string; body: string }[] = [
  {
    title: "“Too close to call” is a real answer",
    body: "When two providers sit inside the margin of error, the verdict says that, and estimates how many more calls would decide it.",
  },
  {
    title: "Never a number without its call count",
    body: "Every margin carries the calls it was measured on. Under 20 calls is labelled an early read.",
  },
  {
    title: "Compared against what runs today",
    body: "The provider already in production is on the same table, so the verdict is “X vs. what you have”, not just “X is best”.",
  },
]

export default function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <AudioLines className="h-4 w-4" />
          </span>
          <span className="font-semibold tracking-tight">Transcribe Bench</span>
          <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Ellavox</span>
        </div>
        <Link href="/" className="text-sm font-medium text-muted-foreground hover:text-foreground">
          Open the app
        </Link>
      </header>

      {/* Hero: the question, one sentence, one button. */}
      <section className="mx-auto max-w-5xl px-6 pb-16 pt-12 sm:pt-20">
        <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">For voice-agent deployments</p>
        <h1 className="mt-3 max-w-3xl text-4xl font-bold leading-tight tracking-tight sm:text-5xl" style={{ textWrap: "balance" }}>
          Which speech-to-text provider should this client's calls run on?
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-muted-foreground" style={{ textWrap: "pretty" }}>
          Transcribe Bench answers it with the client's own recorded calls: every provider transcribes the
          same audio, the disagreements are counted, and you get one verdict with its margin of error.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/results"
            className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            See the latest verdict <ArrowRight className="h-4 w-4" />
          </Link>
          <Link href="/bulks" className="inline-flex h-11 items-center rounded-md border border-border px-5 text-sm font-medium hover:bg-muted">
            Run a new comparison
          </Link>
        </div>

        {/* The product: an example verdict, in the app's own words and tokens. */}
        <figure className="mt-14 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="border-b border-border bg-muted/40 px-4 py-2 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Example verdict &middot; what a client sees
          </div>
          <div className="border-l-4 border-l-success p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground">Verdict</span>
              <span className="inline-flex items-center gap-1 rounded-md border border-success/30 bg-success/15 px-2 py-0.5 text-[11px] font-semibold text-success">
                <CheckCircle2 className="h-3 w-3" /> Winner
              </span>
              <span className="text-[11px] font-mono text-muted-foreground">72 calls scored &middot; 64 calls both ran</span>
            </div>
            <p className="mt-3 text-lg leading-snug" style={{ textWrap: "balance" }}>
              <span className="font-semibold">Provider A</span> wins: 1.4 disagreements per 100 words, 38% fewer than
              Provider B, 12% fewer than Provider C (in production today). 72 calls.
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              Winner = fewest disagreements per 100 words, by more than the margin of error. Lower is better. Anything else
              is undecided, not a tie.
            </p>
          </div>
          <figcaption className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
            Names are placeholders. The real page names the vendors, the calls and the list prices.
          </figcaption>
        </figure>
      </section>

      {/* How it works: four numbered steps in a row. */}
      <section className="border-t border-border bg-muted/20">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
          <ol className="mt-8 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-card font-mono text-xs font-semibold">
                  {i + 1}
                </span>
                <div>
                  <h3 className="font-semibold leading-snug">{s.title}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground" style={{ textWrap: "pretty" }}>{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* What it refuses to claim. */}
      <section className="mx-auto max-w-5xl px-6 py-16">
        <div className="flex items-center gap-2">
          <Scale className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-2xl font-semibold tracking-tight">Built to be trusted, not to impress</h2>
        </div>
        <div className="mt-8 grid gap-8 sm:grid-cols-3">
          {HONEST.map((h) => (
            <div key={h.title}>
              <h3 className="font-semibold leading-snug">{h.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground" style={{ textWrap: "pretty" }}>{h.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col items-start gap-4 px-6 py-14 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Ready when the calls are.</h2>
            <p className="mt-1 text-sm text-muted-foreground">Pick the client's Vapi account, choose the providers, see the cost, launch.</p>
          </div>
          <Link
            href="/bulks"
            className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Start a comparison <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-6 py-6 text-xs text-muted-foreground">
          <span>Transcribe Bench &middot; built by Ellavox.ai for its voice-agent clients</span>
          <span>Every verdict page is dated and carries the build it was produced on.</span>
        </div>
      </footer>
    </div>
  )
}
