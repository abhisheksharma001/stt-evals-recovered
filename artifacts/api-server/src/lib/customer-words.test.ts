// M-16: the count a bulk's customer-word floor is judged against. The trap
// this file exists to hold shut is the order of operations -- normalising
// the draft first strips the `AI:` / `User:` labels, and the count silently
// becomes "every word on the call" instead of "every word the caller said".
import { describe, expect, it } from "vitest";
import { countCustomerWords } from "./customer-words";

const draft = [
  "AI: Thanks for calling Land and Apartment, how can I help?",
  "User: hi yeah I need someone to look at my heater",
  "AI: I can help with that.",
  "User: thanks",
].join("\n");

describe("countCustomerWords", () => {
  it("counts the customer's words and not the assistant's", () => {
    // 10 words on the first User: line, 1 on the second.
    expect(countCustomerWords(draft)).toBe(11);
  });

  // The whole reason this is a separate function rather than a
  // normalizeTranscript() call: normalizeTranscript strips the speaker
  // labels, so a draft run through it first counts BOTH speakers and every
  // call looks talkative.
  it("is far below the whole-transcript word count", () => {
    const everyWord = draft.replace(/^(?:AI|User):\s*/gm, "").split(/\s+/).length;
    expect(everyWord).toBeGreaterThan(20);
    expect(countCustomerWords(draft)).toBeLessThan(everyWord / 2);
  });

  it("is zero for a call the customer never spoke on", () => {
    // 15 of the 176 calls on file look like this: a draft exists, and it
    // holds no User: line at all.
    expect(countCustomerWords("AI: Hello?\nAI: Anyone there?")).toBe(0);
    expect(countCustomerWords(null)).toBe(0);
    expect(countCustomerWords(undefined)).toBe(0);
    expect(countCustomerWords("")).toBe(0);
  });

  // Punctuation folds to separators -- with one exception worth pinning
  // down rather than discovering later: `normalizeTranscript`'s punctuation
  // class is /[^\p{L}\p{N}\s'-]/u, which deliberately KEEPS the hyphen (it
  // has to, for "twenty-four"), so a dash left standing on its own survives
  // as a token. Four here, not three. Left alone on purpose: the rule
  // belongs to the shared normalizer that every WER number goes through,
  // and a caller who says one bare dash is not a call this floor decides.
  it("folds punctuation to separators, and keeps a standalone dash", () => {
    expect(countCustomerWords("User: yes, okay.")).toBe(2);
    expect(countCustomerWords("User: yes -- yes, okay.")).toBe(4);
    expect(countCustomerWords("User:    ")).toBe(0);
  });

  // normalizeTranscript folds number words into digit runs, and a spoken
  // phone number is the longest thing a caller says. Whatever it folds to,
  // the count must stay a count -- never 0, never one giant token.
  it("keeps a spoken number countable", () => {
    const spoken = countCustomerWords("User: my number is five five five one two three four");
    expect(spoken).toBeGreaterThan(0);
    expect(spoken).toBeLessThan(20);
  });
});
