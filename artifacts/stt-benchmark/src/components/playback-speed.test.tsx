// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PLAYBACK_RATES, PlaybackSpeed, playbackRateLabel } from "./playback-speed";

afterEach(cleanup);

describe("PlaybackSpeed (T-135)", () => {
  it("renders every rate with the active one pressed", () => {
    render(<PlaybackSpeed value={1.5} onChange={() => {}} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(PLAYBACK_RATES.length);
    expect(screen.getByRole("button", { pressed: true }).textContent).toBe(playbackRateLabel(1.5));
  });

  it("reports the clicked rate as a number", () => {
    const onChange = vi.fn();
    render(<PlaybackSpeed value={1} onChange={onChange} />);
    fireEvent.click(screen.getByText(playbackRateLabel(2)));
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it("labels rates with a multiplication sign, not an ambiguous x", () => {
    expect(playbackRateLabel(1.25)).toBe("1.25×");
  });
});
