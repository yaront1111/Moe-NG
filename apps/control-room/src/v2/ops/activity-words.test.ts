import { describe, expect, it } from "vitest";

import {
  decisionWords, kindWords, previewCodeSaid, previewCodeWords,
} from "./activity-words.js";

/**
 * The four codes are the daemon's own closed roster (`PREVIEW_CODE_LAYERS` in
 * preview-contracts.ts). They are transcribed here BY HAND on purpose: deriving them from a
 * daemon constant would make the comparison a tautology, and the browser cannot import daemon
 * source anyway. A fifth code the daemon mints must still render - that is the last arm.
 */
const DAEMON_CODES = [
  "PREVIEW_COMMAND_MISSING",
  "PREVIEW_DECISION_INVALID",
  "PREVIEW_GOAL_NOT_LANDED",
  "PREVIEW_START_TIMEOUT",
] as const;

describe("preview refusal codes, as operator words", () => {
  it("says what happened AND what to do about it, for PREVIEW_COMMAND_MISSING", () => {
    expect(previewCodeWords("PREVIEW_COMMAND_MISSING")).toBe(
      "The preview command is not installed on this machine, so there was nothing to run."
      + " Install it, or set the command this project previews with, then start the preview"
      + " again.",
    );
  });

  it("says what happened AND what to do about it, for PREVIEW_START_TIMEOUT", () => {
    expect(previewCodeWords("PREVIEW_START_TIMEOUT")).toBe(
      "The product did not answer before the daemon stopped waiting. It may still be starting,"
      + " or it may be failing on launch - start the preview again, and read the board if it"
      + " times out twice.",
    );
  });

  it("gives every rostered code a real sentence, never an echo of the code", () => {
    for (const code of DAEMON_CODES) {
      const words = previewCodeWords(code);
      expect(words, code).not.toBe(code);
      expect(words.length, code).toBeGreaterThan(40);
      expect(words.endsWith("."), code).toBe(true);
    }
  });

  it("renders an UNKNOWN code VERBATIM rather than blank", () => {
    for (const code of ["PREVIEW_SOMETHING_NEW", "TOTALLY_UNRELATED", "x"]) {
      expect(previewCodeWords(code), code).toBe(code);
      expect(previewCodeSaid(code), code).toBe(code);
    }
    expect(previewCodeWords("")).toBe("");
  });

  it("shows the code ALONGSIDE the words, never instead of them", () => {
    const said = previewCodeSaid("PREVIEW_GOAL_NOT_LANDED");
    expect(said).toContain(previewCodeWords("PREVIEW_GOAL_NOT_LANDED"));
    expect(said).toContain("(PREVIEW_GOAL_NOT_LANDED)");
  });

  it("does not answer from a prototype key, which would invent a sentence", () => {
    for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(previewCodeWords(key), key).toBe(key);
    }
  });
});

describe("preview decisions, as operator words", () => {
  it("names the two verdicts the daemon admits, and echoes any other", () => {
    expect(decisionWords("preview.decide", "APPROVE")).toBe("approved the running product");
    expect(decisionWords("preview.decide", "REJECT"))
      .toBe("sent the running product back with findings");
    expect(decisionWords("preview.decide", "MAYBE")).toBe("decided the preview: MAYBE");
  });

  it("falls back to the kind's own words when the record carries no verdict", () => {
    expect(decisionWords("preview.decide", null)).toBe("decided the preview");
    expect(kindWords("preview.start")).toBe("started a preview of the product");
  });

  it("still renders a kind this table has never heard of, as the daemon spelled it", () => {
    expect(kindWords("preview.teleport")).toBe("preview.teleport");
  });
});
