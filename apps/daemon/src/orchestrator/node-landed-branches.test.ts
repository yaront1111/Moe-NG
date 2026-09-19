import { afterEach, expect, it } from "vitest";
import type { SqliteEventStore } from "@moe/store";
import { closeStores, GOAL_ID, PROJECT_ID, RUN_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { readCriterionGoal } from "../criterion-evidence/criterion-goal.js";
import {
  approveGate1, approvePlan, boundWorld, committedRevision, nodeOf, structureOf, submit,
} from "../planning/plan-reject-test-fixtures.js";
import { recordLandingReceipt } from "../repository/landing-ledger.js";
import { readReviewLedger } from "../review/review-read-model.js";
import {
  calibration, envelope, finding, packageItems, policyInput, submitPayload,
} from "../review/review-test-fixtures.js";
import { runReviewCommand } from "../review/review-services.js";
import { NODE_VERIFIER_PRINCIPAL_ID, recordVerifierReceipt } from "../review/verifier-receipt-ledger.js";
import { compiledExecutionRef } from "./compiled-execution-ref.js";
import { landedNodeBranches } from "./node-landed-branches.js";

afterEach(closeStores);
const NOW = "2026-09-16T10:00:00.000Z";

/** Two execution-bearing nodes, so a landed one and an unlanded one can be told apart. */
function world(): { readonly apiRef: string; readonly uiRef: string; readonly store: SqliteEventStore } {
  const store = boundWorld();
  const revision = committedRevision(store);
  approveGate1(store, revision);
  expect(submit(store, revision, {
    structure: structureOf([
      nodeOf("node-api", ["crit-api"], [], "Land the record read."),
      nodeOf("node-ui", ["crit-ui"], ["node-api"], "Land the page."),
    ], "node-ui"),
  }).ok).toBe(true);
  approvePlan(store, RUN_ID);
  const goal = readCriterionGoal(store, PROJECT_ID, GOAL_ID);
  if (!goal.ok) throw new Error(goal.code);
  return {
    apiRef: compiledExecutionRef(PROJECT_ID, goal.graph, "node-api"),
    store,
    uiRef: compiledExecutionRef(PROJECT_ID, goal.graph, "node-ui"),
  };
}

/** A real accepted verifier receipt for one node, through the review command path; its next clean round. */
function accept(store: SqliteEventStore, nodeRef: string): string {
  const review = (kind: string, version: number, payload: Record<string, unknown>): { ok: boolean } =>
    runReviewCommand(store, new TextEncoder().encode(JSON.stringify({
      ...envelope(kind, version, payload), projectId: PROJECT_ID,
    })));
  const before = readReviewLedger(store, PROJECT_ID, nodeRef);
  expect(review("review.submit", before.version, submitPayload(before.lineage.highestRound + 1, [], { subjectRef: nodeRef })).ok).toBe(true);
  const source = readReviewLedger(store, PROJECT_ID, nodeRef).rounds.at(-1);
  if (source === undefined) throw new Error("no review round to attest");
  const verified = recordVerifierReceipt(store, {
    authority: {
      calibration: calibration(),
      packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"),
      policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }),
    },
    decidedAt: NOW, execution: {
      byteCount: 2, outputSha256: "c".repeat(64), test: "pnpm test", workspace: "/fixture-workspace",
      workspaceBinding: {
        branchRef: "refs/heads/main", dirtySha256: "e".repeat(64), headSha: "a".repeat(40),
        root: "/fixture-workspace", treeSha: "d".repeat(40), version: "moe-verified-workspace/1",
      },
    },
    projectId: PROJECT_ID, source, subjectRef: nodeRef,
  });
  if (!verified.ok) throw new Error(verified.code);
  expect(review("integration.accept_output", verified.decision.currentVersion, {
    receiptId: verified.receipt.receiptId, subjectRef: nodeRef,
  }).ok).toBe(true);
  return verified.receipt.receiptId;
}

