import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { VERIFIER_FAILURE_RULE } from "../http/affordance-read.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { runReviewCommand } from "../review/review-services.js";
import {
  NODE_VERIFIER_PRINCIPAL_ID,
  readVerifierReceipt,
} from "../review/verifier-receipt-ledger.js";
import { createNodeVerifier } from "./node-verifier.js";
import type { VerifierRunCapture } from "./node-verifier.js";

/**
 * Over the REAL provider and store: the verifier's consequences are read back
 * from the review ledger, never from its own reports.
 */

const OPERATOR = "verifier-operator-credential";
const PROJECT = "proj-verifier";
const NODE = "node-verify-1";
const directory = mkdtempSync(join(tmpdir(), "moe-verifier-"));
const provider = createStoreDependencies({
  credential: OPERATOR,
  principalId: "operator-local",
  projectId: PROJECT,
  storePath: join(directory, "store.db"),
});

// Project-asserted handle: the clean-round seeds are durable WRITES.
import { SqliteEventStore } from "@moe/store";
const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);
installTestRecoveryBinding(store);

afterAll(() => {
  store.close();
  provider.close();
  rmSync(directory, { force: true, recursive: true });
});

const encoder = new TextEncoder();
const fill = (seed: string): string =>
  (seed.replace(/[^0-9a-f]/gu, "0") + "0".repeat(64)).slice(0, 64);

function seedCleanRound(): void {
  const outcome = runReviewCommand(store, encoder.encode(JSON.stringify({
    commandId: "seed-clean-round",
    correlationId: "seed",
    decidedAt: "2026-08-11T09:00:00.000Z",
    expectedVersion: 0,
    kind: "review.submit",
    payload: {
      findings: [],
      packageItems: [
        { digest: fill("c1"), kind: "CRITERION", locator: "criterion-1" },
        { digest: fill("d1"), kind: "DAEMON_RECEIPT", locator: "receipt-1" },
        { digest: fill("6a"), kind: "GRAPH_HASH", locator: "graph-1" },
        { digest: fill("f1"), kind: "INTEGRATED_TREE", locator: "tree-1" },
        { digest: fill("b1"), kind: "PLAN_HASH", locator: "plan-1" },
        { digest: fill("2b"), kind: "RUBRIC", locator: "rubric-1" },
        { digest: fill("5b"), kind: "SUBMITTED_BYTES", locator: "submitted-1" },
      ],
      round: 1,
      subjectRef: NODE,
    },
    principalId: "sess-agent-x",
    projectId: PROJECT,
    schemaVersion: "moe-review-command/1",
  })));
  if (!outcome.ok) throw new Error(`seed failed: ${outcome.code}`);
}

const AUTHORITY = {
  calibration: { corpusRevision: "corpus-1", sentinelPassed: true, staleness: "CURRENT" as const },
  packageItems: [
    { digest: fill("c1"), kind: "CRITERION", locator: "criterion-1" },
    { digest: fill("6a"), kind: "GRAPH_HASH", locator: "graph-1" },
    { digest: fill("f1"), kind: "INTEGRATED_TREE", locator: "tree-1" },
    { digest: fill("b1"), kind: "PLAN_HASH", locator: "plan-1" },
    { digest: fill("2b"), kind: "RUBRIC", locator: "rubric-1" },
    { digest: fill("5b"), kind: "SUBMITTED_BYTES", locator: "submitted-1" },
  ],
  policy: {
    action: "integration.accept_output",
    actor: NODE_VERIFIER_PRINCIPAL_ID,
    callerRiskHint: "R1" as const,
    decisionDigest: fill("d1"),
    evaluatedAtEpochMs: 1_760_000_000_000,
    evaluatorVersion: "daemon-verifier-1",
    facts: [{ factId: "fact-review-risk", tier: "R1" as const, truthClass: "DAEMON_VERIFIED" as const }],
    graphNodeRevisionRefs: [],
    policyRevisionRef: fill("a1"),
    requiredFactIds: [],
    scope: [],
    sliceChain: [{
      autoApprovalOptIns: [{ action: "integration.accept_output", tier: "R1" as const }],
      rules: [],
      sliceRef: fill("a1"),
    }],
    waivers: [],
  },
};

function verifier(
  capture: VerifierRunCapture,
  authority: typeof AUTHORITY | null = AUTHORITY,
  onRun: () => void = () => undefined,
) {
  return createNodeVerifier({
    deps: provider.provide(),
    mintId: () => `v-${Math.random().toString(36).slice(2, 10)}`,
    nodeMission: () => ({
      instructions: "x", test: "node test.mjs", title: "t", workspace: directory,
    }),
    nodes: () => [{ nodeRef: NODE }],
    operatorCredential: OPERATOR,
    projectId: PROJECT,
    runTest: () => {
      onRun();
      return Promise.resolve(capture);
    },
    store,
    verificationAuthority: () => authority,
  });
}

