import { afterEach, describe, expect, it } from "vitest";

import { DELTA_CLASSIFICATIONS } from "./review-contracts.js";
import { readReviewLedger } from "./review-ledger.js";
import {
  CANONICALIZER_VERSION,
  PROJECT_ID,
  SUBJECT_REF,
  closeStores,
  decisionCount,
  decisionRows,
  deltaNode,
  driveRounds,
  envelope,
  finding,
  hex64,
  openStore,
  replanPayload,
  send,
  submitPayload,
} from "./review-test-fixtures.js";

/**
 * Delta approval: changed hashes, and every affected node in exactly one of INVALIDATED or
 * CARRY_FORWARD (DoD 3), plus the half of DoD 2 that design line 1101 words literally — old
 * plans, attempts, receipts and reviews remain readable AFTER A RE-PLAN.
 *
 * The classification is never computed here: `@moe/core`'s `evaluateCarryForward` owns design
 * 265's six conditions, and its own header states the division — "Core VALIDATES AND APPLIES a
 * supplied impact set; it never computes one. Design 265 makes the graph diff the daemon's job."
 * So the daemon iterates the affected nodes and the pure layer judges each one.
 */

afterEach(closeStores);

/** Restated as a literal: set equality against a list derived from production is vacuous. */
const EXPECTED_CLASSIFICATIONS = ["CARRY_FORWARD", "INVALIDATED"] as const;

function replan(
  store: ReturnType<typeof openStore>,
  nodes: readonly Record<string, unknown>[],
  expectedVersion: number,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof send> {
  return send(
    store,
    envelope("qualification.replan", expectedVersion, replanPayload(nodes, overrides), "cmd-replan"),
  );
}

describe("the classification vocabulary is closed", () => {
  it("offers exactly two outcomes, with no third silent arm", () => {
    expect(new Set<string>(DELTA_CLASSIFICATIONS)).toEqual(new Set<string>(EXPECTED_CLASSIFICATIONS));
    expect(DELTA_CLASSIFICATIONS).toHaveLength(2);
    expect(EXPECTED_CLASSIFICATIONS).toHaveLength(2);
  });
});

describe("delta approval classifies every affected node (DoD 3)", () => {
  it("classifies each node into exactly one bucket and leaves none unclassified", () => {
    const store = openStore();
    driveRounds(store, 1);
    const nodes = [
      deltaNode("node-1"),
      deltaNode("node-2", { targetHash: hex64("bb") }),
      deltaNode("node-3"),
      deltaNode("node-4", { dependenciesPresent: false }),
    ];

    const outcome = replan(store, nodes, 1);

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    const delta = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).delta;
    expect(delta).toBeDefined();
    // Non-zero: a classifier that returned nothing would otherwise pass every other assertion.
    expect(delta?.classifications).toHaveLength(4);
    expect(delta?.classifications.map((entry) => entry.nodeRef))
      .toEqual(["node-1", "node-2", "node-3", "node-4"]);
    for (const entry of delta?.classifications ?? []) {
      expect(EXPECTED_CLASSIFICATIONS).toContain(entry.classification);
    }
    // Every supplied node appears exactly once: none dropped, none classified twice.
    expect(new Set(delta?.classifications.map((entry) => entry.nodeRef)).size).toBe(4);
  });

  it("shows the changed hashes it decided on", () => {
    const store = openStore();
    driveRounds(store, 1);

    expect(replan(store, [deltaNode("node-2", { targetHash: hex64("bb") })], 1).ok).toBe(true);

    const entry = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).delta?.classifications[0];
    expect(entry?.sourceHash).toBe(hex64("aa"));
    expect(entry?.targetHash).toBe(hex64("bb"));
    expect(entry?.sourceHash).not.toBe(entry?.targetHash);
  });

  it("carries an unchanged node forward and invalidates the same node one byte changed", () => {
    const store = openStore();
    driveRounds(store, 1);

    // The adversarial pair. If both land in the same bucket the hash is not covering the content
    // it claims to, and every other assertion in this file would still pass.
    const outcome = replan(store, [
      deltaNode("node-same"),
      deltaNode("node-changed", { targetHash: hex64("ab") }),
    ], 1);

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    const entries = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).delta?.classifications ?? [];
    expect(entries.map((entry) => [entry.nodeRef, entry.classification])).toEqual([
      ["node-same", "CARRY_FORWARD"],
      ["node-changed", "INVALIDATED"],
    ]);
  });

  it("reports the pure layer's reason code for each invalidation, not a local one", () => {
    const store = openStore();
    driveRounds(store, 1);

    expect(replan(store, [
      deltaNode("node-hash", { targetHash: hex64("cc") }),
      deltaNode("node-policy", { policySliceUnchanged: false }),
      deltaNode("node-environment", { environmentClosureUnchanged: false }),
    ], 1).ok).toBe(true);

    const entries = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).delta?.classifications ?? [];
    expect(entries.map((entry) => entry.reasonCodes)).toEqual([
      ["CARRY_FORWARD_HASH_MISMATCH"],
      ["CARRY_FORWARD_POLICY_SLICE_CHANGED"],
      ["CARRY_FORWARD_ENVIRONMENT_CHANGED"],
    ]);
  });

  it("reports every failing condition for one node rather than only the first", () => {
    const store = openStore();
    driveRounds(store, 1);

    expect(replan(store, [
      deltaNode("node-many", { dependenciesPresent: false, targetHash: hex64("cc") }),
    ], 1).ok).toBe(true);

    const entry = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).delta?.classifications[0];
    expect(entry?.reasonCodes).toEqual([
      "CARRY_FORWARD_HASH_MISMATCH",
      "CARRY_FORWARD_DEPENDENCY_MISSING",
    ]);
    expect(entry?.classification).toBe("INVALIDATED");
  });
});

