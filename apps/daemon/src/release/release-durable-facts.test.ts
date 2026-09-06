import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { PROJECT_CONFIGURATION_LIMIT_KEYS } from "@moe/contracts";
import { createProjectConfigurationManifest, encodeProjectConfigurationManifest } from "@moe/core";
import { afterEach, expect, it, vi } from "vitest";

import { closeStores, driveThrough, envelope as bootstrapEnvelope, GOAL_CREATE_COMMAND_ID, GOAL_ID, PROJECT_ID, RUN_ID, send } from "../bootstrap/bootstrap-test-fixtures.js";
import { readCriterionGoal } from "../criterion-evidence/criterion-goal.js";
import { selectProjectConfiguration } from "../configuration/project-configuration-selection.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import {
  approveGate1, approvePlan, boundWorld, committedRevision, PRD, submit,
} from "../planning/plan-reject-test-fixtures.js";
import { runPreviewDecideEdge } from "../preview/preview-daemon-edge.js";
import { recordPreviewReceipt } from "../preview/preview-ledger.js";
import { previewAggregateId } from "../preview/preview-receipt-contracts.js";
import { recordLandingReceipt } from "../repository/landing-ledger.js";
import { createVerifiedWorkspacePort } from "../repository/git-verified-workspace-port.js";
import { VERIFIED_WORKSPACE_VERSION } from "../repository/verified-workspace-contracts.js";
import type { VerifiedWorkspaceBinding } from "../repository/verified-workspace-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { calibration, envelope, packageItems, policyInput, seedVerifierReceipt, submitPayload } from "../review/review-test-fixtures.js";
import { NODE_VERIFIER_PRINCIPAL_ID, recordVerifierReceipt } from "../review/verifier-receipt-ledger.js";
import { runReviewCommand } from "../review/review-services.js";
import { readReleaseDossierInput } from "./release-durable-facts.js";
import { releaseDossierId } from "./release-dossier-contracts.js";
import { readReleaseDossier, recordReleaseDossier } from "./release-dossier-ledger.js";
import { releaseDossierGaps, renderReleaseDossier } from "./release-dossier.js";
import { createProductionReleaseSeams } from "./release-production-wiring.js";

const NOW = "2026-09-06T00:00:00.000Z";
const SOURCE_SHA = "a".repeat(40);
const LANDING_SHA = "b".repeat(40);
afterEach(() => { vi.restoreAllMocks(); closeStores(); });

function world(store = boundWorld()) {
  const ref = committedRevision(store);
  approveGate1(store, ref);
  expect(submit(store, ref).ok).toBe(true);
  approvePlan(store, RUN_ID);
  const goal = readCriterionGoal(store, PROJECT_ID, GOAL_ID);
  if (!goal.ok) throw new Error(goal.code);
  return { store, nodeRef: compiledExecutionRef(PROJECT_ID, goal.graph, "node-slice") };
}

function accept(store: SqliteEventStore, nodeRef: string, bound = true, workspaceBinding: VerifiedWorkspaceBinding = {
  version: VERIFIED_WORKSPACE_VERSION, root: "/fixture-workspace", headSha: SOURCE_SHA,
  branchRef: "refs/heads/main", treeSha: "d".repeat(40), dirtySha256: "e".repeat(64),
}): string {
  const review = (kind: string, version: number, payload: Record<string, unknown>) => runReviewCommand(store,
    new TextEncoder().encode(JSON.stringify({ ...envelope(kind, version, payload), projectId: PROJECT_ID })));
  expect(review("review.submit", 0, submitPayload(1, [], { subjectRef: nodeRef })).ok).toBe(true);
  const source = readReviewLedger(store, PROJECT_ID, nodeRef).rounds.at(-1)!;
  const verified = recordVerifierReceipt(store, {
    authority: {
      calibration: calibration(), packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"),
      policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }),
    },
    decidedAt: NOW, projectId: PROJECT_ID, subjectRef: nodeRef, source,
    execution: {
      byteCount: 2, outputSha256: "c".repeat(64), test: "pnpm test", workspace: workspaceBinding.root,
      ...(bound ? { workspaceBinding } : {}),
    },
  });
  if (!verified.ok) throw new Error(verified.code);
  expect(review("integration.accept_output", verified.decision.currentVersion, {
    receiptId: verified.receipt.receiptId, subjectRef: nodeRef,
  }).ok).toBe(true);
  return verified.receipt.receiptId;
}