function land(store: SqliteEventStore, nodeRef: string, verifierReceiptId: string, branch: string, sha: string): void {
  expect(recordLandingReceipt(store, {
    commit: { branch, files: ["product.ts"], message: "Land product", parentSha: "b".repeat(40), sha },
    decidedAt: NOW, projectId: PROJECT_ID, refusal: null, subjectRef: nodeRef,
    verifierReceiptId, workspace: "/fixture-workspace",
  }).ok).toBe(true);
}

/**
 * What the integrator is allowed to merge (2026-09-16): a node's own branch, named by its own
 * durable receipts. Nothing else — an unaccepted node, an unlanded one, and work that landed on
 * the project's own branch all offer nothing to merge.
 */
it("offers only the branches accepted, landed nodes own", () => {
  const w = world();
  const landedSha = "1".repeat(40);
  land(w.store, w.apiRef, accept(w.store, w.apiRef), "moe/node-api-tree", landedSha);

  const nodes = [{ nodeRef: w.apiRef }, { nodeRef: w.uiRef }];

  // Landed in /fixture-workspace, which is no node's tree: offered by its `moe/` spelling, and marked
  // as a landing no gate waits on a merge record for.
  expect(landedNodeBranches(w.store, PROJECT_ID, nodes))
    .toEqual([{ branch: "moe/node-api-tree", fromTree: false, nodeRef: w.apiRef, sha: landedSha }]);
});

it("offers nothing for work that landed on the project's own branch", () => {
  const w = world();
  land(w.store, w.apiRef, accept(w.store, w.apiRef), "master", "2".repeat(40));

  expect(landedNodeBranches(w.store, PROJECT_ID, [{ nodeRef: w.apiRef }])).toEqual([]);
});

/** The host's withdrawal round (node-delivery-withdrawal.ts), through the same seam it uses. */
function withdraw(store: SqliteEventStore, nodeRef: string, verifierReceiptId: string): void {
  const ledger = readReviewLedger(store, PROJECT_ID, nodeRef);
  const latest = ledger.rounds.at(-1);
  if (latest === undefined) throw new Error("no accepted round to withdraw");
  expect(runReviewCommand(store, new TextEncoder().encode(JSON.stringify({
    ...envelope("review.submit", ledger.version, submitPayload(latest.round + 1, [finding()], { subjectRef: nodeRef }), "cmd-withdraw"),
    projectId: PROJECT_ID,
  })), undefined, undefined, { aggregateVersion: latest.aggregateVersion, decisionId: latest.decisionId,
    resultSha256: latest.resultSha256, withdraws: verifierReceiptId }).ok).toBe(true);
}

// UnAI 2026-09-19: a conflicted node stayed a candidate forever, so the integrator's halt never
// lifted. Withdrawn, it offers nothing; its old COMMITTED receipt is not the current acceptance's.
it("offers nothing for a withdrawn node, and its NEW sha once it is accepted and landed again", () => {
  const w = world();
  const first = accept(w.store, w.apiRef);
  land(w.store, w.apiRef, first, "moe/node-api-tree", "1".repeat(40));
  withdraw(w.store, w.apiRef, first);

  expect(readReviewLedger(w.store, PROJECT_ID, w.apiRef)).toMatchObject({ accepted: undefined, unreadable: false });
  expect(landedNodeBranches(w.store, PROJECT_ID, [{ nodeRef: w.apiRef }])).toEqual([]);

  const second = accept(w.store, w.apiRef);
  expect(second).not.toBe(first);
  // Accepted again but not landed again: the first landing answers for the first acceptance only.
  expect(landedNodeBranches(w.store, PROJECT_ID, [{ nodeRef: w.apiRef }])).toEqual([]);
  land(w.store, w.apiRef, second, "moe/node-api-tree", "3".repeat(40));

  expect(landedNodeBranches(w.store, PROJECT_ID, [{ nodeRef: w.apiRef }]))
    .toEqual([{ branch: "moe/node-api-tree", fromTree: false, nodeRef: w.apiRef, sha: "3".repeat(40) }]);
});

it("offers nothing for an accepted node that has not landed, or an unknown node", () => {
  const w = world();
  accept(w.store, w.apiRef);

  expect(landedNodeBranches(w.store, PROJECT_ID, [{ nodeRef: w.apiRef }, { nodeRef: "node:v1:unknown" }])).toEqual([]);
});
