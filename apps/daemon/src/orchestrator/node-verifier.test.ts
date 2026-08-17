import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject, RuntimeCommandEnvelope } from "@moe/contracts";
import { afterAll, describe, expect, it } from "vitest";

import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { VERIFIER_FAILURE_RULE } from "../http/affordance-read.js";
import type { AuthenticatedPrincipal, DecisionPortResult } from "../http/http-contract.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { runReviewCommand } from "../review/review-services.js";
import { REVIEWER_CALIBRATION_SLICE_REF } from "../review/reviewer-calibration-record.js";
import {
  VERIFIER_POLICY_SLICE_REF,
  createVerifierAuthorityProvider,
} from "../review/verifier-authority-provider.js";
import { verifierReceiptId } from "../review/verifier-receipt-contracts.js";
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

/**
 * The REAL composition: `createNodeVerifier` driven by the REAL
 * `createVerifierAuthorityProvider` over a store whose authority was installed by production
 * commands. No stub authority function appears in either case below, so what is exercised is the
 * path `agent-wrapper-main.ts` takes rather than a shape that merely resembles it.
 *
 * The two cases are deliberately one seed apart. `earns a receipt` and `still refuses` are
 * separate claims, and a suite proving only the first would pass against a provider that had
 * stopped failing closed.
 */

const AUTHORITY_OPERATOR = "verifier-authority-operator-credential";
const AUTHORITY_PRINCIPAL_ID = "operator-local";
const AUTHORITY_NODE = "node-authority-1";
const AUTHORITY_DECIDED_AT = "2026-08-17T00:00:00.000Z";

/** The round as an agent submits it: seven items, its own daemon receipt among them. */
const ROUND_ITEMS: readonly JsonObject[] = [
  { digest: fill("c1"), kind: "CRITERION", locator: "criterion-1" },
  { digest: fill("d1"), kind: "DAEMON_RECEIPT", locator: "receipt-1" },
  { digest: fill("6a"), kind: "GRAPH_HASH", locator: "graph-1" },
  { digest: fill("f1"), kind: "INTEGRATED_TREE", locator: "tree-1" },
  { digest: fill("b1"), kind: "PLAN_HASH", locator: "plan-1" },
  { digest: fill("2b"), kind: "RUBRIC", locator: "rubric-1" },
  { digest: fill("5b"), kind: "SUBMITTED_BYTES", locator: "submitted-1" },
];

/**
 * The calibration this project INSTALLS, deliberately not `AUTHORITY.calibration`.
 *
 * Its `corpusRevision` is a value no default and no plausible hard-coded stand-in would carry,
 * which is what lets the receipt assertion below pin the durable read. `AUTHORITY.calibration`
 * is `{corpus-1, true, CURRENT}` — legal, eligible, and exactly what a fabricated literal would
 * look like, so reusing it would make the comparison an equivalent mutant.
 */
const DURABLE_CALIBRATION = {
  corpusRevision: "corpus-authority-9c1d", sentinelPassed: true, staleness: "CURRENT" as const,
};

/** Those seven in the kernel's bind order, minus the round's own receipt. */
const EXPECTED_HOST_ITEMS = [
  { digest: fill("c1"), kind: "CRITERION", locator: "criterion-1" },
  { digest: fill("6a"), kind: "GRAPH_HASH", locator: "graph-1" },
  { digest: fill("b1"), kind: "PLAN_HASH", locator: "plan-1" },
  { digest: fill("2b"), kind: "RUBRIC", locator: "rubric-1" },
  { digest: fill("5b"), kind: "SUBMITTED_BYTES", locator: "submitted-1" },
  { digest: fill("f1"), kind: "INTEGRATED_TREE", locator: "tree-1" },
];

