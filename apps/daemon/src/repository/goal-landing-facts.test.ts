/**
 * THE LANDING FACT the publish offer gate reads. Every arm runs over a REAL store driven
 * through the production bootstrap sequence — the landing receipts are written by the lander's
 * own writer (`recordLandingReceipt`, via the `seedLandingReceipt` fixture), never planted, so
 * the bytes this fact reads back are the bytes production commits.
 *
 * The rule under test is GOAL-SCOPED: a landing counts only when it sits on a node the goal's
 * own activated graph names. The seed world's graph names `node-a`; `node-1` is a real, landable
 * node of the same project that this goal's graph does NOT carry, which is what makes the
 * scope arm an honest one — it fails against a live COMMITTED receipt, not an absent one.
 */
import { describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_ID, PROJECT_ID, driveThrough, openStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { seedLandingReceipt, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { createAffordancePort } from "../http/affordance-read.js";
import { readReviewLedgers } from "../review/review-read-model.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { createGoalLandingReader, goalHasLandedCommit } from "./goal-landing-facts.js";

/** The outcome the durable ledger holds for one node, read independently of the fact. */
function nodeLanded(store: ReturnType<typeof openStore>, nodeRef: string): string | null {
  nodeRef = scopedRef(store, nodeRef);
  return readReviewLedgers(store, PROJECT_ID, new Set([nodeRef]))
    .landings.get(nodeRef)?.outcome ?? null;
}

function scopedRef(store: ReturnType<typeof openStore>, nodeKey: string): string {
  const graph = activeCompiledGraphs(store, PROJECT_ID).find((plan) =>
    plan.goalRef === GOAL_ID && plan.content.snapshot.nodes.some((node) => node.nodeKey === nodeKey));
  return graph === undefined ? nodeKey : compiledExecutionRef(PROJECT_ID, graph, nodeKey);
}

/**
 * The goal's own offers as `/affordances/read` states them, through the SHIPPED composition
 * root — `createAffordancePort` with the same config shape goal-close-readiness.test.ts:487-489
 * uses. Set-equality over `commandKind@target` for the whole goal-scoped slice, so a duplicate
 * offer or a stray one reds just as loudly as a missing one.
 */
function goalOffers(store: ReturnType<typeof openStore>): readonly string[] {
  let minted = 0;
  const result = createAffordancePort({
    mintId: () => `afford-landing-${String(minted += 1)}`, projectId: PROJECT_ID, store,
  }).readSurface();
  if (!("nextAllowedCommands" in result)) throw new Error("expected a surface, got a refusal");
  return result.nextAllowedCommands
    .filter((entry) => entry.targetAggregateId === GOAL_ID
      || entry.targetAggregateId === `publish:${GOAL_ID}`)
    .map((entry) => `${entry.commandKind}@${entry.targetAggregateId}`).sort();
}

/** The seed world at lifecycle EXECUTION_ENABLED: one activated graph, one node, no landing. */
function enabledWorld(): ReturnType<typeof openStore> {
  const store = openStore();
  driveThrough(store, "goal.close");
  return store;
}

/** Writes a real landing receipt for `nodeRef`, opening the acceptance its writer demands. */
function land(
  store: ReturnType<typeof openStore>, nodeRef: string,
  outcome: Parameters<typeof seedLandingReceipt>[2],
): void {
  nodeRef = scopedRef(store, nodeRef);
  seedReviewAcceptance(store, nodeRef);
  seedLandingReceipt(store, nodeRef, outcome);
}

describe("a goal has a landed commit", () => {
  it("is FALSE for an enabled goal that has landed nothing", () => {
    // The live defect: this goal was offered a PUBLISH card over "No node of this goal is
    // landed as a commit yet" (UnAI 2026-09-04). The fact is what withholds it.
    expect(goalHasLandedCommit(enabledWorld(), PROJECT_ID, GOAL_ID)).toBe(false);
  });

  it("is TRUE once a node of the goal carries a COMMITTED landing receipt", () => {
    const store = enabledWorld();
    expect(goalHasLandedCommit(store, PROJECT_ID, GOAL_ID)).toBe(false);

    land(store, "node-a", "COMMITTED");

    expect(goalHasLandedCommit(store, PROJECT_ID, GOAL_ID)).toBe(true);
  });

  it("is FALSE when the goal's only landing was REFUSED", () => {
    // A refusal is a landing ATTEMPT, not a landed commit. NOTHING_TO_COMMIT is the exact
    // shape the lander writes for a node whose work produced no diff.
    const store = enabledWorld();

    land(store, "node-a", { refusalCode: "NOTHING_TO_COMMIT" });

    expect(goalHasLandedCommit(store, PROJECT_ID, GOAL_ID)).toBe(false);
  });

  it("is FALSE for a COMMITTED landing on a node no activated graph carries", () => {
    // GRAPH MEMBERSHIP, against a LIVE receipt: `node-1` really does land here (the assertion
    // below reads the receipt back independently), it simply is not a node any activated graph
    // names. A fact that read the project's landings instead of the graph's nodes answers true.
    // The GOAL-scoping rule proper is the arm below, which a sibling goal id would defeat.
    const store = enabledWorld();

    land(store, "node-1", "COMMITTED");

    expect(nodeLanded(store, "node-1")).toBe("COMMITTED");
    expect(goalHasLandedCommit(store, PROJECT_ID, GOAL_ID)).toBe(false);
  });

  it("counts only the named goal's landing, never a sibling goal's", () => {
    const store = enabledWorld();
    land(store, "node-a", "COMMITTED");

    expect(goalHasLandedCommit(store, PROJECT_ID, GOAL_ID)).toBe(true);
    expect(goalHasLandedCommit(store, PROJECT_ID, "goal-nobody")).toBe(false);
  });

  it("is FALSE before the goal's graph is activated, landing or no landing", () => {
    // Stops BEFORE `approval.decide`, so the goal never reaches EXECUTION_ENABLED and
    // `activeCompiledGraphs` names no nodes for it. Nothing can be published off a plan
    // that was never approved.
    const store = openStore();
    driveThrough(store, "approval.decide");

    expect(goalHasLandedCommit(store, PROJECT_ID, GOAL_ID)).toBe(false);
  });

  it("is FALSE for another project's id over the same store", () => {
    const store = enabledWorld();
    land(store, "node-a", "COMMITTED");

    expect(goalHasLandedCommit(store, "project-elsewhere", GOAL_ID)).toBe(false);
  });

  it("fails CLOSED — a store it cannot read answers false rather than throwing", () => {
    // An unreadable ledger is not evidence a commit landed. The surface must withhold the
    // offer, and it must not take the whole read down to do it.
    const store = enabledWorld();
    land(store, "node-a", "COMMITTED");
    expect(goalHasLandedCommit(store, PROJECT_ID, GOAL_ID)).toBe(true);

    store.close();

    expect(() => goalHasLandedCommit(store, PROJECT_ID, GOAL_ID)).not.toThrow();
    expect(goalHasLandedCommit(store, PROJECT_ID, GOAL_ID)).toBe(false);
  });

  it("reads the ledger the caller already folded rather than folding a second one", () => {
    // The surface read folds the durable ledger once and hands it down. Passing it must not
    // change the answer, and the ladder's contract is that no second fold happens.
    const store = enabledWorld();
    land(store, "node-a", "COMMITTED");
    const folded = readDurableLedger(store, PROJECT_ID);

    expect(goalHasLandedCommit(store, PROJECT_ID, GOAL_ID, folded)).toBe(true);
    expect(goalHasLandedCommit(store, PROJECT_ID, "goal-nobody", folded)).toBe(false);
  });
});

/**
 * THE SURFACE, over a real store through the shipped composition root. These read
 * `/affordances/read`'s own answer rather than the fact in isolation, so they also pin that the
 * fact is actually WIRED — a gate no one composed would leave every arm above green.
 */
describe("the publish offer on /affordances/read", () => {
  it("is ABSENT for an enabled goal with no landing receipt", () => {
    // The live defect, at the surface: a PUBLISH card over "No node of this goal is landed as a
    // commit yet". goal.close stays — 8145137c's NO_CONTRACT rule is untouched for the seed
    // world — so the arm shows the publish offer alone went away.
    expect(goalOffers(enabledWorld())).toEqual([`goal.close@${GOAL_ID}`]);
  });

  it("APPEARS targeting publish:<goalId> once a commit lands, and goes again on a fresh world", () => {
    // ABSENT -> PRESENT over one store, read off the surface both times.
    const store = enabledWorld();
    expect(goalOffers(store)).toEqual([`goal.close@${GOAL_ID}`]);

    land(store, "node-a", "COMMITTED");

    expect(goalOffers(store)).toEqual([
      `goal.close@${GOAL_ID}`, `repository.publish@publish:${GOAL_ID}`,
    ]);

    // ...and PRESENT -> ABSENT across worlds: the same goal, landed nothing, is unoffered.
    expect(goalOffers(enabledWorld())).toEqual([`goal.close@${GOAL_ID}`]);
  });

  it("stays ABSENT when the goal's only landing was REFUSED", () => {
    const store = enabledWorld();

    land(store, "node-a", { refusalCode: "NOTHING_TO_COMMIT" });

    expect(nodeLanded(store, "node-a")).toBe("REFUSED");
    expect(goalOffers(store)).toEqual([`goal.close@${GOAL_ID}`]);
  });

  it("stays ABSENT for a commit landed on a node outside the goal's graph", () => {
    const store = enabledWorld();

    land(store, "node-1", "COMMITTED");

    expect(nodeLanded(store, "node-1")).toBe("COMMITTED");
    expect(goalOffers(store)).toEqual([`goal.close@${GOAL_ID}`]);
  });

  it("saves a whole durable fold when the caller supplies the ledger it already read", () => {
    // The `folded` parameter exists so the surface read pays for ONE fold per poll, not two.
    // That is a cost, not an answer, so no assertion above can see it — only the store's own
    // decision-page reads can. Measured against the REAL cost of one fold on this store, so
    // the arm cannot pass by picking a generous multiple of some baseline.
    const store = enabledWorld();
    land(store, "node-a", "COMMITTED");

    const control = countingStore(store);
    readDurableLedger(control.store, PROJECT_ID);
    const foldPages = control.pages();
    expect(foldPages).toBeGreaterThan(0);

    const folded = readDurableLedger(store, PROJECT_ID);
    const reusing = countingStore(store);
    expect(goalHasLandedCommit(reusing.store, PROJECT_ID, GOAL_ID, folded)).toBe(true);

    const refolding = countingStore(store);
    expect(goalHasLandedCommit(refolding.store, PROJECT_ID, GOAL_ID)).toBe(true);

    // EXACT, not "less than": the difference between the two calls is one fold and nothing
    // else. A `folded` argument that got dropped on the floor would make these equal.
    expect(refolding.pages()).toBe(reusing.pages() + foldPages);
  });

  it("answers MANY goals for the price of one — the reader shares its walks", () => {
    // `readReviewLedgers` pages the WHOLE decision ledger, so a per-goal read multiplies the
    // surface cost by the goal count: measured 7.96ms/goal at 16 decisions but 97.28ms/goal at
    // 176, which put a surface read at 477ms. One shared reader is what keeps that flat.
    const store = enabledWorld();
    land(store, "node-a", "COMMITTED");
    const folded = readDurableLedger(store, PROJECT_ID);

    const once = countingStore(store);
    const single = createGoalLandingReader(once.store, PROJECT_ID, folded);
    expect(single.hasLandedCommit(GOAL_ID)).toBe(true);
    const onePage = once.pages();
    expect(onePage).toBeGreaterThan(0);

    const many = countingStore(store);
    const shared = createGoalLandingReader(many.store, PROJECT_ID, folded);
    for (let ask = 0; ask < 20; ask += 1) {
      expect(shared.hasLandedCommit(GOAL_ID)).toBe(true);
      expect(shared.hasLandedCommit("goal-nobody")).toBe(false);
    }

    // FLAT: forty questions cost exactly what one did. A reader that walked per question
    // would be forty times this.
    expect(many.pages()).toBe(onePage);
  });

  it("defers its walks entirely until the first question is asked", () => {
    // A poll with no publishable goal must pay nothing at all — the ladder never calls the
    // fact, and constructing the reader must not read the store on its own.
    const store = enabledWorld();
    const counted = countingStore(store);

    createGoalLandingReader(counted.store, PROJECT_ID, readDurableLedger(store, PROJECT_ID));

    expect(counted.pages()).toBe(0);
  });
});

/**
 * A pass-through view of the store that tallies its decision-page reads. A Proxy rather than a
 * monkey patch: `readCommandDecisionsAfter` is a non-writable own property of SqliteEventStore.
 */
function countingStore(store: ReturnType<typeof openStore>): {
  readonly pages: () => number; readonly store: ReturnType<typeof openStore>;
} {
  let pages = 0;
  const proxy = new Proxy(store, {
    get(target, property, receiver): unknown {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property !== "readCommandDecisionsAfter" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]): unknown => {
        pages += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { pages: (): number => pages, store: proxy };
}
