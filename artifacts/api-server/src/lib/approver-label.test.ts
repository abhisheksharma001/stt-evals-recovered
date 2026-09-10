import { describe, expect, it } from "vitest";

import { BLANK_APPROVER_MESSAGE, trimmedApproverLabel } from "./approver-label";

describe("trimmedApproverLabel", () => {
  it("rejects the empty string", () => {
    expect(trimmedApproverLabel("")).toBeNull();
  });

  it("rejects whitespace the contract's minLength lets through", () => {
    // Two spaces satisfy `AttestDeidBody`'s `minLength: 2`; that was the bug.
    expect(trimmedApproverLabel("  ")).toBeNull();
    expect(trimmedApproverLabel("\t")).toBeNull();
    expect(trimmedApproverLabel("\n\n")).toBeNull();
    expect(trimmedApproverLabel(" \t \n ")).toBeNull();
  });

  it("returns the trimmed label when there is one", () => {
    expect(trimmedApproverLabel("  Abhishek  ")).toBe("Abhishek");
    expect(trimmedApproverLabel("Abhishek")).toBe("Abhishek");
  });

  it("keeps a one-character label", () => {
    // Blank is the only thing being refused here. A short name is a name.
    expect(trimmedApproverLabel(" A ")).toBe("A");
  });

  it("does not touch whitespace inside the label", () => {
    expect(trimmedApproverLabel(" Abhishek  Sharma ")).toBe("Abhishek  Sharma");
  });

  it("says what is wrong without quoting the input back", () => {
    expect(BLANK_APPROVER_MESSAGE).toContain("approverLabel");
    expect(BLANK_APPROVER_MESSAGE.length).toBeGreaterThan(20);
  });
});