describe("a delta approval that cannot classify commits nothing", () => {
  it("refuses an empty node set rather than recording an empty classification", () => {
    const store = openStore();
    driveRounds(store, 1);
    const before = decisionCount(store);

    const outcome = replan(store, [], 1);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_DELTA_NODES_EMPTY");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).delta).toBeUndefined();
  });

  it("refuses a node named twice, which would put one node in two buckets", () => {
    const store = openStore();
    driveRounds(store, 1);
    const before = decisionCount(store);

    const outcome = replan(store, [
      deltaNode("node-1"),
      deltaNode("node-1", { targetHash: hex64("bb") }),
    ], 1);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_DELTA_NODE_DUPLICATED");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
  });

  it("surfaces the core's own refusal for unusable evidence and commits nothing", () => {
    const store = openStore();
    driveRounds(store, 1);
    const before = decisionCount(store);

    // A source hash that is not 64-hex: `evaluateCarryForward` refuses the whole input.
    const outcome = replan(store, [deltaNode("node-1", { sourceHash: "not-a-hash" })], 1);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("INPUT_INVALID");
    expect(outcome.refusedBy).toBe("CORE_POLICY");
    expect(decisionCount(store)).toBe(before);
  });

  it("refuses an unusable node without classifying the usable ones alongside it", () => {
    const store = openStore();
    driveRounds(store, 1);
    const before = decisionCount(store);

    // The good node comes FIRST: a handler that committed as it went would have written it.
    const outcome = replan(store, [
      deltaNode("node-good"),
      deltaNode("node-bad", { canonicalizerVersion: "" }),
    ], 1);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("INPUT_INVALID");
    expect(decisionCount(store)).toBe(before);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).delta).toBeUndefined();
  });

  it("invalidates a node hashed by a canonicalizer nobody supports", () => {
    const store = openStore();
    driveRounds(store, 1);

    // Every other condition holds and the hashes match, so the ONLY thing standing between this
    // node and a carry-forward is that its hash was produced by an unrecognised canonicalizer.
    // Unverifiable evidence must not gain authority: it invalidates rather than carrying.
    const outcome = replan(store, [deltaNode("node-1", { canonicalizerVersion: "other/9" })], 1, {
      supportedCanonicalizerVersions: [CANONICALIZER_VERSION],
    });

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    const entry = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).delta?.classifications[0];
    expect(entry?.classification).toBe("INVALIDATED");
    expect(entry?.reasonCodes).toEqual(["CARRY_FORWARD_CANONICALIZATION_UNKNOWN"]);
    // The control: the same node under a supported canonicalizer carries forward, so the case
    // is pinned to the version check rather than to some other failing condition.
    expect(entry?.sourceHash).toBe(entry?.targetHash);
  });

  it("refuses a re-plan before any round has been recorded", () => {
    const store = openStore();

    const outcome = replan(store, [deltaNode("node-1")], 0);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_REPLAN_WITHOUT_ROUND");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(0);
  });
});

describe("old reviews remain readable after a re-plan (DoD 2, design line 1101)", () => {
  it("leaves every earlier round byte-identical once a successor plan exists", () => {
    const store = openStore();
    driveRounds(store, 2);
    const roundsBefore = decisionRows(store);
    expect(roundsBefore).toHaveLength(2);

    expect(replan(store, [deltaNode("node-1", { targetHash: hex64("bb") })], 2).ok).toBe(true);

    const rowsAfter = decisionRows(store);
    expect(rowsAfter).toHaveLength(3);
    // The re-plan appended. It rewrote nothing: both earlier rows are byte-for-byte what they
    // were, which is the assertion a rewrite-in-place would fail while "a new row appeared"
    // would still pass.
    expect(rowsAfter.slice(0, 2)).toEqual(roundsBefore);

    const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
    expect(ledger.rounds).toHaveLength(2);
    expect(ledger.lineage.records.map((record) => record.round)).toEqual([1, 2]);
    expect(ledger.lineage.unsuccessfulRounds).toBe(2);
  });

  it("keeps the round counter intact across the re-plan rather than restarting it", () => {
    const store = openStore();
    driveRounds(store, 2);

    expect(replan(store, [deltaNode("node-1")], 2).ok).toBe(true);
    const next = send(store, envelope("review.submit", 3, submitPayload(3, [
      finding({ ruleId: "rule-3", subject: { kind: "NODE", locator: "node-gamma" } }),
    ]), "cmd-round-3"));

    // A re-plan that reset the counter would let a third rejection look like a first, and the
    // escalation cap would never be reached. The third round must count as the third.
    expect(next.ok, next.ok ? "" : next.code).toBe(true);
    const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
    expect(ledger.lineage.unsuccessfulRounds).toBe(3);
    expect(ledger.rounds[2]?.routing.route).toBe("ESCALATE");
  });
});
