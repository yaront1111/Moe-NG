import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { ACTIVATION_WORLD_NODE_KEY } from "../activation/activation-world-fixtures.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { GOAL_ID, PROJECT_ID, decisionCount, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { readReviewLedger } from "../review/review-ledger.js";
import type { AcceptanceRecord } from "../review/review-read-model.js";
import {
  deltaNode, envelope as reviewEnvelope, replanPayload, send as reviewSend,
} from "../review/review-test-fixtures.js";
import {
  approveNodes,
  cleanupGoalClosureFixtures,
  closeGoalThroughCommandPath,
  seedLandingReceipt,
  seedProvenAttempt,
  seedReviewAcceptance,
  seedVerifiedNode,
} from "./goal-closure-test-fixtures.js";
import { readLiveNodeEvidence } from "./goal-live-evidence.js";
import { qualifyGoalClosure } from "./goal-qualification.js";

/**
 * THE LIVE LEG of `goal.close` qualification: the evidence the RUNNING loop actually produces.
 *
 * A node the live loop finished carries a review acceptance, the verifier receipt that
 * acceptance names, and — when landing is on — a landing receipt from the wrapper's lander. It
 * carries NO Foundation verification receipt, because nothing in the live path mints one. Before
 * this module, `qualify` demanded that Foundation receipt for every approved node and refused
 * `GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT`, so no live goal could ever close.
 *
 * Every world below is built by the PRODUCTION writers — `approval.decide` and
 * `integration.accept_output` through the authenticated command path, the lander's own
 * `recordLandingReceipt` — never by planted bytes. `qualifyGoalClosure` is a pure read, so every
 * arm re-reads the store afterwards: a composer that mutated and then answered would sail
 * through a return-value-only assertion.
 *
 * The Foundation arms live in `goal-qualification.test.ts` and are NOT restated here; the two
 * arms below that build a Foundation world do so only to prove the legs stay apart.
 */

// `seedVerifiedNode` runs the shipped attempt service, whose completion authority pins the
// Claude runtime to an absolute local-drive Windows path. The two arms that need a Foundation
// leg therefore run only where production can reach one.
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
function approvedWorld(store: SqliteEventStore, nodeRefs: readonly string[]): void {
  approveNodes(store, [...nodeRefs]);
  for (const nodeRef of nodeRefs) seedReviewAcceptance(store, nodeRef);
}

function acceptanceOf(store: SqliteEventStore, nodeRef: string): AcceptanceRecord {
  const accepted = readReviewLedger(store, PROJECT_ID, nodeRef).accepted;
  if (accepted === undefined) throw new Error(`no acceptance was recorded for ${nodeRef}`);
  return accepted;
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
  cleanupGoalClosureFixtures();
});

