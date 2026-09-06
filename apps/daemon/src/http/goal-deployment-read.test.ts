import { afterEach, expect, it } from "vitest";
import { closeStores, driveThrough, envelope, GOAL_ID, openStore, PROJECT_ID, send } from "../bootstrap/bootstrap-test-fixtures.js";
import { recordDeployReceipt } from "../deployment/deploy-ledger.js";
import { readPublishLedger, recordPublishReceipt } from "../repository/publish-ledger.js";
import { recordReleaseReceipt } from "../release/release-receipt-ledger.js";
import { readGoalDeployments } from "./goal-deployment-read.js";

afterEach(closeStores);
const NOW = "2026-09-06T12:00:00.000Z";
it("joins a goal's published SHA and release to durable environment targets and receipts", () => {
  const store = openStore(); driveThrough(store, "goal.close");
  const publication = readPublishLedger(store, PROJECT_ID).get(GOAL_ID)!.requests.at(-1)!;
  const sha = "a".repeat(40);
  expect(recordPublishReceipt(store, { projectId: PROJECT_ID, goalId: GOAL_ID, decisionId: publication.decisionId,
    decidedAt: NOW, branch: "main", remoteUrl: publication.remoteUrl, refusal: null, sha, url: null }).ok).toBe(true);
  expect(send(store, envelope("deployment.set_target", 0, { environment: "preview", network: "moe-read",
    sshTarget: null, url: "https://preview.example.test" })).ok).toBe(true);
  expect(recordDeployReceipt(store, { projectId: PROJECT_ID, environment: "preview", decisionId: "earlier-deploy",
    decidedAt: NOW, imageDigest: `sha256:${"c".repeat(64)}`, refusal: null, releaseDecision: null,
    sha: "b".repeat(40), url: "https://preview.example.test" }).ok).toBe(true);
  const release = recordReleaseReceipt(store, { projectId: PROJECT_ID, goalId: GOAL_ID, sha,
    decidedAt: NOW, dossierSha256: "d".repeat(64), outcome: "RELEASED", refusalCode: null,
    prUrl: "https://github.com/example/product/pull/1" });
  if (!release.ok) throw new Error(release.code);
  const answer = readGoalDeployments(store, PROJECT_ID, GOAL_ID);
  expect(answer).toMatchObject({ outcome: "DEPLOYMENTS", goalRef: GOAL_ID, sha,
    releaseDecision: release.receipt.receiptId });
  if (answer.outcome !== "DEPLOYMENTS") throw new Error(answer.code);
  expect(answer.environments.find((row) => row.environment === "preview")).toMatchObject({
    target: "local Docker (moe-read)", outcome: "DEPLOYED", sha: "b".repeat(40), time: NOW,
  });
  expect(answer.environments.find((row) => row.environment === "production")).toMatchObject({
    target: null, outcome: null, sha: null,
  });
});

it("refuses foreign goals and does not call a queued publication a deployed SHA", () => {
  const store = openStore(); driveThrough(store, "goal.close");
  expect(readGoalDeployments(store, PROJECT_ID, "another-goal")).toMatchObject({ outcome: "REFUSED", code: "DEPLOYMENTS_GOAL_UNBOUND" });
  expect(readGoalDeployments(store, "another-project", GOAL_ID)).toMatchObject({ outcome: "REFUSED", code: "DEPLOYMENTS_GOAL_UNBOUND" });
  expect(readGoalDeployments(store, PROJECT_ID, GOAL_ID)).toMatchObject({ outcome: "DEPLOYMENTS", sha: null, releaseDecision: null });
});
