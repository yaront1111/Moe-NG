import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTIVATION_WORLD_NODE_KEY } from "../activation/activation-world-fixtures.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { GOAL_ID, PROJECT_ID, decisionCount, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { readReviewLedger } from "../review/review-ledger.js";
import type { AcceptanceRecord } from "../review/review-read-model.js";
import {
  deltaNode, envelope as reviewEnvelope, replanPayload, send as reviewSend,
} from "../review/review-test-fixtures.js";
import {
  cleanupGoalClosureFixtures,
  closeGoalThroughCommandPath,
  seedLandingReceipt,
  seedProvenAttempt,
  seedReviewAcceptance,
  seedVerifiedNode,
} from "./goal-closure-test-fixtures.js";
import { composeClosure, readLiveNodeEvidence } from "./goal-live-evidence.js";
import type { ClosureLeg } from "./goal-live-evidence.js";
import { qualifyGoalClosure } from "./goal-qualification.js";
import { indexDurableReceipts } from "./goal-qualification-reads.js";
import * as qualificationReads from "./goal-qualification-reads.js";
import { createScopedGoalWorld } from "./goal-scoped-test-fixtures.js";
import { createScopedCloseWorld } from "./goal-scoped-close-test-fixtures.js";

vi.mock("../../../../packages/runner/src/platform/windows/windows-broker-path.js", async (original) => {
  const actual = await original<{ resolveBrokerBinary(): unknown }>();
  return { ...actual, resolveBrokerBinary: () => process.env["MOE_TEST_APPROVED_BROKER"] ?? actual.resolveBrokerBinary() };
});

/**
 * THE LIVE LEG of `goal.close` qualification: the evidence the RUNNING loop actually produces.
 *
 * A node the live loop finished carries a review acceptance, the verifier receipt that
 * acceptance names, and — when landing is on — a landing receipt from the wrapper's lander. It
 * carries NO Foundation verification receipt, because nothing in the live path mints one. Before
 * this module, `qualify` demanded that Foundation receipt for every approved node and refused
 * `GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT`, so no live goal could ever close.
 *
 * Scoped worlds use the real source, contract, compiler and approval writers. Review acceptance
 * and landing receipts also use production writers. Composition unit cases explicitly supply
 * their leg inputs; the activation reader fault arm labels its injected historical input.
 * `qualifyGoalClosure` is a pure read, so the cases snapshot and re-read durable state.
 *
 * Foundation-only qualification is covered in `goal-qualification.test.ts`. These Foundation
 * worlds exercise leg separation, the retired mixed path and historical activation ambiguity.
 */

// `seedVerifiedNode` runs the shipped attempt service, whose completion authority pins the
// Claude runtime to an absolute local-drive Windows path. Foundation cases and contained
// criterion execution therefore run only where production can reach those boundaries.
const WINDOWS_ONLY = process.platform === "win32";
const GOAL_WORLD_BOUND_MS = 120_000;

interface StoreSnapshot {
  readonly decisions: number;
  readonly goal: unknown;
  readonly goalEvents: number;
}

function snapshot(store: SqliteEventStore): StoreSnapshot {
  return {
    decisions: decisionCount(store),
    goal: readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID)?.result,
    goalEvents: store.readEvents(GOAL_ID).length,
  };
}

function expectUnmoved(store: SqliteEventStore, before: StoreSnapshot): void {
  expect(decisionCount(store)).toBe(before.decisions);
  expect(readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID)?.result)
    .toEqual(before.goal);
  expect(store.readEvents(GOAL_ID)).toHaveLength(before.goalEvents);
}

function expectRefusedExactly(
  outcome: ReturnType<typeof qualifyGoalClosure>, code: string, message: string,
): void {
  expect(outcome).toMatchObject({ code, layer: "DAEMON_PREREQUISITE", message, ok: false });
}

/** The approved + accepted world the live loop leaves behind, with no Foundation receipt. */
function approvedWorld(localKeys: readonly string[] = ["node-1"]) {
  const world = createScopedGoalWorld(localKeys);
  for (const nodeRef of world.nodeRefs) seedReviewAcceptance(world.store, nodeRef);
  return { ...world, subjectRef: world.nodeRefs[0]! };
}

function acceptanceOf(store: SqliteEventStore, nodeRef: string): AcceptanceRecord {
  const accepted = readReviewLedger(store, PROJECT_ID, nodeRef).accepted;
  if (accepted === undefined) throw new Error(`no acceptance was recorded for ${nodeRef}`);
  return accepted;
}

