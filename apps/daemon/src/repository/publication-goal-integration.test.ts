import { afterEach, expect, it } from "vitest";
import { GOAL_ID, PROJECT_ID, closeStores, driveThrough, openStore, FIXTURE_PUBLICATION_APPROVAL } from "../bootstrap/bootstrap-test-fixtures.js";
import { seedLandingReceipt, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { publicationGoalIntegrated } from "./publication-goal-integration.js";
import { REPOSITORY_LANDING_INTENT_KIND, recordRepositoryLandingIntent } from "./repository-landing-intent.js";
import { writeRecoveryFact } from "./repository-recovery-facts.js";
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

const INTENT_ROOT = "D:/fixture-workspace";

/**
 * THE SECOND HALF OF THE DISCRIMINATOR, written by the PRODUCTION writer.
 *
 * `recordRepositoryLandingIntent` validates the handle it is given and is the only thing that
 * mints an intent, so these arms read back the bytes production commits. Only the UNDECODABLE
 * body is planted, because no writer produces one — which is why that branch needs a boundary.
 */
function journalIntent(store: ReturnType<typeof openStore>, nodeRef: string, verifierReceiptId?: string): void {
  const receiptId = verifierReceiptId ?? readReviewLedger(store, PROJECT_ID, nodeRef).accepted?.verifierReceiptId;
  if (receiptId === undefined) throw new Error(`no acceptance names ${nodeRef}`);
  const written = recordRepositoryLandingIntent(store, {
    binding: { version: "moe-verified-workspace/1", root: INTENT_ROOT, branchRef: "refs/heads/trunk",
      headSha: "1".repeat(40), treeSha: "2".repeat(40), dirtySha256: "3".repeat(64) },
    handle: {
      owner: { nodeRef, ownershipToken: "b".repeat(64), projectId: PROJECT_ID, storeId: "D:/store.sqlite" },
      reservation: { baselineId: "baseline", controllerId: "controller", controllerPid: 23,
        identity: { gitDirectory: `${INTENT_ROOT}/.git`, root: INTENT_ROOT }, nodeRef, phase: "LANDING",
        pid: 31, projectId: PROJECT_ID, revision: 7, sessionId: "session", storeId: "D:/store.sqlite" },
    },
    message: "land\n", paths: ["owned.txt"], verifierReceiptId: receiptId,
  });
  if (!written.ok) throw new Error(written.code);
}

/** An intent decision whose BODY does not decode: the reader answers NULL, never an empty set. */
function journalUnreadableIntent(store: ReturnType<typeof openStore>): void {
  const written = writeRecoveryFact(store, PROJECT_ID, "planted-intent", REPOSITORY_LANDING_INTENT_KIND,
    "repository-landing:planted", { version: "not-an-intent" });
  if (!written.ok) throw new Error(written.code);
}

it("refuses a goal whose no-effect node already JOURNALED a landing intent", () => {
  // The governor's reproducer at this seam (comment-573c4f2c). Identical to the credited arm
  // above except an intent exists for this acceptance, so the refusal is a retry whose bytes
  // were reverted: the goal holds no landing and publication stays unintegrated.
  const { candidate, nodeRef, store } = publishWorld();
  seedReviewAcceptance(store, nodeRef);
  seedLandingReceipt(store, nodeRef, { refusalCode: "NOTHING_TO_COMMIT" });
  journalIntent(store, nodeRef);

  let checks = 0;
  expect(publicationGoalIntegrated(store, PROJECT_ID, GOAL_ID, candidate,
    () => { checks += 1; return true; })).toBe(false);
  expect(checks).toBe(0);
});

it("credits the no-effect node when the journaled intent names a DIFFERENT verifier receipt", () => {
  // The key is (verifier receipt, node), so an intent from an EARLIER acceptance of the same node
  // does not taint the current one. One literal apart from the arm above.
  const { candidate, nodeRef, store } = publishWorld();
  seedReviewAcceptance(store, nodeRef);
  seedLandingReceipt(store, nodeRef, { refusalCode: "NOTHING_TO_COMMIT" });
  journalIntent(store, nodeRef, "9".repeat(64));

  let checks = 0;
  expect(publicationGoalIntegrated(store, PROJECT_ID, GOAL_ID, candidate,
    () => { checks += 1; return true; })).toBe(true);
  expect(checks).toBe(0);
});

it("refuses the no-effect node when the intent history is UNREADABLE — null credits nothing", () => {
  // Fail closed. An intent was journaled and its bytes do not decode, so this gate cannot tell a
  // legitimate no-effect landing from a retry that lost its work, and credits neither.
  const { candidate, nodeRef, store } = publishWorld();
  seedReviewAcceptance(store, nodeRef);
  seedLandingReceipt(store, nodeRef, { refusalCode: "NOTHING_TO_COMMIT" });
  journalUnreadableIntent(store);

  expect(publicationGoalIntegrated(store, PROJECT_ID, GOAL_ID, candidate, () => true)).toBe(false);
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