interface AuthorityProject {
  readonly deps: ReturnType<typeof createStoreDependencies>;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

const authorityProjects: AuthorityProject[] = [];
const authorityDirectories: string[] = [];

afterAll(() => {
  while (authorityProjects.length > 0) {
    const open = authorityProjects.pop();
    open?.store.close();
    open?.deps.close();
  }
  while (authorityDirectories.length > 0) {
    const open = authorityDirectories.pop();
    if (open !== undefined) rmSync(open, { force: true, recursive: true });
  }
});

function installSlice(
  project: AuthorityProject, slice: JsonObject, commandId: string, expectedVersion: number,
): void {
  const ports = createDaemonCommandPorts({
    clock: () => AUTHORITY_DECIDED_AT,
    operatorPrincipalId: AUTHORITY_PRINCIPAL_ID,
    projectId: project.projectId,
    store: project.store,
  });
  const entry = ports.registry.get("policy.install");
  if (entry === undefined) throw new Error("policy.install is not in the production registry");
  const envelope: RuntimeCommandEnvelope = {
    commandId,
    commandKind: "policy.install",
    correlationId: "corr-verifier-authority",
    expectedVersion,
    payload: { slice },
    requestDigest: fill("b"),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: AUTHORITY_OPERATOR,
    targetAggregateId: `${project.projectId}-policy`,
  };
  const principal: AuthenticatedPrincipal = {
    capabilities: ["project.admin"],
    principalId: AUTHORITY_PRINCIPAL_ID,
    projectId: project.projectId,
  };
  const result: DecisionPortResult = ports.decisions.decide(
    { commandId, principalId: AUTHORITY_PRINCIPAL_ID, projectId: project.projectId },
    fill("b"),
    () => entry.handler({ envelope, principal }),
  );
  if (result.outcome !== "DECIDED") {
    throw new Error(`install refused: ${result.refusal.code} at ${result.refusal.layer}`);
  }
}

/** One project seeded through production paths; `withCalibration` is the ONLY difference. */
function openAuthorityProject(name: string, withCalibration: boolean): AuthorityProject {
  const dir = mkdtempSync(join(tmpdir(), `moe-verifier-${name}-`));
  authorityDirectories.push(dir);
  const storePath = join(dir, "store.db");
  const projectId = `proj-verifier-${name}`;
  const deps = createStoreDependencies({
    credential: AUTHORITY_OPERATOR,
    principalId: AUTHORITY_PRINCIPAL_ID,
    projectId,
    storePath,
  });
  const opened = SqliteEventStore.openForProject(storePath, projectId);
  installTestRecoveryBinding(opened);
  const project: AuthorityProject = { deps, projectId, store: opened };
  authorityProjects.push(project);

  installSlice(project, {
    ...AUTHORITY.policy, sliceRef: VERIFIER_POLICY_SLICE_REF,
  } as unknown as JsonObject, "cmd-install-verifier-policy", 0);
  if (withCalibration) {
    installSlice(project, {
      ...DURABLE_CALIBRATION, sliceRef: REVIEWER_CALIBRATION_SLICE_REF,
    }, "cmd-install-calibration", 1);
  }
  const clean = runReviewCommand(project.store, encoder.encode(JSON.stringify({
    commandId: `seed-authority-round-${name}`,
    correlationId: "seed",
    decidedAt: AUTHORITY_DECIDED_AT,
    expectedVersion: 0,
    kind: "review.submit",
    payload: { findings: [], packageItems: ROUND_ITEMS, round: 1, subjectRef: AUTHORITY_NODE },
    principalId: "sess-agent-authority",
    projectId,
    schemaVersion: "moe-review-command/1",
  })));
  if (!clean.ok) throw new Error(`clean round seed failed: ${clean.code}`);
  return project;
}

function realVerifier(
  project: AuthorityProject, capture: VerifierRunCapture, onRun: () => void,
) {
  return createNodeVerifier({
    deps: project.deps.provide(),
    mintId: () => `va-${Math.random().toString(36).slice(2, 10)}`,
    nodeMission: () => ({
      instructions: "x", test: "node test.mjs", title: "t", workspace: "/authority-workspace",
    }),
    nodes: () => [{ nodeRef: AUTHORITY_NODE }],
    operatorCredential: AUTHORITY_OPERATOR,
    projectId: project.projectId,
    runTest: () => {
      onRun();
      return Promise.resolve(capture);
    },
    store: project.store,
    verificationAuthority: createVerifierAuthorityProvider({
      projectId: project.projectId, store: project.store,
    }),
  });
}

describe("createNodeVerifier over the production authority provider", () => {
  it("earns a receipt whose facts are exactly what the durable provider produced", async () => {
    const project = openAuthorityProject("accepts", true);
    const latest = readReviewLedger(project.store, project.projectId, AUTHORITY_NODE).rounds.at(-1);
    if (latest === undefined) throw new Error("seeded round did not read back");
    const facts = createVerifierAuthorityProvider({
      projectId: project.projectId, store: project.store,
    })(AUTHORITY_NODE, {
      instructions: "x", test: "node test.mjs", title: "t", workspace: "/authority-workspace",
    });
    if (facts === null) throw new Error("the durable provider refused a fully seeded project");
    expect(facts.packageItems).toEqual(EXPECTED_HOST_ITEMS);

    const output = "authority sandbox tests passed";
    const sha = createHash("sha256").update(output, "utf8").digest("hex");
    let runs = 0;
    const reports = await realVerifier(
      project, { byteCount: output.length, exitCode: 0, output, sha256: sha }, () => { runs += 1; },
    ).verifyOnce();

    expect(reports).toEqual([
      { detail: "EFFECTS_COMMITTED", nodeRef: AUTHORITY_NODE, outcome: "ACCEPTED" },
    ]);
    expect(runs).toBe(1);
    const expectedReceiptId = verifierReceiptId(
      project.projectId, AUTHORITY_NODE, latest.decisionId,
    );
    const stored = readVerifierReceipt(project.store, project.projectId, expectedReceiptId);
    expect(stored.ok, stored.ok ? "" : stored.code).toBe(true);
    if (!stored.ok) throw new Error(stored.code);
    // The receipt's IDENTITY, then its CONTENTS: `ok: true` alone would pass against a receipt
    // recorded for some other round carrying some other authority.
    expect(stored.receipt.receiptId).toBe(expectedReceiptId);
    expect(stored.receipt.subjectRef).toBe(AUTHORITY_NODE);
    expect(stored.receipt.source.decisionId).toBe(latest.decisionId);
    expect(stored.receipt.execution.outputSha256).toBe(sha);
    expect(stored.receipt.execution.byteCount).toBe(output.length);
    // Compared against what was INSTALLED, never against `facts` alone: the receipt is built from
    // the provider's output, so `receipt.calibration === facts.calibration` holds unconditionally
    // and would stay green against a provider that hard-coded both. One operand has to come from
    // outside the provider, and these three do.
    expect(stored.receipt.calibration).toEqual(DURABLE_CALIBRATION);
    expect(stored.receipt.policy).toEqual(AUTHORITY.policy);
    expect(facts.calibration).toEqual(DURABLE_CALIBRATION);
    // The provider's host-owned items, in order, plus the ONE receipt the daemon appended for
    // the run it just performed. The withheld round receipt is what makes room for it.
    expect(stored.receipt.packageItems).toEqual([
      ...EXPECTED_HOST_ITEMS,
      {
        digest: stored.receipt.execution.evidenceSha256,
        kind: "DAEMON_RECEIPT",
        locator: `verifier:${AUTHORITY_NODE}:${latest.decisionId}`,
      },
    ]);
    // Read back through the acceptance the dispatch committed, not only through the receipt row.
    const ledger = readReviewLedger(project.store, project.projectId, AUTHORITY_NODE);
    expect(ledger.accepted?.verifierReceiptId).toBe(expectedReceiptId);
  });

  it("still refuses VERIFICATION_AUTHORITY_UNAVAILABLE when the calibration is not installed",
    async () => {
      const project = openAuthorityProject("refuses", false);
      const latest = readReviewLedger(
        project.store, project.projectId, AUTHORITY_NODE,
      ).rounds.at(-1);
      if (latest === undefined) throw new Error("seeded round did not read back");
      const output = "authority sandbox tests passed";
      const sha = createHash("sha256").update(output, "utf8").digest("hex");
      let runs = 0;

      const reports = await realVerifier(
        project, { byteCount: output.length, exitCode: 0, output, sha256: sha },
        () => { runs += 1; },
      ).verifyOnce();

      expect(reports).toEqual([{
        detail: "host verifier authority unavailable",
        nodeRef: AUTHORITY_NODE,
        outcome: "VERIFICATION_AUTHORITY_UNAVAILABLE",
      }]);
      // The authority check at node-verifier.ts:165 precedes the run at :174. Only a call-count
      // assertion can prove that ordering survived: a reordered verifier would still report the
      // same outcome while having already executed the subject's test.
      expect(runs).toBe(0);
      const receipt = readVerifierReceipt(
        project.store, project.projectId,
        verifierReceiptId(project.projectId, AUTHORITY_NODE, latest.decisionId),
      );
      expect(receipt.ok).toBe(false);
      expect(receipt.ok ? null : receipt.code).toBe("VERIFIER_RECEIPT_NOT_FOUND");
      expect(readReviewLedger(project.store, project.projectId, AUTHORITY_NODE).accepted)
        .toBeUndefined();
    });
});