function land(store: SqliteEventStore, nodeRef: string, verifierReceiptId: string,
  sha = LANDING_SHA, parentSha = SOURCE_SHA, workspace = "/fixture-workspace"): void {
  expect(recordLandingReceipt(store, {
    commit: { branch: "main", files: ["product.ts"], message: "Land product", parentSha, sha },
    decidedAt: NOW, projectId: PROJECT_ID, refusal: null, subjectRef: nodeRef,
    verifierReceiptId, workspace,
  }).ok).toBe(true);
}

it("refuses absent, unapproved, and foreign-project goal scope", () => {
  const store = boundWorld();
  expect(readReleaseDossierInput(store, PROJECT_ID, GOAL_ID)).toBeNull();
  expect(readReleaseDossierInput(store, PROJECT_ID, "missing-goal")).toBeNull();
  expect(readReleaseDossierInput(world().store, "foreign-project", GOAL_ID)).toBeNull();
});

it("joins approved criteria to the scoped accepted verifier and its exact landing", () => {
  const { store, nodeRef } = world();
  const receiptId = accept(store, nodeRef);
  land(store, nodeRef, receiptId);
  const input = readReleaseDossierInput(store, PROJECT_ID, GOAL_ID);
  expect(input).toMatchObject({
    goalId: GOAL_ID, projectId: PROJECT_ID, goalTitle: "Dispatcher journey goal",
    criteria: [
      { criterionId: "crit-api", nodeKey: nodeRef, title: "The API answers a signed request with the record." },
      { criterionId: "crit-ui", nodeKey: nodeRef, title: "The page renders the record the API answered." },
    ],
    nodes: [{ nodeKey: nodeRef, landingSha: LANDING_SHA, sharedAcrossPlans: false,
      receipt: { receiptId, command: "pnpm test", exitCode: 0, sha: SOURCE_SHA } }],
    reviewRounds: [{ nodeKey: nodeRef, outcome: "ACCEPTED", refusalCode: null, round: 1 }],
    policyRevision: null, preview: null,
  });
});

it("keeps every approved criterion while missing receipt and landing evidence stay null", () => {
  const { store, nodeRef } = world();
  const input = readReleaseDossierInput(store, PROJECT_ID, GOAL_ID);
  expect(input?.criteria).toHaveLength(2);
  expect(input?.nodes).toEqual([{ landingSha: null, nodeKey: nodeRef, receipt: null, sharedAcrossPlans: false }]);
});

it("preserves an unknown verified SHA on a legacy receipt", () => {
  const { store, nodeRef } = world();
  const receiptId = accept(store, nodeRef, false);
  land(store, nodeRef, receiptId);
  expect(readReleaseDossierInput(store, PROJECT_ID, GOAL_ID)?.nodes[0]?.receipt)
    .toMatchObject({ receiptId, sha: null });
});

it("does not credit a landing for a different verifier receipt", () => {
  const { store, nodeRef } = world();
  const receiptId = accept(store, nodeRef);
  land(store, nodeRef, "f".repeat(64));
  expect(readReleaseDossierInput(store, PROJECT_ID, GOAL_ID)?.nodes[0])
    .toMatchObject({ landingSha: null, receipt: { receiptId } });
});

it("does not credit a verifier and landing before integration acceptance", () => {
  const { store, nodeRef } = world();
  const { receiptId } = seedVerifierReceipt(store, nodeRef, PROJECT_ID);
  land(store, nodeRef, receiptId);
  expect(readReleaseDossierInput(store, PROJECT_ID, GOAL_ID)?.nodes[0])
    .toMatchObject({ landingSha: null, receipt: null });
});