function foundationLeg(store: SqliteEventStore, nodeRef: string): ClosureLeg {
  const indexed = indexDurableReceipts(store, new Set([nodeRef]));
  if (!indexed.ok) throw new Error(indexed.code);
  const receipt = indexed.index.get(nodeRef);
  if (receipt === undefined) throw new Error("Foundation receipt missing");
  return { accepted: acceptanceOf(store, nodeRef), leg: "FOUNDATION", nodeRef, receipt };
}

/** A durable re-plan on the node, through the shipped `qualification.replan` handler. */
function replan(store: SqliteEventStore, nodeRef: string): void {
  const version = readReviewLedger(store, PROJECT_ID, nodeRef).version;
  const outcome = reviewSend(store, {
    ...reviewEnvelope("qualification.replan", version,
      replanPayload([deltaNode(nodeRef)], { subjectRef: nodeRef }), `cmd-replan-${nodeRef}`),
    projectId: PROJECT_ID,
  });
  if (!outcome.ok) throw new Error(`replan fixture refused: ${outcome.code}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanupGoalClosureFixtures();
});

describe("the live leg closes on acceptance, verifier receipt and landing", () => {
  it("qualifies an approved, accepted node whose landing COMMITTED", () => {
    const { store, subjectRef: nodeRef } = approvedWorld();
    seedLandingReceipt(store, nodeRef, "COMMITTED");
    const before = snapshot(store);

    const qualified = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expect(qualified.ok).toBe(true);
    if (!qualified.ok) return;
    expect(qualified.legs).toEqual({ [nodeRef]: "LIVE" });
    // The core's witness key roster is EXACT (`goal-validation.ts` CLOSURE_KEYS/ZERO_KEYS): the
    // leg tag lives in the derived-ref preimages and in the sibling `legs` field, never inside a
    // witness, so a witness that grew a key would refuse at the core rather than close.
    expect(Object.keys(qualified.closureWitness).sort()).toStrictEqual([
      "acceptanceClosureRef", "completionNodeAcceptedRef", "noCurrentPreparationGeneration",
      "noPendingDraftOrSupersession", "obligationsHoldRef", "truthClass",
    ]);
    expect(Object.keys(qualified.zeroAuthorityWitness).sort())
      .toStrictEqual(["truthClass", "zeroAuthorityProofRef"]);
    expect(qualified.closureWitness["truthClass"]).toBe("DAEMON_VERIFIED");
    expect(qualified.zeroAuthorityWitness["truthClass"]).toBe("DAEMON_VERIFIED");
    expectUnmoved(store, before);
  });

  it("qualifies a node whose landing refused NOTHING_TO_COMMIT", () => {
    const { store, subjectRef: nodeRef } = approvedWorld();
    seedLandingReceipt(store, nodeRef, { refusalCode: "NOTHING_TO_COMMIT" });
    const before = snapshot(store);

    const qualified = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expect(qualified.ok).toBe(true);
    if (!qualified.ok) return;
    expect(qualified.legs).toEqual({ [nodeRef]: "LIVE" });
    // The lander's own legitimate empty-diff refusal, read back as the receipt production wrote.
    const live = readLiveNodeEvidence(store, PROJECT_ID, nodeRef, acceptanceOf(store, nodeRef));
    expect(live).toMatchObject({ landing: "NOTHING_TO_COMMIT", leg: "LIVE" });
    expectUnmoved(store, before);
  });

  it("refuses NOT_PASSED naming the landing code when the landing refused for any other reason", () => {
    const { store, subjectRef: nodeRef } = approvedWorld();
    seedLandingReceipt(store, nodeRef, { refusalCode: "GIT_COMMIT_FAILED" });
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    // No new refusal code is minted for this: the roster has five pinned consumers, so the
    // MESSAGE is what tells this guard apart from the Foundation verdict guard that shares it.
    expectRefusedExactly(outcome, "GOAL_CLOSE_VERIFICATION_NOT_PASSED",
      "the landing receipt refused GIT_COMMIT_FAILED");
    expectUnmoved(store, before);
  });

  it("admits a node with no landing receipt at all and records the landing as NONE", () => {
    const { store, subjectRef: nodeRef } = approvedWorld();
    // Landing is a wrapper knob (MOE_NODE_LANDING=0) and pre-feature nodes have none, so an
    // ABSENT landing is admitted; a PRESENT one is checked strictly by the arms above.
    const before = snapshot(store);

    const live = readLiveNodeEvidence(store, PROJECT_ID, nodeRef, acceptanceOf(store, nodeRef));
    const qualified = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expect(live).toMatchObject({ landing: "NONE", landingReceiptId: null, leg: "LIVE" });
    expect(qualified.ok).toBe(true);
    if (!qualified.ok) return;
    expect(qualified.legs).toEqual({ [nodeRef]: "LIVE" });
    expectUnmoved(store, before);
  });

  it("refuses ACCEPTANCE_REQUIRED for an approved node the live loop never accepted", () => {
    const { store } = createScopedGoalWorld();
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefusedExactly(outcome, "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
      "no durable review acceptance names this approved node");
    expectUnmoved(store, before);
  });

  it("refuses PACKAGE_STALE on the live leg when a durable re-plan supersedes the acceptance", () => {
    const { store, subjectRef: nodeRef } = approvedWorld();
    seedLandingReceipt(store, nodeRef, "COMMITTED");
    replan(store, nodeRef);
    // The precondition, measured: the re-plan really is durable on this node's ledger.
    expect(readReviewLedger(store, PROJECT_ID, nodeRef).delta).toBeDefined();
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefusedExactly(outcome, "GOAL_CLOSE_REVIEW_PACKAGE_STALE",
      "a durable re-plan supersedes the accepted review package");
    expectUnmoved(store, before);
  });

  /**
   * A landing left over from an EARLIER verifier receipt is not evidence about the accepted
   * round: it attests bytes the acceptance never saw. Admitting it would let a stale commit
   * stand in for the one the review accepted.
   */
  it("refuses PACKAGE_STALE when the landing attests a different verifier receipt", () => {
    const { store, subjectRef: nodeRef } = approvedWorld();
    const foreign = "f".repeat(64);
    expect(foreign).not.toBe(acceptanceOf(store, nodeRef).verifierReceiptId);
    seedLandingReceipt(store, nodeRef, "COMMITTED", foreign);
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefusedExactly(outcome, "GOAL_CLOSE_REVIEW_PACKAGE_STALE",
      "the landing receipt attests a different verifier receipt");
    expectUnmoved(store, before);
  });

  /** Two landings for one node: the ledger fold keeps the LAST decision, so the LATEST wins. */
  it("reads the latest landing receipt when a node carries more than one", () => {
    const { store, subjectRef: nodeRef } = approvedWorld();
    const stale = "e".repeat(64);
    seedLandingReceipt(store, nodeRef, { refusalCode: "GIT_COMMIT_FAILED" }, stale);
    seedLandingReceipt(store, nodeRef, "COMMITTED");

    const live = readLiveNodeEvidence(store, PROJECT_ID, nodeRef, acceptanceOf(store, nodeRef));

    expect(live).toMatchObject({ landing: "COMMITTED", leg: "LIVE" });
    expect(qualifyGoalClosure(store, PROJECT_ID, GOAL_ID).ok).toBe(true);
  });

  /**
   * A fault reading the LANDING evidence must be answered by the landing leg, not by
   * `qualifyGoalClosure`'s outer catch: that catch names the acceptance, so the fault would be
   * reported as the wrong prerequisite. A closed store is the cheapest real fault there is, and
   * it proves the leg fails CLOSED — an unreadable landing is never read as an absent one.
   */
  it("refuses NOT_PASSED, without throwing, when the durable landing evidence is unreadable", () => {
    const { store, subjectRef: nodeRef } = approvedWorld();
    seedLandingReceipt(store, nodeRef, "COMMITTED");
    const accepted = acceptanceOf(store, nodeRef);
    store.close();

    const outcome = readLiveNodeEvidence(store, PROJECT_ID, nodeRef, accepted);

    expect(outcome).toMatchObject({
      code: "GOAL_CLOSE_VERIFICATION_NOT_PASSED",
      layer: "DAEMON_PREREQUISITE",
      message: "the durable landing evidence could not be read",
      ok: false,
    });
  });

  it.runIf(WINDOWS_ONLY)("refuses a legacy MIXED goal whose raw live node has no Foundation receipt", async () => {
    const store = openStore();
    await seedVerifiedNode(store, ACTIVATION_WORLD_NODE_KEY, [ACTIVATION_WORLD_NODE_KEY, "node-2"]);
    seedReviewAcceptance(store, ACTIVATION_WORLD_NODE_KEY);
    seedReviewAcceptance(store, "node-2");
    seedLandingReceipt(store, "node-2", "COMMITTED");
    const before = snapshot(store);

    const qualified = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefusedExactly(qualified, "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
      "no Foundation receipt proves the legacy approved node");
    expectUnmoved(store, before);
  }, GOAL_WORLD_BOUND_MS);

  it.runIf(WINDOWS_ONLY)("composes explicitly supplied mixed legs without conflating their evidence", async () => {
    const foundationStore = openStore();
    await seedVerifiedNode(foundationStore, ACTIVATION_WORLD_NODE_KEY);
    seedReviewAcceptance(foundationStore, ACTIVATION_WORLD_NODE_KEY);
    const { store, subjectRef: nodeRef } = approvedWorld(["node-2"]);
    seedLandingReceipt(store, nodeRef, "COMMITTED");
    const before = snapshot(store); const foundationBefore = snapshot(foundationStore);
    const live = readLiveNodeEvidence(store, PROJECT_ID, nodeRef, acceptanceOf(store, nodeRef));
    if ("ok" in live) throw new Error(live.code);

    // Composition unit inputs span two independently proved worlds; this does not authorize
    // a mixed-era goal. The integration regression above explicitly refuses that legacy path.
    const qualified = composeClosure("unit-mixed-approval", [ACTIVATION_WORLD_NODE_KEY, nodeRef],
      [foundationLeg(foundationStore, ACTIVATION_WORLD_NODE_KEY), live], 1);

    expect(qualified.legs).toEqual({ [ACTIVATION_WORLD_NODE_KEY]: "FOUNDATION", [nodeRef]: "LIVE" });
    expectUnmoved(store, before); expectUnmoved(foundationStore, foundationBefore);
  }, GOAL_WORLD_BOUND_MS);

  it.runIf(WINDOWS_ONLY)("refuses AUTHORITY_REMAINS when a legacy activation names a compiled live node", async () => {
    const source = openStore();
    await seedProvenAttempt(source, ACTIVATION_WORLD_NODE_KEY, [ACTIVATION_WORLD_NODE_KEY]);
    const accounts = qualificationReads.accountDurableActivations(source, PROJECT_ID);
    expect(accounts).toHaveLength(1);
    expect(accounts?.[0]?.nodeKey).toBe(ACTIVATION_WORLD_NODE_KEY);
    const { store, subjectRef: nodeRef } = approvedWorld([ACTIVATION_WORLD_NODE_KEY]);
    seedLandingReceipt(store, nodeRef, "COMMITTED");
    expect(qualifyGoalClosure(store, PROJECT_ID, GOAL_ID).ok).toBe(true);
    const before = snapshot(store);

    // Adversarial reader input copied from a real production attempt, not a writer-success
    // claim that these separate historical and compiled worlds shared one activation store.
    vi.spyOn(qualificationReads, "accountDurableActivations").mockReturnValue(accounts);
    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expect(readLiveNodeEvidence(store, PROJECT_ID, nodeRef, acceptanceOf(store, nodeRef)))
      .toMatchObject({ landing: "COMMITTED", leg: "LIVE" });
    expectRefusedExactly(outcome, "GOAL_CLOSE_AUTHORITY_REMAINS",
      "a legacy activation ambiguously names a compiled node");
    expectUnmoved(store, before);
  }, GOAL_WORLD_BOUND_MS);

  /**
   * A Foundation proof and a live proof OF THE SAME NODE must never derive the same refs — the
   * leg tag is in every preimage precisely so one cannot be replayed as the other.
   */
  it.runIf(WINDOWS_ONLY)("domain-separates LIVE and Foundation leg inputs for the same node in composition", async () => {
    const foundationStore = openStore();
    await seedVerifiedNode(foundationStore, ACTIVATION_WORLD_NODE_KEY);
    seedReviewAcceptance(foundationStore, ACTIVATION_WORLD_NODE_KEY);
    seedLandingReceipt(foundationStore, ACTIVATION_WORLD_NODE_KEY, "COMMITTED");
    expect(qualifyGoalClosure(foundationStore, PROJECT_ID, GOAL_ID)).toMatchObject({
      ok: true, legs: { [ACTIVATION_WORLD_NODE_KEY]: "FOUNDATION" },
    });
    const before = snapshot(foundationStore);
    const liveLeg = readLiveNodeEvidence(foundationStore, PROJECT_ID, ACTIVATION_WORLD_NODE_KEY,
      acceptanceOf(foundationStore, ACTIVATION_WORLD_NODE_KEY));
    if ("ok" in liveLeg) throw new Error(liveLeg.code);

    // Codec unit test: explicitly vary only the evidence leg for the same node. Actual
    // qualification above remains Foundation-only; raw LIVE cannot enter via legacy fallback.
    const live = composeClosure("unit-approval", [ACTIVATION_WORLD_NODE_KEY], [liveLeg], 1);
    const foundation = composeClosure("unit-approval", [ACTIVATION_WORLD_NODE_KEY],
      [foundationLeg(foundationStore, ACTIVATION_WORLD_NODE_KEY)], 1);

    expect(live.ok).toBe(true);
    expect(foundation.ok).toBe(true);
    if (!live.ok || !foundation.ok) return;
    expect(live.legs).toEqual({ [ACTIVATION_WORLD_NODE_KEY]: "LIVE" });
    expect(foundation.legs).toEqual({ [ACTIVATION_WORLD_NODE_KEY]: "FOUNDATION" });
    // The completion-node ref is over the node SET alone and is deliberately equal; the two
    // evidence refs are what must differ.
    expect(live.closureWitness["completionNodeAcceptedRef"])
      .toBe(foundation.closureWitness["completionNodeAcceptedRef"]);
    expect(live.closureWitness["acceptanceClosureRef"])
      .not.toBe(foundation.closureWitness["acceptanceClosureRef"]);
    expect(live.closureWitness["obligationsHoldRef"])
      .not.toBe(foundation.closureWitness["obligationsHoldRef"]);
    expect(live.zeroAuthorityWitness["zeroAuthorityProofRef"])
      .not.toBe(foundation.zeroAuthorityWitness["zeroAuthorityProofRef"]);
    expectUnmoved(foundationStore, before);
  }, GOAL_WORLD_BOUND_MS);
});

describe("the live leg through the shipped operator command path", () => {
  /**
   * DoD 1, end to end: a goal whose only node carries acceptance + verifier receipt + a
   * COMMITTED landing closes through `handleCommandRequest` under the configured operator
   * principal — the seat `goal.close` requires. The commit itself is the proof the core
   * ACCEPTED the derived witness: `reduceGoal` refuses a witness `validClosure` rejects, and a
   * refusal there would answer at the CORE layer instead of committing `GoalCompleted`.
   */
  it.runIf(WINDOWS_ONLY)("closes a live goal for real and refuses the second close at the core", async () => {
    const world = await createScopedCloseWorld();
    const { store } = world; const nodeRef = world.nodeRefs[0]!;
    try {
      const qualified = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);
      expect(qualified.ok).toBe(true);
      if (!qualified.ok) return;
      expect(qualified.legs).toEqual({ [nodeRef]: "LIVE" });
      expect(store.readEvents(GOAL_ID).filter((e) => e.eventType === "GoalCompleted")).toHaveLength(0);

      const closed = closeGoalThroughCommandPath(store, store.getAggregateVersion(GOAL_ID));

      expect(closed.ok).toBe(true);
      if (!closed.ok) return;
      expect(closed.decision.resultCode).toBe("EFFECTS_COMMITTED");
      expect(closed.decision.disposition).toBe("DECIDED");
      const completed = store.readEvents(GOAL_ID)
        .filter((event) => event.eventType === "GoalCompleted");
      expect(completed).toHaveLength(1);
      const completedGoal = readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID)?.result as
        { lifecycle?: string; version?: number } | undefined;
      expect(completedGoal?.lifecycle).toBe("COMPLETED");
      if (typeof completedGoal?.version !== "number") throw new Error("completed goal version missing");

      // The SECOND close is refused by the CORE, not by this daemon leg: the evidence is still
      // there, and it is the goal's own lifecycle that says no. Pinned POSITIVELY — code, layer
      // and the state the reducer names — because `not.toBe("DAEMON_PREREQUISITE")` would stay
      // green if the daemon leg started refusing under any other layer and the core never ran.
      // A combined close advances the core state twice while its durable aggregate commits once.
      // The reducer compares the request against the folded state's version.
      const again = closeGoalThroughCommandPath(store, completedGoal.version, "cmd-j1-goal-close-2");
      expect(again.ok).toBe(false);
      if (again.outcome !== "PORT_REFUSED") throw new Error(`expected a port refusal: ${again.outcome}`);
      expect(again.refusal.code).toBe("ILLEGAL_TRANSITION");
      expect(again.refusal.layer).toBe("CORE_REDUCER");
      expect(again.refusal.detail).toContain("sourceState=COMPLETED");
      expect(store.readEvents(GOAL_ID)
        .filter((event) => event.eventType === "GoalCompleted")).toHaveLength(1);
    } finally { await world.cleanup(); }
  }, 300_000);
});
