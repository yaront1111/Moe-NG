import { afterEach, expect, it } from "vitest";
import { closeStores, GOAL_ID, PROJECT_ID, RUN_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { criterionWorld } from "../criterion-evidence/criterion-test-fixtures.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { closeGoalThroughCommandPath, seedReviewAcceptance } from "./goal-closure-test-fixtures.js";
import { readApprovedNodeScope } from "./goal-close-prerequisite.js";
import { qualifyGoalClosure } from "./goal-qualification.js";

afterEach(closeStores);

/** The compiled node key `criterionWorld`'s sealed revision carries as its execution-bearing node. */
const SEALED_LOCAL_KEY = "node-slice";

/**
 * A CONTRACT-BOUND world approved ONLY through `approval.decide_intent`.
 *
 * `plan-reject-test-fixtures.ts:276` `approvePlan` calls `decide`, and `decide` (:241) dispatches
 * `runApprovalIntentCommand` — the browser's seam, not `approval.decide`. Every arm below asserts
 * that divergence off the durable ledger rather than trusting this comment.
 */
function browserApprovedContractWorld() {
  const world = criterionWorld({
    readIntegrated: () => ({ root: "D:\\fixture", sha: "1".repeat(40), treeSha: "2".repeat(40) }),
  });
  const graph = activeCompiledGraphs(world.store, PROJECT_ID)[0];
  if (graph === undefined) throw new Error("the scoped fixture activated no compiled graph");
  return { ...world, executionRef: compiledExecutionRef(PROJECT_ID, graph, SEALED_LOCAL_KEY) };
}

/** The durable proof that nothing in this world used the seeded `approval.decide` kind. */
function approvedOnlyThroughIntent(store: ReturnType<typeof criterionWorld>["store"]): void {
  const { kinds } = readDurableLedger(store, PROJECT_ID);
  expect(kinds.has("approval.decide_intent")).toBe(true);
  expect(kinds.has("approval.decide")).toBe(false);
}

/**
 * THE ROW'S SUBJECT, PROVEN ON THE PRODUCTION SURFACE (task-8bdd14af).
 *
 * `approval-intent-sources.ts` used to mint `approvedNodeScope: Object.freeze([])`, and
 * `goal-close-prerequisite.ts:87` reads an EMPTY scope as "unknown", so `qualify()` refused
 * GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED "no current approval names an approved node scope" before
 * any per-node walk — forever, for every goal approved in the browser. The mint now derives the
 * sealed revision's execution-bearing nodes, so the durable approval names them and the closure
 * qualifier ACCEPTS: `ok: true`, with a DAEMON_VERIFIED closure witness over the compiled
 * execution the approval covers.
 *
 * The scope is asserted by EQUALITY on the whole record, never by `scope.length`: a scope of the
 * right size naming the wrong node would send `goal-qualification.ts` walking receipts belonging
 * to nobody. `approvalRef` rides along because the mint derives both from the same run identity.
 */
it("qualifies the closure of a goal approved ONLY through approval.decide_intent", () => {
  const { store, executionRef } = browserApprovedContractWorld();
  approvedOnlyThroughIntent(store);

  expect(readApprovedNodeScope(store, GOAL_ID))
    .toEqual({ approvalRef: `approval:${RUN_ID}`, scope: [SEALED_LOCAL_KEY] });

  seedReviewAcceptance(store, executionRef);

  expect(qualifyGoalClosure(store, PROJECT_ID, GOAL_ID))
    .toMatchObject({ closureWitness: { truthClass: "DAEMON_VERIFIED" }, ok: true });
});

/**
 * FAIL-CLOSED AT THE CLOSE IS UNCHANGED, and the ACCEPTANCE fence is provably the one that
 * answered.
 *
 * THE DISCRIMINATOR IS THE MESSAGE, and it has to be: GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED at
 * DAEMON_PREREQUISITE is ALSO what the SCOPE fence raises, so an arm reading code and layer alone
 * would have passed before this row shipped while testing nothing about acceptance. The scope
 * assertion above is the second leg of the same proof: the fence this row fixed is satisfied, so
 * it cannot be what refuses here.
 *
 * The acceptance below names the RAW local key rather than the compiled execution ref, which is
 * the shape `goal-approved-execution-scope.ts` (task-4b6d2bc2) exists to refuse: one execution
 * may not inherit another's acceptance for the same local key.
 */
it("still refuses the close when no review acceptance names the approved execution", () => {
  const { store } = browserApprovedContractWorld();
  seedReviewAcceptance(store, SEALED_LOCAL_KEY);

  expect(readApprovedNodeScope(store, GOAL_ID))
    .toEqual({ approvalRef: `approval:${RUN_ID}`, scope: [SEALED_LOCAL_KEY] });
  expect(qualifyGoalClosure(store, PROJECT_ID, GOAL_ID)).toMatchObject({
    code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
    layer: "DAEMON_PREREQUISITE",
    message: "no durable review acceptance names this approved node",
    ok: false,
  });
});

/**
 * WHERE THE BROWSER-APPROVED CLOSE STILL STOPS, AND IT IS NOT THIS ROW'S FENCE.
 *
 * DoD 1 asks for a real `goal.close` answering `ok: true` on a terminal lifecycle. With the
 * closure qualifier satisfied (arm one), the dispatch is now refused one authority LATER, by
 * GOAL_CLOSE_CRITERIA_UNVERIFIED — the criterion-evidence fence commit 4b6d2bc2 added hours after
 * this row was planned. Satisfying it needs PASSED criterion receipts from a real check run, and
 * that executor is RED at HEAD in its OWN owner's arms (`criterion-integrated.test.ts` and the
 * three `createScopedCloseWorld` arms of `j1-command-path.test.ts` all answer
 * `status: "UNKNOWN", exitCode: null`), so no world this row can build reaches a close.
 *
 * This arm PINS that boundary rather than papering over it: it asserts the refusal is the
 * criteria fence and NOT a scope or acceptance refusal, so the moment criterion evidence works
 * the arm goes red and must be upgraded to the `ok: true` close DoD 1 names.
 */
it("stops at the criterion-evidence fence, not at the approved node scope", () => {
  const { store, executionRef } = browserApprovedContractWorld();
  seedReviewAcceptance(store, executionRef);

  const closed = closeGoalThroughCommandPath(store, store.getAggregateVersion(GOAL_ID));

  expect(closed).toMatchObject({
    ok: false,
    refusal: { code: "GOAL_CLOSE_CRITERIA_UNVERIFIED", layer: "DAEMON_PREREQUISITE" },
  });
  expect(qualifyGoalClosure(store, PROJECT_ID, GOAL_ID)).toMatchObject({ ok: true });
});