it("reports a rejected review round without treating it as accepted evidence", () => {
  const { store, nodeRef } = world();
  const result = runReviewCommand(store, new TextEncoder().encode(JSON.stringify({
    ...envelope("review.submit", 0, submitPayload(1, undefined, { subjectRef: nodeRef })), projectId: PROJECT_ID,
  })));
  expect(result.ok).toBe(true);
  const input = readReleaseDossierInput(store, PROJECT_ID, GOAL_ID);
  expect(input?.reviewRounds).toEqual([{ nodeKey: nodeRef, round: 1, outcome: "REFUSED", refusalCode: "REJECT_IMPLEMENTATION" }]);
  expect(input?.nodes[0]).toMatchObject({ landingSha: null, receipt: null });
});

it("does not credit bare node-key evidence to an immutable compiled execution", () => {
  const { store } = world();
  land(store, "node-slice", accept(store, "node-slice"));
  expect(readReleaseDossierInput(store, PROJECT_ID, GOAL_ID)?.nodes[0])
    .toMatchObject({ landingSha: null, receipt: null });
});

it("refuses receipt evidence whose bytes no longer match the accepted digest", () => {
  const { store, nodeRef } = world();
  const receiptId = accept(store, nodeRef);
  land(store, nodeRef, receiptId);
  const original = store.getCommandDecision.bind(store);
  const hostile = new Proxy(store, { get(target, key) {
    if (key === "getCommandDecision") return ((key: Parameters<typeof original>[0]) => {
      const decision = original(key);
      return key.commandId === receiptId && decision !== null
        ? { ...decision, resultSha256: "9".repeat(64) } : decision;
    });
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  expect(readReleaseDossierInput(hostile, PROJECT_ID, GOAL_ID)?.nodes[0])
    .toMatchObject({ landingSha: null, receipt: null });
});

it("reads the durable preview decision and its goal-bound receipt URL", () => {
  const { store, nodeRef } = world();
  land(store, nodeRef, accept(store, nodeRef));
  const preview = recordPreviewReceipt(store, {
    code: null, decidedAt: NOW, goalId: GOAL_ID, pid: 1234, projectId: PROJECT_ID,
    screenshots: [], sha: LANDING_SHA, url: "http://127.0.0.1:4173",
  });
  if (!preview.ok) throw new Error(preview.code);
  const decision = runPreviewDecideEdge({
    envelope: { commandId: "preview-approve", correlationId: "release", expectedVersion: store.getAggregateVersion(previewAggregateId(GOAL_ID)),
      payload: { decision: "APPROVE", previewRef: preview.receipt.receiptId } },
    now: () => NOW, port: { close: async () => undefined, release: () => undefined },
    principalId: "principal-1", projectId: PROJECT_ID, store,
  });
  expect(decision.resultCode).toBe("PREVIEW_DECISION_RECORDED");
  expect(readReleaseDossierInput(store, PROJECT_ID, GOAL_ID)?.preview).toMatchObject({
    decidedAt: NOW, outcome: "APPROVE", url: "http://127.0.0.1:4173",
  });
});

it("reads the selected project's durable policy revision", () => {
  const { store } = world();
  const created = createProjectConfigurationManifest(PROJECT_ID, {
    isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" },
    limits: PROJECT_CONFIGURATION_LIMIT_KEYS.map((key, index) => ({ key, value: index + 1 })),
    network: { daemonExposure: "LOOPBACK_ONLY", providerEgress: "EGRESS_ALLOWLISTED" },
    orchestrationSource: { objectFormat: "sha256", sourceSha: "1".repeat(64) },
    policy: { acceptanceGate: "MANUAL_HUMAN_APPROVAL", autoApprovalOptInDigest: null,
      evaluatorVersion: "policy-evaluator-v1", expansionGate: "MANUAL_HUMAN_APPROVAL",
      planningGate: "MANUAL_HUMAN_APPROVAL", policyRevisionId: "selected-policy-7", revision: 7 },
    schemaVersions: { commandSchemaVersion: "moe-command-1", errorSchemaVersion: "moe-error-1", querySchemaVersion: "moe-query-1" },
    selection: { modelRef: "model-1", profileRef: "profile-1", providerRef: "provider-1", reasoningEffortRef: "effort-1",
      runtimeRef: "runtime-1", snapshotRef: "snapshot-1", structuredOutputSchemaRef: "schema-1" },
  });
  if (!created.ok) throw new Error(created.code);
  const encoded = encodeProjectConfigurationManifest(created.manifest);
  if (!encoded.ok) throw new Error(encoded.code);
  expect(selectProjectConfiguration(store, {
    commandId: "select-release-policy", correlationId: "release", decidedAt: NOW, expectedVersion: 0,
    manifestBytes: encoded.bytes, principalId: "principal-1", projectId: PROJECT_ID,
  }).ok).toBe(true);
  expect(readReleaseDossierInput(store, PROJECT_ID, GOAL_ID)?.policyRevision).toBe("selected-policy-7");
});

it.each([false, true])("prepares a complete exact-SHA dossier and refuses stale immutable evidence: %s", async (poisoned) => {
  const directory = mkdtempSync(join(tmpdir(), "moe-release-durable-"));
  const workspace = join(directory, "product");
  mkdirSync(workspace);
  const storePath = join(directory, "store.sqlite");
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  const git = (...args: string[]): string => execFileSync("git", ["-C", workspace, ...args], {
    encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Release fixture");
    git("config", "user.email", "release@example.invalid");
    writeFileSync(join(workspace, "README.md"), "Initial product\n");
    git("add", "README.md"); git("commit", "-m", "Initial product");
    const sourceSha = git("rev-parse", "HEAD");
    writeFileSync(join(workspace, "product.ts"), "export const ready = true;\n");
    const captured = await createVerifiedWorkspacePort().capture(workspace);
    if (!captured.ok) throw new Error(captured.code);
    expect(captured.binding.headSha).toBe(sourceSha);

    installTestRecoveryBinding(store);
    driveThrough(store, "goal.create");
    expect(send(store, bootstrapEnvelope("goal.create_with_source", 0, {
      instructions: "Bind a PRD for the dispatcher journey.",
      source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
      title: "Dispatcher journey goal",
    }, GOAL_CREATE_COMMAND_ID)).ok).toBe(true);
    const { nodeRef } = world(store);
    const receiptId = accept(store, nodeRef, true, captured.binding);
    git("add", "product.ts"); git("commit", "-m", "Land product");
    const sha = git("rev-parse", "HEAD");
    const seams = createProductionReleaseSeams({ store, storePath, projectId: PROJECT_ID, workspace, clock: () => NOW });
    const dossierId = releaseDossierId(PROJECT_ID, GOAL_ID, sha);
    // An early click may precede the durable landing receipt. It must not freeze gaps forever.
    seams.dossierFacts(GOAL_ID, sha);
    expect(readReleaseDossier(store, PROJECT_ID, dossierId)).toMatchObject({
      ok: false, code: "RELEASE_DOSSIER_NOT_FOUND",
    });
    if (poisoned) {
      expect(recordReleaseDossier(store, { decidedAt: NOW, goalId: GOAL_ID, projectId: PROJECT_ID,
        sha, markdown: "# Stale incomplete evidence\n" }).ok).toBe(true);
    }
    land(store, nodeRef, receiptId, sha, sourceSha, workspace);
    const facts = seams.dossierFacts(GOAL_ID, sha);
    if (poisoned) {
      expect(facts).toBeNull();
      return;
    }
    expect(facts).not.toBeNull();
    if (facts === null) throw new Error("production dossier facts unavailable");
    expect(releaseDossierGaps(facts.input, sha, facts.ancestry)).toEqual([]);
    const persisted = readReleaseDossier(store, PROJECT_ID, dossierId);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) throw new Error(persisted.code);
    expect(persisted.dossier.sha).toBe(sha);
    expect(persisted.dossier.markdown).toBe(renderReleaseDossier(facts.input, sha, facts.ancestry));
    expect(persisted.dossier.markdown).toContain(sourceSha);
    expect(persisted.dossier.markdown).toContain(sha);
    expect(seams.dossierFacts(GOAL_ID, sha)).not.toBeNull();
    const repeated = readReleaseDossier(store, PROJECT_ID, dossierId);
    expect(repeated).toEqual(persisted);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
