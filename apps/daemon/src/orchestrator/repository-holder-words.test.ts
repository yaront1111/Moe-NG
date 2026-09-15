import { describe, expect, it } from "vitest";

import { describeRepositoryHolder } from "./repository-holder-words.js";

/** What a waiting node is told about the node that holds its repository (addendum 2026-09-15). */
describe("describeRepositoryHolder", () => {
  const holder = (phase: string, review: Partial<{ continuation: boolean; decisionDue: boolean; replanned: boolean }> = {}) =>
    describeRepositoryHolder({ continuation: false, decisionDue: false, nodeKey: "uai-r2-evidence-runtime",
      phase: phase as never, replanned: false, ...review });

  it.each([
    ["EXECUTING", "a coding seat is running"],
    ["VERIFYING", "the daemon verifier is checking its submission"],
    ["AWAITING_LANDING", "its accepted work is landing"],
    ["LANDING", "its accepted work is landing"],
    ["PUBLISHING", "a release is publishing"],
    ["CRITERION_VERIFYING", "criterion verification is running"],
    ["BLOCKED", "it is blocked until an operator recovers the repository (moe recover-review)"],
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

  it("names the recovery command only when a replanned holder's seat shutdown was unproven", () => {
    expect(holder("BLOCKED", { replanned: true }))
      .toBe("held by node uai-r2-evidence-runtime: it was replanned while its seat's shutdown was unproven; run moe recover-replan to release it");
  });

  it("says why an ordinary holder keeps the repository between attempts", () => {
    expect(holder("RESERVED")).toBe("held by node uai-r2-evidence-runtime: it keeps uncommitted work between review attempts");
    expect(holder("RESERVED", { decisionDue: true, continuation: true }))
      .toBe("held by node uai-r2-evidence-runtime: it keeps uncommitted work between review attempts");
  });
});
