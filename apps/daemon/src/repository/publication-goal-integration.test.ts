import { afterEach, expect, it } from "vitest";
import { GOAL_ID, PROJECT_ID, closeStores, driveThrough, openStore, FIXTURE_PUBLICATION_APPROVAL } from "../bootstrap/bootstrap-test-fixtures.js";
import { seedLandingReceipt, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { publicationGoalIntegrated } from "./publication-goal-integration.js";
afterEach(closeStores);
it("requires a current scoped goal landing, and verifies that landing belongs to the approved ancestry", () => {
  const store = openStore(); driveThrough(store, "repository.publish");
  const candidate = { approval: FIXTURE_PUBLICATION_APPROVAL, identity: { root: "D:/fixture/repo", gitDirectory: "D:/fixture/repo/.git" } };
  expect(publicationGoalIntegrated(store, PROJECT_ID, GOAL_ID, candidate, () => true)).toBe(false);
  seedReviewAcceptance(store, "unrelated"); seedLandingReceipt(store, "unrelated", "COMMITTED");
  expect(publicationGoalIntegrated(store, PROJECT_ID, GOAL_ID, candidate, () => true)).toBe(false);
  const graph = activeCompiledGraphs(store, PROJECT_ID)[0]!;
  const nodeRef = compiledExecutionRef(PROJECT_ID, graph, "node-a");
  seedReviewAcceptance(store, nodeRef); seedLandingReceipt(store, nodeRef, "COMMITTED");
  let checks = 0;
  expect(publicationGoalIntegrated(store, PROJECT_ID, GOAL_ID, candidate, () => { checks += 1; return true; })).toBe(true);
  expect(checks).toBe(1);
  expect(publicationGoalIntegrated(store, PROJECT_ID, GOAL_ID, candidate, () => false)).toBe(false);
  expect(publicationGoalIntegrated(store, PROJECT_ID, "another-goal", candidate, () => true)).toBe(false);
});

/**
 * A NO-EFFECT LANDING SATISFIES "AT LEAST ONE LANDING" AND IS NEVER HANDED TO THE ANCESTRY CHECK.
 *
 * Reading A, decided on task-f7d38f752b074dc89da30631783aae04. The `every()` stays over the
 * COMMITTED subset alone, so a no-effect receipt (commit null) neither fails the ancestry check
 * nor is counted by it — which is also what keeps a MIXED goal correct once the "at least one"
 * test is widened. The seed world's goal names exactly ONE execution-bearing node (`node-a`,
 * bootstrap-test-fixtures.ts:149,:559), so a same-goal mixed pair is not constructible here; the
 * mixed case is pinned at the load-bearing seam in criterion-integrated.test.ts, and the
 * `checks` counts below pin the rule this seam owns.
 */
function publishWorld() {
  const store = openStore(); driveThrough(store, "repository.publish");
  const graph = activeCompiledGraphs(store, PROJECT_ID)[0]!;
  const nodeRef = compiledExecutionRef(PROJECT_ID, graph, "node-a");
  expect(graph.content.snapshot.nodes.filter((node) => node.executionBearing)
    .map((node) => node.nodeKey)).toEqual(["node-a"]);
  return { candidate: { approval: FIXTURE_PUBLICATION_APPROVAL,
    identity: { root: "D:/fixture/repo", gitDirectory: "D:/fixture/repo/.git" } }, nodeRef, store };
}

it("credits a goal whose only node PROVABLY had nothing to commit, with no sha to verify", () => {
  const { candidate, nodeRef, store } = publishWorld();
  seedReviewAcceptance(store, nodeRef);
  seedLandingReceipt(store, nodeRef, { refusalCode: "NOTHING_TO_COMMIT" });

  let checks = 0;
  expect(publicationGoalIntegrated(store, PROJECT_ID, GOAL_ID, candidate,
    () => { checks += 1; return true; })).toBe(true);
  // ZERO ancestry checks: there is no sha to bind, so the no-effect receipt is credited and
  // skipped rather than pushed through `validPublicationSha`. A rule that counted it as a
  // verifiable landing would call `contains` once and refuse on its null commit.
  expect(checks).toBe(0);
  // ...and it stays true when the ancestry oracle says no, because nothing was submitted to it.
  expect(publicationGoalIntegrated(store, PROJECT_ID, GOAL_ID, candidate, () => false)).toBe(true);
});

it("refuses a goal whose only node refused for a POST-INTENT reason", () => {
  // The discriminator is the refusal CODE. GIT_COMMIT_FAILED owed bytes and never delivered
  // them, so the goal holds no landing at all and publication stays unintegrated.
  const { candidate, nodeRef, store } = publishWorld();
  seedReviewAcceptance(store, nodeRef);
  seedLandingReceipt(store, nodeRef, { refusalCode: "GIT_COMMIT_FAILED" });

  let checks = 0;
  expect(publicationGoalIntegrated(store, PROJECT_ID, GOAL_ID, candidate,
    () => { checks += 1; return true; })).toBe(false);
  expect(checks).toBe(0);
});
