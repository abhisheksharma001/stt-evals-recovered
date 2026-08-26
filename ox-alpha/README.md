# ox-alpha — project review, improvement plan, and delivery notes

Folder owned by **ox-alpha** (coding agent). Everything here is analysis and
delivery documentation produced during the 2026-08-24 working session on
branch `provider-adapters-run-executor`.

## Contents

| File | What it is |
|---|---|
| [project-review.md](./project-review.md) | Full audit of the STT Benchmark Command Center: what is broken, weak, or missing, with file:line references and severity ratings. |
| [improvement-plan.md](./improvement-plan.md) | The "make the whole thing better in every way" roadmap — prioritized P0–P4, each item scoped with effort and expected payoff. |
| [scalability-design.md](./scalability-design.md) | Design + implementation notes for running 500–1000 provider calls concurrently without melting the API process or the database. |
| [deployment.md](./deployment.md) | Vercel workflow integration: what was wired, the split architecture (static web on Vercel, long-running API elsewhere), and one-time setup steps. |
| [triage.md](./triage.md) | Opportunity-triage audit of the project thesis: every load-bearing claim provenance-labeled, ordered by p(fatal) ÷ cost-to-check, with kill criteria. Prices web-verified; adapters/gold audits blocked-with-evidence pending keys. |
| [bug-register.md](./bug-register.md) | 81 deduplicated defects from the 100-agent correctness hunt (P0×3, P1×19, P2×27, P3×32), each with file:line, trigger, impact, fix sketch; UI-actionable ones fixed and browser-verified 2026-08-25. |
| [bug-register-waves.md](./bug-register-waves.md) | Wave-2 verbatim appendix: 391 confirmed findings from the 10-lens adversarial hunt (591 agents), clustered by file; 83 refuted candidates excluded from the curated register. |
| [e2e-report.md](./e2e-report.md) | End-to-end test results from this session, including the cost-guard rules that were honored and one disclosed slip. |

## Ground rules honored this session

1. All work landed on the pre-existing branch `provider-adapters-run-executor`
   (the dirty tree that was already in progress was preserved, never stashed
   away or reset).
2. Provider/LLM spend kept inside the agreed guardrails: live Vapi interaction
   stayed at a single read-only preview of ≤5 calls, provider network checks
   used fake keys (verbatim 401s), and agent scans were verified on the
   no-OpenAI-key path. One early slip (two micro-sized real OpenAI calls
   before the key was force-cleared) is disclosed candidly in e2e-report.md.
3. Nothing fabricated: scores/results in tests come from deterministic stubs,
   and live-provider checks are labeled as such.
