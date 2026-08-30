// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { JudgeChip } from "./judge-chip"

afterEach(cleanup)

describe("JudgeChip", () => {
  it("renders nothing without a scan -- no scan means never checked, not clean", () => {
    const { container } = render(<JudgeChip scan={null} />)
    expect(container.innerHTML).toBe("")
  })

  it("clean scan renders a muted chip whose hover says the judge was never asked", () => {
    render(<JudgeChip scan={{ status: "clean" }} />)
    const chip = screen.getByTestId("judge-chip")
    expect(chip.textContent).toBe("clean")
    expect(chip.className).toContain("text-muted-foreground")
    expect(chip.title).toContain("never asked")
  })

  it("a high-confidence verdict renders in the success tone", () => {
    render(<JudgeChip scan={{ status: "flagged", agentPickReasoning: "picked A", judgeConfidence: "high" }} />)
    const chip = screen.getByTestId("judge-chip")
    expect(chip.textContent).toBe("judge: high")
    expect(chip.className).toContain("text-success")
  })

  it("a failed check renders destructive and blames the check, not the call", () => {
    render(<JudgeChip scan={{ status: "error" }} />)
    const chip = screen.getByTestId("judge-chip")
    expect(chip.textContent).toBe("check failed")
    expect(chip.className).toContain("text-destructive")
    expect(chip.title).toContain("check itself failed")
  })

  it("a pre-batch-8 verdict (no confidence recorded) stays muted, never invents a level", () => {
    render(<JudgeChip scan={{ status: "flagged", agentPickReasoning: "picked B" }} />)
    const chip = screen.getByTestId("judge-chip")
    expect(chip.textContent).toBe("judge: not recorded")
    expect(chip.className).toContain("text-muted-foreground")
  })
})
