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

  /**
   * GATE 3 ON THE RUNS FEED. Runs shows what happened, so the release receipt has to read as
   * an event a person recognises rather than as a raw kind. The verdicts are the only two the
   * command admits (`release-decide-command.ts:46` refuses anything else), and a third still
   * prints the verdict rather than swallowing it.
   */
  it("words the release decision and its receipts", () => {
    expect(decisionWords("release.decide", "APPROVE")).toBe("released the work to users");
    expect(decisionWords("release.decide", "REJECT")).toBe("held the release back");
    expect(decisionWords("release.decide", "LATER")).toBe("decided the release: LATER");
    expect(decisionWords("release.decide", null)).toBe("decided the release");
    // The receipt kinds the daemon writes beside the decision, so the feed shows the release
    // itself and the evidence it was taken over, not two unreadable internal kinds.
    expect(kindWords("internal.release.receipt")).toBe("recorded the release");
    expect(kindWords("internal.release.dossier")).toBe("recorded the release evidence");
  });
});

describe("deploy receipts, as operator words", () => {
  const RECEIPT = "internal.deployment.deploy_receipt";

  it("says DEPLOYED and REFUSED in words that cannot be mistaken for each other", () => {
    // The whole point of the deploy verdict: a feed that rendered both as "recorded the deploy"
    // would hide the only event an operator is scanning this list for. Asserted as a DIFFERENCE
    // as well as by value, so a future edit that collapses the two reds here rather than
    // shipping a feed in which a failed deploy looks like a successful one.
    const deployed = decisionWords(RECEIPT, "DEPLOYED");
    const refused = decisionWords(RECEIPT, "REFUSED");
    expect(deployed).toBe("deployed the product to the environment");
    expect(refused).toBe("could not deploy: the environment was left as it was");
    expect(deployed).not.toBe(refused);
  });

  it("prints an unknown verdict rather than swallowing it, and falls back to the kind words", () => {
    expect(decisionWords(RECEIPT, "PARTIAL")).toBe("recorded the deploy: PARTIAL");
    expect(decisionWords(RECEIPT, null)).toBe("recorded the deploy");
    expect(kindWords(RECEIPT)).toBe("recorded the deploy");
    expect(kindWords("deployment.deploy")).toBe("asked to deploy an environment");
    expect(kindWords("deployment.set_target")).toBe("bound where an environment deploys to");
  });

  it("carries no apostrophe, so the scheduler boundary scan cannot red on these strings", () => {
    // Every other word in this table is read straight into JSX; the scan reds on an apostrophe
    // there, so the constraint is asserted rather than left to review.
    for (const words of [
      decisionWords(RECEIPT, "DEPLOYED"), decisionWords(RECEIPT, "REFUSED"),
      decisionWords(RECEIPT, null), kindWords("deployment.deploy"), kindWords("deployment.set_target"),
    ]) {
      expect(words).not.toContain("'");
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7e]+$/u.test(words)).toBe(true);
    }
  });
});

/**
 * MIGRATION RECEIPTS ON THE DECISION FEED. The kind is transcribed BY HAND here
 * (`migration-receipt.ts:10`) for the same reason the deploy kind is: this package must not take
 * a build dependency on the daemon's sources, so the literal is the contract.
 *
 * APPLIED, REFUSED and REVERTED are three different things to have happened to a schema. A feed
 * that rendered all three as the kind's own words would say a migration was RECORDED while never
 * saying whether the database moved - which is the one question an operator has after an incident.
 */
describe("migration receipts, as operator words", () => {
  const RECEIPT = "internal.repository.migration_receipt";

  it("says APPLIED, REFUSED and REVERTED in three sentences sharing no leading word", () => {
    const applied = decisionWords(RECEIPT, "APPLIED");
    const refused = decisionWords(RECEIPT, "REFUSED");
    const reverted = decisionWords(RECEIPT, "REVERTED");
    expect(applied).toBe("applied the migrations to this environment");
    expect(refused).toBe("could not migrate: read the receipt for what the schema did");
    expect(reverted).toBe("reverted the last migration batch");
    // Pairwise DISTINCT, so a future edit collapsing any two reds here rather than shipping a
    // feed in which a refused migration reads like an applied one.
    expect(new Set([applied, refused, reverted]).size).toBe(3);
    // And distinct at a GLANCE: a truncated row shows the leading word, so three receipts that
    // all began "recorded" would be indistinguishable in exactly the place they are scanned.
    const leading = [applied, refused, reverted].map((words) => words.split(" ")[0]);
    expect(new Set(leading).size).toBe(3);
  });

  it("never lets a REFUSED migration read as a successful one", () => {
    const refused = decisionWords(RECEIPT, "REFUSED");
    // The failure this arm exists for: a refusal sentence that still contains the applied word
    // would be read as success by someone scanning the column.
    expect(refused).not.toContain("applied");
    expect(refused).not.toContain("reverted");
    expect(decisionWords(RECEIPT, "APPLIED")).not.toContain("could not");
  });

  it("prints an unrostered verdict VERBATIM rather than swallowing it", () => {
    // The daemon can mint a fourth outcome without this file being edited; it must still print,
    // and it must NOT fall through to a success phrase.
    expect(decisionWords(RECEIPT, "PARTIAL")).toBe("recorded the migration: PARTIAL");
    expect(decisionWords(RECEIPT, "PARTIAL")).toContain("PARTIAL");
    expect(decisionWords(RECEIPT, "SOMETHING_NEW")).toBe("recorded the migration: SOMETHING_NEW");
  });

  it("falls back to the kind's own words when the record carries no verdict", () => {
    expect(decisionWords(RECEIPT, null)).toBe("recorded the migration");
    expect(kindWords(RECEIPT)).toBe("recorded the migration");
    // Not an echo of the raw kind: an unworded kind is what this table exists to prevent.
    expect(kindWords(RECEIPT)).not.toBe(RECEIPT);
  });

  it("carries no apostrophe, so the scheduler boundary scan cannot red on these strings", () => {
    for (const words of [
      decisionWords(RECEIPT, "APPLIED"), decisionWords(RECEIPT, "REFUSED"),
      decisionWords(RECEIPT, "REVERTED"), decisionWords(RECEIPT, "PARTIAL"),
      decisionWords(RECEIPT, null), kindWords(RECEIPT),
    ]) {
      expect(words).not.toContain("'");
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7e]+$/u.test(words)).toBe(true);
    }
  });

  it("names no connection value, no database url and no backup path", () => {
    // Epic rail 3 at the one seam where a receipt's words are composed: the feed says WHAT
    // happened to WHICH environment and nothing that could carry a credential or a filesystem
    // location, so a screenshot of the board is never a leak.
    for (const verdict of ["APPLIED", "REFUSED", "REVERTED", "PARTIAL", null]) {
      const words = decisionWords(RECEIPT, verdict);
      expect(words).not.toContain("postgres://");
      expect(words).not.toContain("DATABASE_URL");
      expect(words).not.toContain(".moe-next");
      expect(words).not.toMatch(/[A-Za-z]:\|\//u);
    }
  });
});