describe("createNodeVerifier", () => {
  it("skips a node with nothing submitted", async () => {
    const reports = await verifier({ byteCount: 0, exitCode: 0, output: "", sha256: fill("aa") }).verifyOnce();
    expect(reports).toHaveLength(0);
  });

  it("records a verifier-test-failed round on a red run, putting the node back to READY", async () => {
    seedCleanRound();
    const output = "assertion failed: expected 5";
    const sha = createHash("sha256").update(output, "utf8").digest("hex");
    let missingAuthorityRuns = 0;
    const unavailable = await verifier(
      { byteCount: output.length, exitCode: 1, output, sha256: sha },
      null,
      () => { missingAuthorityRuns += 1; },
    ).verifyOnce();
    expect(unavailable).toEqual([{
      detail: "host verifier authority unavailable",
      nodeRef: NODE,
      outcome: "VERIFICATION_AUTHORITY_UNAVAILABLE",
    }]);
    expect(missingAuthorityRuns).toBe(0);
    expect(readReviewLedger(store, PROJECT, NODE).version).toBe(1);

    const reports = await verifier({ byteCount: output.length, exitCode: 1, output, sha256: sha }).verifyOnce();
    expect(reports).toEqual([
      { detail: "exit 1", nodeRef: NODE, outcome: "FAILED_ROUND_RECORDED" },
    ]);
    const ledger = readReviewLedger(store, PROJECT, NODE);
    expect(ledger.accepted).toBeUndefined();
    const failure = ledger.lineage.records.find(
      (record) => record.finding.ruleId === VERIFIER_FAILURE_RULE,
    );
    expect(failure?.round).toBe(ledger.version);
    expect(failure?.finding.detail).toContain(sha);
  });

  it("does not re-verify a node whose latest round is its own failure", async () => {
    const reports = await verifier({ byteCount: 0, exitCode: 0, output: "", sha256: fill("bb") }).verifyOnce();
    expect(reports).toHaveLength(0);
  });

  it("accepts a green run with the REAL capture digest bound into the receipt", async () => {
    // The agent recodes and submits a clean round 3 (version is 2 after the
    // verifier's failure round).
    const ledgerBefore = readReviewLedger(store, PROJECT, NODE);
    const outcome = runReviewCommand(store, encoder.encode(JSON.stringify({
      commandId: "seed-clean-round-3",
      correlationId: "seed",
      decidedAt: "2026-08-11T09:10:00.000Z",
      expectedVersion: ledgerBefore.version,
      kind: "review.submit",
      payload: {
        findings: [],
        packageItems: [
          { digest: fill("c1"), kind: "CRITERION", locator: "criterion-1" },
          { digest: fill("d1"), kind: "DAEMON_RECEIPT", locator: "receipt-1" },
          { digest: fill("6a"), kind: "GRAPH_HASH", locator: "graph-1" },
          { digest: fill("f1"), kind: "INTEGRATED_TREE", locator: "tree-1" },
          { digest: fill("b1"), kind: "PLAN_HASH", locator: "plan-1" },
          { digest: fill("2b"), kind: "RUBRIC", locator: "rubric-1" },
          { digest: fill("5b"), kind: "SUBMITTED_BYTES", locator: "submitted-1" },
        ],
        round: ledgerBefore.version + 1,
        subjectRef: NODE,
      },
      principalId: "sess-agent-x",
      projectId: PROJECT,
      schemaVersion: "moe-review-command/1",
    })));
    if (!outcome.ok) throw new Error(`recode seed failed: ${outcome.code}`);

    const greenOutput = "sandbox tests passed";
    const greenSha = createHash("sha256").update(greenOutput, "utf8").digest("hex");
    const reports = await verifier({
      byteCount: greenOutput.length, exitCode: 0, output: greenOutput, sha256: greenSha,
    }).verifyOnce();
    expect(reports).toEqual([
      { detail: "EFFECTS_COMMITTED", nodeRef: NODE, outcome: "ACCEPTED" },
    ]);
    const ledger = readReviewLedger(store, PROJECT, NODE);
    expect(ledger.accepted).toBeDefined();
    const receiptId = ledger.accepted?.verifierReceiptId;
    if (receiptId === undefined) throw new Error("acceptance omitted receipt id");
    const receipt = readVerifierReceipt(store, PROJECT, receiptId);
    expect(receipt.ok, receipt.ok ? "" : receipt.code).toBe(true);
    if (!receipt.ok) throw new Error(receipt.code);
    expect(receipt.receipt.execution.outputSha256).toBe(greenSha);
    expect(receipt.receipt.execution.byteCount).toBe(greenOutput.length);
    expect(receipt.receipt.packageItems).toContainEqual(expect.objectContaining({
      digest: receipt.receipt.execution.evidenceSha256,
      kind: "DAEMON_RECEIPT",
    }));
    expect(ledger.accepted?.reviewInputDigest).toBe(receipt.receipt.reviewInputDigest);
    expect(ledger.accepted?.verifierReceiptSha256).toBe(receipt.receiptSha256);
  });
});
