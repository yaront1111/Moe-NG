import { afterEach, describe, expect, it } from "vitest";

import { missingCarryForwardFacts } from "../planning/carry-forward-evidence.js";
import { DELTA_CLASSIFICATIONS } from "./review-contracts.js";
import { readReviewLedger } from "./review-ledger.js";
import {
  PROJECT_ID,
  SUBJECT_REF,
  closeStores,
  decisionCount,
  decisionRows,
  deltaNode,
  deltaNodeWithCallerEvidence,
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
 * Delta approval keeps working conservatively when carry authority is unavailable: every affected
 * node is INVALIDATED, while old plans, attempts, receipts and reviews remain readable.
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

describe("task-757823ca caller-supplied carry authority reproduction", () => {
  it("refuses the exact payload that formerly granted caller-supplied carry", () => {
    const store = openStore();
    driveRounds(store, 1);
    const callerVersion = "caller-canonicalizer/999";
    const callerHash = hex64("de");
    expect(callerVersion).not.toBe("moe-canonical-json/1");

    const outcome = replan(store, [deltaNodeWithCallerEvidence("caller-authority", {
      canonicalizerVersion: callerVersion,
      dependenciesPresent: true,
      environmentClosureUnchanged: true,
      policySliceUnchanged: true,
      predecessorResultUnchanged: true,
      sourceHash: callerHash,
      targetHash: callerHash,
    })], 1, { supportedCanonicalizerVersions: [callerVersion] });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected caller carry authority to be refused");
    expect(outcome.code).toBe("REVIEW_DELTA_EVIDENCE_UNSUPPLIABLE");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
  });
});

const CALLER_AUTHORITY_REFUSAL_CASES = Object.freeze([
  Object.freeze({
    label: "node evidence",
    nodes: Object.freeze([deltaNodeWithCallerEvidence("evidence-node")]),
    overrides: Object.freeze({}),
  }),
  Object.freeze({
    label: "payload canonicalizer allow-list",
    nodes: Object.freeze([deltaNode("allow-list-node")]),
    overrides: Object.freeze({ supportedCanonicalizerVersions: ["caller/1"] }),
  }),
]);

describe("task-757823ca caller-authority refusal divergence", () => {
  it("pins the dedicated ingress guard for both caller authority channels", () => {
    // Every competing fence passes: each payload has all typed refs, one plain node with a
    // non-empty unique nodeRef, a readable real round, and expectedVersion 1. Therefore neither
    // payload/empty/duplicate nor lineage/without-round/stale can answer first. The authority
    // rejection is deliberately outside parseNodes so REVIEW_PAYLOAD_INVALID cannot steal it.
    expect(CALLER_AUTHORITY_REFUSAL_CASES).toHaveLength(2);
    expect(CALLER_AUTHORITY_REFUSAL_CASES.length).toBeGreaterThan(0);
    let generated = 0;
    for (const testCase of CALLER_AUTHORITY_REFUSAL_CASES) {
      generated += 1;
      const store = openStore();
      driveRounds(store, 1);
      const before = decisionCount(store);

      const outcome = replan(store, testCase.nodes, 1, testCase.overrides);

      expect(outcome.ok, testCase.label).toBe(false);
      if (outcome.ok) throw new Error(`${testCase.label}: expected refusal`);
      expect(outcome.code, testCase.label).toBe("REVIEW_DELTA_EVIDENCE_UNSUPPLIABLE");
      expect(outcome.refusedBy, testCase.label).toBe("DAEMON_INGRESS");
      expect(decisionCount(store), testCase.label).toBe(before);
    }
    expect(generated).toBe(CALLER_AUTHORITY_REFUSAL_CASES.length);
  });
});

describe("delta approval classifies every affected node (DoD 3)", () => {
  it("classifies each node into exactly one bucket and leaves none unclassified", () => {
    const store = openStore();
    driveRounds(store, 1);
    const nodes = ["node-1", "node-2", "node-3", "node-4"].map(deltaNode);

    const outcome = replan(store, nodes, 1);

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    const delta = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).delta;
    expect(delta).toBeDefined();
    // Non-zero: a classifier that returned nothing would otherwise pass every other assertion.
    expect(delta?.classifications).toHaveLength(4);
    expect(delta?.classifications.map((entry) => entry.nodeRef))
      .toEqual(["node-1", "node-2", "node-3", "node-4"]);
    for (const entry of delta?.classifications ?? []) {
      expect(entry.classification).toBe("INVALIDATED");
      expect(entry.sourceHash).toBe("");
      expect(entry.targetHash).toBe("");
    }
    // Every supplied node appears exactly once: none dropped, none classified twice.
    expect(new Set(delta?.classifications.map((entry) => entry.nodeRef)).size).toBe(4);
  });

  it("records the server-owned unreadable-fact vocabulary for every node", () => {
    const store = openStore();
    driveRounds(store, 1);

    expect(replan(store, [deltaNode("node-1"), deltaNode("node-2")], 1).ok).toBe(true);

    const entries = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).delta?.classifications ?? [];
    const missing = missingCarryForwardFacts({
      dependenciesPresent: undefined, environmentClosureUnchanged: undefined,
      policySliceUnchanged: undefined, predecessorResultUnchanged: undefined,
    });
    expect(missing).toHaveLength(4);
    const expectedReasons = ["CARRY_EVIDENCE_FACT_UNREADABLE", ...missing];
    expect(entries.map((entry) => entry.reasonCodes)).toEqual([expectedReasons, expectedReasons]);
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
      deltaNode("node-1"),
    ], 1);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_DELTA_NODE_DUPLICATED");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
  });

  it("refuses caller evidence before inspecting its malformed hash", () => {
    const store = openStore();
    driveRounds(store, 1);
    const before = decisionCount(store);

    const outcome = replan(store, [
      deltaNodeWithCallerEvidence("node-1", { sourceHash: "not-a-hash" }),
    ], 1);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_DELTA_EVIDENCE_UNSUPPLIABLE");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
  });

  it("refuses caller evidence without classifying an earlier clean node", () => {
    const store = openStore();
    driveRounds(store, 1);
    const before = decisionCount(store);

    // The good node comes FIRST: a handler that committed as it went would have written it.
    const outcome = replan(store, [
      deltaNode("node-good"),
      deltaNodeWithCallerEvidence("node-bad"),
    ], 1);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("REVIEW_DELTA_EVIDENCE_UNSUPPLIABLE");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).delta).toBeUndefined();
  });

  it("refuses a caller-supplied canonicalizer allow-list without committing", () => {
    const store = openStore();
    driveRounds(store, 1);
    const before = decisionCount(store);

    const outcome = replan(store, [deltaNode("node-1")], 1, {
      supportedCanonicalizerVersions: ["caller-canonicalizer/999"],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected caller allow-list refusal");
    expect(outcome.code).toBe("REVIEW_DELTA_EVIDENCE_UNSUPPLIABLE");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
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

    expect(replan(store, [deltaNode("node-1")], 2).ok).toBe(true);

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