describe("the live leg closes on acceptance, verifier receipt and landing", () => {
  it("qualifies an approved, accepted node whose landing COMMITTED", () => {
    const store = openStore();
    approvedWorld(store, ["node-1"]);
    seedLandingReceipt(store, "node-1", "COMMITTED");
    const before = snapshot(store);

    const qualified = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expect(qualified.ok).toBe(true);
    if (!qualified.ok) return;
    expect(qualified.legs).toEqual({ "node-1": "LIVE" });
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
    const store = openStore();
    approvedWorld(store, ["node-1"]);
    seedLandingReceipt(store, "node-1", { refusalCode: "NOTHING_TO_COMMIT" });
    const before = snapshot(store);

    const qualified = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expect(qualified.ok).toBe(true);
    if (!qualified.ok) return;
    expect(qualified.legs).toEqual({ "node-1": "LIVE" });
    // The lander's own legitimate empty-diff refusal, read back as the receipt production wrote.
    const live = readLiveNodeEvidence(store, PROJECT_ID, "node-1", acceptanceOf(store, "node-1"));
    expect(live).toMatchObject({ landing: "NOTHING_TO_COMMIT", leg: "LIVE" });
    expectUnmoved(store, before);
  });

  it("refuses NOT_PASSED naming the landing code when the landing refused for any other reason", () => {
    const store = openStore();
    approvedWorld(store, ["node-1"]);
    seedLandingReceipt(store, "node-1", { refusalCode: "GIT_COMMIT_FAILED" });
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    // No new refusal code is minted for this: the roster has five pinned consumers, so the
    // MESSAGE is what tells this guard apart from the Foundation verdict guard that shares it.
    expectRefusedExactly(outcome, "GOAL_CLOSE_VERIFICATION_NOT_PASSED",
      "the landing receipt refused GIT_COMMIT_FAILED");
    expectUnmoved(store, before);
  });

  it("admits a node with no landing receipt at all and records the landing as NONE", () => {
    const store = openStore();
    // Landing is a wrapper knob (MOE_NODE_LANDING=0) and pre-feature nodes have none, so an
    // ABSENT landing is admitted; a PRESENT one is checked strictly by the arms above.
    approvedWorld(store, ["node-1"]);
    const before = snapshot(store);

    const live = readLiveNodeEvidence(store, PROJECT_ID, "node-1", acceptanceOf(store, "node-1"));
    const qualified = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expect(live).toMatchObject({ landing: "NONE", landingReceiptId: null, leg: "LIVE" });
    expect(qualified.ok).toBe(true);
    if (!qualified.ok) return;
    expect(qualified.legs).toEqual({ "node-1": "LIVE" });
    expectUnmoved(store, before);
  });

  it("refuses ACCEPTANCE_REQUIRED for an approved node the live loop never accepted", () => {
    const store = openStore();
    approveNodes(store, ["node-1"]);
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefusedExactly(outcome, "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
      "no durable review acceptance names this approved node");
    expectUnmoved(store, before);
  });

  it("refuses PACKAGE_STALE on the live leg when a durable re-plan supersedes the acceptance", () => {
    const store = openStore();
    approvedWorld(store, ["node-1"]);
    seedLandingReceipt(store, "node-1", "COMMITTED");
    replan(store, "node-1");
    // The precondition, measured: the re-plan really is durable on this node's ledger.
    expect(readReviewLedger(store, PROJECT_ID, "node-1").delta).toBeDefined();
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
    const store = openStore();
    approvedWorld(store, ["node-1"]);
    const foreign = "f".repeat(64);
    expect(foreign).not.toBe(acceptanceOf(store, "node-1").verifierReceiptId);
    seedLandingReceipt(store, "node-1", "COMMITTED", foreign);
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefusedExactly(outcome, "GOAL_CLOSE_REVIEW_PACKAGE_STALE",
      "the landing receipt attests a different verifier receipt");
    expectUnmoved(store, before);
  });

  /** Two landings for one node: the ledger fold keeps the LAST decision, so the LATEST wins. */
  it("reads the latest landing receipt when a node carries more than one", () => {
    const store = openStore();
    approvedWorld(store, ["node-1"]);
    const stale = "e".repeat(64);
    seedLandingReceipt(store, "node-1", { refusalCode: "GIT_COMMIT_FAILED" }, stale);
    seedLandingReceipt(store, "node-1", "COMMITTED");

    const live = readLiveNodeEvidence(store, PROJECT_ID, "node-1", acceptanceOf(store, "node-1"));

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
    const store = openStore();
    approvedWorld(store, ["node-1"]);
    seedLandingReceipt(store, "node-1", "COMMITTED");
    const accepted = acceptanceOf(store, "node-1");
    store.close();

    const outcome = readLiveNodeEvidence(store, PROJECT_ID, "node-1", accepted);

    expect(outcome).toMatchObject({
      code: "GOAL_CLOSE_VERIFICATION_NOT_PASSED",
      layer: "DAEMON_PREREQUISITE",
      message: "the durable landing evidence could not be read",
      ok: false,
    });
  });

  it.runIf(WINDOWS_ONLY)("closes a MIXED goal, naming the Foundation and live legs apart", async () => {
    const store = openStore();
    await seedVerifiedNode(store, ACTIVATION_WORLD_NODE_KEY, [ACTIVATION_WORLD_NODE_KEY, "node-2"]);
    seedReviewAcceptance(store, ACTIVATION_WORLD_NODE_KEY);
    seedReviewAcceptance(store, "node-2");
    seedLandingReceipt(store, "node-2", "COMMITTED");
    const before = snapshot(store);

    const qualified = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expect(qualified.ok).toBe(true);
    if (!qualified.ok) return;
    expect(qualified.legs).toEqual({
      [ACTIVATION_WORLD_NODE_KEY]: "FOUNDATION", "node-2": "LIVE",
    });
    expectUnmoved(store, before);
  }, GOAL_WORLD_BOUND_MS);

  /**
   * THE HOLE THE LIVE LEG WOULD OTHERWISE OPEN. Design 278 asks the closure to prove no
   * execution authority outlives the goal, and the only durable instrument for that is the
   * activation ledger: every activation must be the one its node's PASSED receipt names. A LIVE
   * node has no receipt, so before this arm a durable activation naming one hit a plain
   * `byNode` miss and was SKIPPED — the goal closed over an unaccounted lease and effect.
   * Foundation could not reach this state, because a receipt-less node refused
   * RECEIPT_ABSENT long before `zeroAuthority` ran; the live leg is what makes it reachable,
   * so the live leg is what must refuse.
   *
   * The world is built by the PRODUCTION dispatch path: `seedProvenAttempt` is the first half
   * of `seedVerifiedNode` and writes the activation, so stopping there leaves an activation
   * whose node carries acceptance but no verification receipt.
   */
  it.runIf(WINDOWS_ONLY)("refuses AUTHORITY_REMAINS when an activation names a live node", async () => {
    const store = openStore();
    await seedProvenAttempt(store, ACTIVATION_WORLD_NODE_KEY, [ACTIVATION_WORLD_NODE_KEY]);
    seedReviewAcceptance(store, ACTIVATION_WORLD_NODE_KEY);
    seedLandingReceipt(store, ACTIVATION_WORLD_NODE_KEY, "COMMITTED");
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    // The node IS otherwise closable — acceptance, verifier receipt and a COMMITTED landing all
    // hold — so the refusal below is the activation rule and nothing else.
    expect(readLiveNodeEvidence(store, PROJECT_ID, ACTIVATION_WORLD_NODE_KEY,
      acceptanceOf(store, ACTIVATION_WORLD_NODE_KEY)))
      .toMatchObject({ landing: "COMMITTED", leg: "LIVE" });
    expectRefusedExactly(outcome, "GOAL_CLOSE_AUTHORITY_REMAINS",
      "a durable activation names a node proved on the live leg");
    expectUnmoved(store, before);
  }, GOAL_WORLD_BOUND_MS);

  /**
   * A Foundation proof and a live proof OF THE SAME NODE must never derive the same refs — the
   * leg tag is in every preimage precisely so one cannot be replayed as the other.
   */
  it.runIf(WINDOWS_ONLY)("derives different closure refs for a live and a Foundation proof of one node", async () => {
    const liveStore = openStore();
    approvedWorld(liveStore, [ACTIVATION_WORLD_NODE_KEY]);
    seedLandingReceipt(liveStore, ACTIVATION_WORLD_NODE_KEY, "COMMITTED");
    const foundationStore = openStore();
    await seedVerifiedNode(foundationStore, ACTIVATION_WORLD_NODE_KEY);
    seedReviewAcceptance(foundationStore, ACTIVATION_WORLD_NODE_KEY);

    const live = qualifyGoalClosure(liveStore, PROJECT_ID, GOAL_ID);
    const foundation = qualifyGoalClosure(foundationStore, PROJECT_ID, GOAL_ID);

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
  it("closes a live goal for real and refuses the second close at the core", () => {
    const store = openStore();
    approvedWorld(store, ["node-1"]);
    seedLandingReceipt(store, "node-1", "COMMITTED");
    const qualified = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);
    expect(qualified.ok).toBe(true);
    if (!qualified.ok) return;
    expect(qualified.legs).toEqual({ "node-1": "LIVE" });
    expect(store.readEvents(GOAL_ID).filter((e) => e.eventType === "GoalCompleted")).toHaveLength(0);

    const closed = closeGoalThroughCommandPath(store, 2);

    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.decision.resultCode).toBe("EFFECTS_COMMITTED");
    expect(closed.decision.disposition).toBe("DECIDED");
    const completed = store.readEvents(GOAL_ID)
      .filter((event) => event.eventType === "GoalCompleted");
    expect(completed).toHaveLength(1);
    expect((readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID)?.result as
      { lifecycle?: string } | undefined)?.lifecycle).toBe("COMPLETED");

    // The SECOND close is refused by the CORE, not by this daemon leg: the evidence is still
    // there, and it is the goal's own lifecycle that says no. Pinned POSITIVELY — code, layer
    // and the state the reducer names — because `not.toBe("DAEMON_PREREQUISITE")` would stay
    // green if the daemon leg started refusing under any other layer and the core never ran.
    const again = closeGoalThroughCommandPath(store, 4, "cmd-j1-goal-close-2");
    expect(again.ok).toBe(false);
    if (again.outcome !== "PORT_REFUSED") throw new Error(`expected a port refusal: ${again.outcome}`);
    expect(again.refusal.code).toBe("ILLEGAL_TRANSITION");
    expect(again.refusal.layer).toBe("CORE_REDUCER");
    expect(again.refusal.detail).toContain("sourceState=COMPLETED");
    expect(store.readEvents(GOAL_ID)
      .filter((event) => event.eventType === "GoalCompleted")).toHaveLength(1);
  });
});
