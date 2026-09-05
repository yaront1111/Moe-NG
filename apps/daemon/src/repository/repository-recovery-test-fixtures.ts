import { expect } from "vitest";
import { calibration, envelope, openStore, packageItems, policyInput, PROJECT_ID, send, SUBJECT_REF, submitPayload } from "../review/review-test-fixtures.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { NODE_VERIFIER_PRINCIPAL_ID, recordVerifierReceipt } from "../review/verifier-receipt-ledger.js";
import { recordLandingBaseline, recordLandingReceipt } from "./landing-ledger.js";
import type { RepositoryExecutionHandle } from "./repository-execution-contracts.js";
import type { VerifiedWorkspaceBinding } from "./verified-workspace-contracts.js";
import { recordRepositoryLandingCompletion, recordRepositoryLandingIntent } from "./repository-landing-intent.js";

export function recoveryEvidenceFixture(options: { legacy?: boolean; binding?: VerifiedWorkspaceBinding } = {}) {
  const store = openStore();
  const binding = options.binding ?? { version: "moe-verified-workspace/1", root: "D:/repository", branchRef: "refs/heads/trunk",
    headSha: "1".repeat(40), treeSha: "2".repeat(40), dirtySha256: "3".repeat(64) };
  const baseline = recordLandingBaseline(store, { projectId: PROJECT_ID, subjectRef: SUBJECT_REF, entries: [],
    observedAt: "2026-09-06T00:00:00.000Z", workspace: binding.root });
  if (!baseline.ok) throw new Error(baseline.code);
  expect(send(store, envelope("review.submit", 0, submitPayload(1, []), "source-review")).ok).toBe(true);
  const source = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds.at(-1)!;
  const verified = recordVerifierReceipt(store, { authority: { calibration: calibration(),
    packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"), policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }) },
    decidedAt: "2026-09-06T00:00:01.000Z", execution: { byteCount: 2, outputSha256: "a".repeat(64), test: "approved-check", workspace: binding.root,
      ...(options.legacy === true ? {} : { workspaceBinding: binding }) }, projectId: PROJECT_ID,
    source: { aggregateVersion: source.aggregateVersion, decisionId: source.decisionId, resultSha256: source.resultSha256 }, subjectRef: SUBJECT_REF });
  if (!verified.ok) throw new Error(verified.code);
  expect(send(store, envelope("integration.accept_output", verified.decision.currentVersion,
    { receiptId: verified.receipt.receiptId, subjectRef: SUBJECT_REF }, "accept-output")).ok).toBe(true);
  const handle: RepositoryExecutionHandle = {
    owner: { projectId: PROJECT_ID, nodeRef: SUBJECT_REF, ownershipToken: "b".repeat(64), storeId: "D:/store.sqlite" },
    reservation: { projectId: PROJECT_ID, nodeRef: SUBJECT_REF, storeId: "D:/store.sqlite", controllerId: "controller", controllerPid: 23,
      revision: 7, phase: "LANDING", baselineId: baseline.baselineId, sessionId: "session", pid: 31,
      identity: { root: binding.root, gitDirectory: `${binding.root}/.git` } },
  };
  const commit = { branch: binding.branchRef.slice(11), files: ["owned.txt"], message: "land\n", parentSha: binding.headSha, sha: "4".repeat(40) };
  const landed = (overrides = {}) => recordLandingReceipt(store, { projectId: PROJECT_ID, subjectRef: SUBJECT_REF, workspace: binding.root,
    decidedAt: "2026-09-06T00:00:02.000Z", verifierReceiptId: verified.receipt.receiptId, refusal: null, commit, ...overrides });
  const completed = (withCompletion = true) => {
    const written = recordRepositoryLandingIntent(store, { handle, binding, verifierReceiptId: verified.receipt.receiptId, paths: commit.files, message: commit.message });
    if (!written.ok) throw new Error(written.code);
    if (withCompletion) expect(recordRepositoryLandingCompletion(store, { intent: written.intent, commit }).ok).toBe(true);
    return written.intent;
  };
  return { store, binding, handle, verified, baseline, commit, landed, completed };
}
