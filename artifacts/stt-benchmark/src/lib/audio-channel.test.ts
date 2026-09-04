import { describe, expect, it } from "vitest";
import { bulkChannel, cellChannel } from "./audio-channel";

describe("bulkChannel", () => {
  it("names the caller-only channel when the bulk froze that decision", () => {
    expect(bulkChannel(true).kind).toBe("customer");
    expect(bulkChannel(true).long).toContain("caller-only");
  });

  it("names the mono mix AND says the assistant is in it -- the whole point of M-5", () => {
    const mono = bulkChannel(false);
    expect(mono.kind).toBe("mono");
    // "mono" alone means nothing to a reader. What makes the number worth
    // less is WHOSE voice is in the audio, so the sentence has to say it.
    expect(mono.long).toContain("assistant");
  });

  it("a bulk with no flag frozen says not recorded, never a confident channel", () => {
    const untracked = bulkChannel(undefined);
    expect(untracked.kind).toBe("untracked");
    expect(untracked.short).toContain("not recorded");
    // It may EXPLAIN that such runs read the mono mix; it may not present
    // that as something the bulk itself recorded.
    expect(untracked.long).toMatch(/not recorded/i);
  });
});

describe("cellChannel", () => {
  it("labels a cell with the channel its own row carries", () => {
    expect(cellChannel("customer", true)?.kind).toBe("customer");
    expect(cellChannel("mono", true)?.kind).toBe("mono");
  });

  it("a transcribed cell with no channel on file reads mono, marked as untracked", () => {
    const c = cellChannel(null, true);
    // Both halves matter: the word "mono" (those rows really were mono --
    // no other code path existed) and the parenthesis that stops a reader
    // treating it as recorded provenance.
    expect(c?.short).toBe("mono (recorded before this was tracked)");
    expect(c?.kind).toBe("untracked");
  });

  it("undefined is treated the same as null, not as a channel", () => {
    expect(cellChannel(undefined, true)?.kind).toBe("untracked");
  });

  it("says nothing at all about a cell that transcribed nothing", () => {
    // A failed, cancelled, pending or missing cell has no measurement, so
    // there is nothing for a channel to qualify. Labelling it would imply
    // audio was successfully read.
    expect(cellChannel(null, false)).toBeNull();
    expect(cellChannel("customer", false)).toBeNull();
  });
});
