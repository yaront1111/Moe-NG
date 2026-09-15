import { describe, expect, it } from "vitest";

import { describeRepositoryHolder } from "./repository-holder-words.js";

/** What a waiting node is told about the node that holds its repository (addendum 2026-09-15). */
describe("describeRepositoryHolder", () => {
  const holder = (phase: string, review: Partial<{ accepted: boolean; continuation: boolean; decisionDue: boolean; replanned: boolean }> = {}) =>
    describeRepositoryHolder({ accepted: false, continuation: false, decisionDue: false, nodeKey: "uai-r2-evidence-runtime",
      phase: phase as never, replanned: false, ...review });

  it.each([
    ["EXECUTING", "a coding seat is running"],
    ["VERIFYING", "the daemon verifier is checking its submission"],
    ["AWAITING_LANDING", "its accepted work is landing"],
    ["LANDING", "its accepted work is landing"],
    ["PUBLISHING", "a release is publishing"],
    ["CRITERION_VERIFYING", "criterion verification is running"],
    ["BLOCKED", "its seat's shutdown is unproven; Moe resumes it once the runtime that ran it has stopped (a restart does that)"],
  ])("names %s", (phase, reason) => {
    expect(holder(phase)).toBe(`held by node uai-r2-evidence-runtime: ${reason}`);
  });

  it("sends the operator to the escalation card when the holder waits for a decision", () => {
    expect(holder("RESERVED", { decisionDue: true }))
      .toBe("held by node uai-r2-evidence-runtime: it waits for your escalation decision in the control room");
  });

  it("says a replanned holder is released on its own once idle", () => {
    expect(holder("RESERVED", { decisionDue: true, replanned: true }))
      .toBe("held by node uai-r2-evidence-runtime: it was replanned; Moe releases it as soon as its seat has closed and its working tree is clean (commit or discard leftover changes)");
  });

  it("says a BLOCKED replanned holder is released once the runtime that ran it has stopped", () => {
    expect(holder("BLOCKED", { replanned: true }))
      .toBe("held by node uai-r2-evidence-runtime: it was replanned while its seat's shutdown was unproven; Moe releases it once the runtime that ran it has stopped (a restart does that)");
  });

  it("sends only an interrupted landing to a person", () => {
    expect(holder("BLOCKED", { accepted: true }))
      .toBe("held by node uai-r2-evidence-runtime: its landing was interrupted and its Git effect is unknown; an operator must reconcile it");
  });

  it("says why an ordinary holder keeps the repository between attempts", () => {
    expect(holder("RESERVED")).toBe("held by node uai-r2-evidence-runtime: it keeps uncommitted work between review attempts");
    expect(holder("RESERVED", { decisionDue: true, continuation: true }))
      .toBe("held by node uai-r2-evidence-runtime: it keeps uncommitted work between review attempts");
  });
});
