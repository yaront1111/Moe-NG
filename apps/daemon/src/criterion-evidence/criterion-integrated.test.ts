import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCriterionCheckExecutor } from "@moe/runner";
import { closeStores, GOAL_ID, PROJECT_ID, RUN_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  approveGate1, approvePlan, boundWorld, committedRevision, nodeOf, structureOf, submit,
} from "../planning/plan-reject-test-fixtures.js";
import { seedLandingReceipt, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { criterionWorld } from "./criterion-test-fixtures.js";
import { readCriterionGoal } from "./criterion-goal.js";
import type { CriterionGoal } from "./criterion-goal.js";
import { readIntegratedCriterionArtifact } from "./criterion-artifact.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { createVerifiedWorkspacePort } from "../repository/git-verified-workspace-port.js";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import { recordLandingReceipt } from "../repository/landing-ledger.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { calibration, packageItems, policyInput, submitPayload } from "../review/review-test-fixtures.js";
import { NODE_VERIFIER_PRINCIPAL_ID, recordVerifierReceipt } from "../review/verifier-receipt-ledger.js";
import { runReviewCommand } from "../review/review-services.js";
import { createDocumentCoverageReadPort } from "../http/document-coverage-read.js";
vi.mock("../../../../packages/runner/src/platform/windows/windows-broker-path.js", async (original) => {
  const actual = await original<{ resolveBrokerBinary(): unknown }>();
  return { ...actual, resolveBrokerBinary: () => process.env["MOE_TEST_APPROVED_BROKER"] ?? actual.resolveBrokerBinary() };
});

afterEach(closeStores);
const git = (root: string, args: string[]): string => execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8", windowsHide: true, timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
}).trim();

it("records the native criterion outcome on the integrated Git SHA and invalidates coverage when it changes", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-criteria-integrated-")));
  const executor = createCriterionCheckExecutor();
  const execution = vi.spyOn(executor, "run");
  const fixture = criterionWorld({ workspace: root, executor });
  const { store, service, approveAll, verifyInput } = fixture;
  try {
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "--local", "commit.gpgsign", "false"]);
    git(root, ["config", "user.name", "Criterion fixture"]); git(root, ["config", "user.email", "criterion@example.invalid"]);
    writeFileSync(join(root, "README.md"), "initial\n"); git(root, ["add", "README.md"]); git(root, ["commit", "-m", "initial"]);
    writeFileSync(join(root, "product.txt"), "working\n");
    const graph = activeCompiledGraphs(store, PROJECT_ID)[0]!;
    const nodeRef = compiledExecutionRef(PROJECT_ID, graph, "node-slice");
    const port = createVerifiedWorkspacePort(); const captured = await port.capture(root);
    if (!captured.ok) throw new Error(captured.code);
    const review = (kind: string, expectedVersion: number, payload: unknown, commandId: string) => runReviewCommand(store,
      new TextEncoder().encode(JSON.stringify({ kind, expectedVersion, payload, commandId, projectId: PROJECT_ID,
        principalId: "author-1", correlationId: "criterion-fixture", decidedAt: "2026-09-06T00:00:00.000Z", schemaVersion: "moe-review-command/1" })));
    expect(review("review.submit", 0, submitPayload(1, [], { subjectRef: nodeRef }), "review-source").ok).toBe(true);
    const source = readReviewLedger(store, PROJECT_ID, nodeRef).rounds.at(-1)!;
    const verified = recordVerifierReceipt(store, { authority: { calibration: calibration(),
      packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"), policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }) },
      decidedAt: "2026-09-06T00:00:00.000Z", execution: { byteCount: 2, outputSha256: "a".repeat(64),
        test: "generic-suite", workspace: root, workspaceBinding: captured.binding }, projectId: PROJECT_ID,
      source: { aggregateVersion: source.aggregateVersion, decisionId: source.decisionId, resultSha256: source.resultSha256 }, subjectRef: nodeRef });
    if (!verified.ok) throw new Error(verified.code);
    expect(review("integration.accept_output", verified.decision.currentVersion, { receiptId: verified.receipt.receiptId, subjectRef: nodeRef }, "accept-node").ok).toBe(true);
    const committed = await port.commit(root, ["product.txt"], "land product\n", captured.binding);
    if (!committed.ok) throw new Error(committed.code);
    expect(recordLandingReceipt(store, { projectId: PROJECT_ID, subjectRef: nodeRef, workspace: root,
      decidedAt: "2026-09-06T00:00:00.000Z", verifierReceiptId: verified.receipt.receiptId,
      refusal: null, commit: { ...committed.receipt, files: ["product.txt"], message: "land product\n" } }).ok).toBe(true);
    const coverage = createDocumentCoverageReadPort({ projectId: PROJECT_ID, store });
    expect(coverage.readCoverage({ goalRef: GOAL_ID })).toMatchObject({ totals: { verified: 0, criteria: 2 } });
    approveAll(["-e", "if(require('fs').readFileSync('product.txt','utf8')!=='working\\n')process.exit(7);process.stdout.write('criterion passed')"]);
    const read = service.read(GOAL_ID); if (read.outcome !== "CRITERION_EVIDENCE") throw new Error(read.code);
    expect(read.integratedArtifact?.sha).toBe(committed.receipt.sha);
    expect(service.verify(verifyInput(committed.receipt.sha))).toMatchObject({ ok: true });
    await service.advance();
    const after = service.read(GOAL_ID);
    if (process.platform === "win32") {
      // Name the execution port's own refusal before asserting the outcome, so a host whose broker
      // cannot serve the check reports that code instead of an opaque mismatch. Order is
      // load-bearing and was settled by drilling it: a refusing port makes the runner block after
      // the FIRST criterion, so an exact-count assertion placed above the sweep fires first and
      // hides the code behind "expected length 2, got 1". Guard non-vacuity only (a zero-length
      // results list would make the sweep pass while proving nothing), then name the refusal, then
      // pin the full roster.
      expect(execution.mock.results.length).toBeGreaterThan(0);
      const refusals = (await Promise.all(execution.mock.results.map(async (entry) =>
        entry.type === "return" ? (await entry.value).refusal : null))).filter((row) => row !== null);
      expect(refusals, "criterion execution port refused; scoped checks cannot complete").toEqual([]);
      expect(execution.mock.results).toHaveLength(2);
      expect(after).toMatchObject({ run: { status: "COMPLETED", integratedSha: committed.receipt.sha },
        criteria: [{ evidence: { status: "PASSED", sha: committed.receipt.sha, byteCount: 16 } },
          { evidence: { status: "PASSED", sha: committed.receipt.sha, byteCount: 16 } }] });
      expect(createRepositoryExecutionPort().inspect(root)).toMatchObject({ ok: true, reservation: null });
      expect(coverage.readCoverage({ goalRef: GOAL_ID })).toMatchObject({ totals: { verified: 2, criteria: 2 } });
    } else {
      // Observe the real executor's refusal; unsupported containment cannot authorize closure.
      expect(execution).toHaveBeenCalledTimes(1);
      expect(await execution.mock.results[0]?.value).toMatchObject({ containment: "UNKNOWN", exitCode: null,
        byteCount: 0, refusal: { code: "PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED" } });
      expect(after).toMatchObject({ run: { status: "BLOCKED", integratedSha: committed.receipt.sha },
        criteria: [{ evidence: { status: "UNKNOWN", sha: committed.receipt.sha, exitCode: null, byteCount: 0 } },
          { evidence: null }] });
      expect(createRepositoryExecutionPort().inspect(root)).toMatchObject({ ok: true, reservation: { phase: "BLOCKED" } });
      expect(coverage.readCoverage({ goalRef: GOAL_ID })).toMatchObject({ totals: { verified: 0, criteria: 2 } });
    }
    writeFileSync(join(root, "README.md"), "changed integrated artifact\n");
    git(root, ["add", "README.md"]); git(root, ["commit", "-m", "new integration"]);
    expect(coverage.readCoverage({ goalRef: GOAL_ID })).toMatchObject({ totals: { verified: 0, criteria: 2 } });
    expect(service.read(GOAL_ID)).toMatchObject({ criteria: [{ evidence: { sha: committed.receipt.sha } },
      { evidence: process.platform === "win32" ? { sha: committed.receipt.sha } : null }] });
  } finally { await service.close(); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
}, 300000);

/**
 * A NO-EFFECT LANDING IS "ACCEPTED, WITH NO SHA TO BIND" — NOT AN UNLANDED NODE.
 *
 * Decision recorded on task-f7d38f752b074dc89da30631783aae04 (reading A): a node whose landing
 * refused NOTHING_TO_COMMIT ran, was accepted, and provably had nothing to commit. Gates that
 * COUNT landings count it; gates that BIND shas SKIP it, exactly as they already skip a node with
 * no landing at all. This is the load-bearing seam — `readIntegratedCriterionArtifact` answering
 * null makes criterion-run.ts:68-69 refuse CRITERION_CHECK_INTEGRATED_ARTIFACT_CHANGED and leaves
 * goal.close at GOAL_CLOSE_CRITERIA_UNVERIFIED forever, for the COMMON mixed goal.
 *
 * WHY THE MIXED ARM PINS "EXACTLY ONE ANCESTRY CHECK, NODE-A'S", WITHOUT COUNTING CALLS.
 * node-b's receipt is the production shape for a refusal: commit null, and a workspace
 * (D:/fixture-workspace) that is not the artifact root. Had the loop BOUND node-b it would answer
 * null at criterion-artifact.ts:51 (landing.receipt.commit === null) and again at :56 (identity
 * root mismatch), so a NON-NULL artifact is proof the loop reached the skip for node-b and ran
 * the merge-base for node-a alone. The `unreachable ancestry` arm pins the other half — that the
 * merge-base really does execute for the committed node, so the skip is not vacuous.
 */
const NO_EFFECT = Object.freeze({ refusalCode: "NOTHING_TO_COMMIT" });
const POST_INTENT = Object.freeze({ refusalCode: "GIT_COMMIT_FAILED" });

function repo(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "--local", "commit.gpgsign", "false"]);
  git(root, ["config", "user.name", "Criterion fixture"]);
  git(root, ["config", "user.email", "criterion@example.invalid"]);
  writeFileSync(join(root, "README.md"), "initial\n");
  git(root, ["add", "README.md"]); git(root, ["commit", "-m", "initial"]);
  return root;
}

/** The world under test with the node roster the arm asks for, read back through production. */
function integratedWorld(nodeKeys: readonly string[]): {
  readonly goal: CriterionGoal;
  readonly refOf: (nodeKey: string) => string;
  readonly store: ReturnType<typeof boundWorld>;
} {
  const store = boundWorld(); const ref = committedRevision(store);
  approveGate1(store, ref);
  // Every criterion of the contract must be covered by some node or the compiler refuses, so a
  // one-node roster carries both and a two-node roster splits them.
  const structure = structureOf(
    nodeKeys.map((key, index) => nodeOf(key,
      nodeKeys.length === 1 ? ["crit-api", "crit-ui"] : [index === 0 ? "crit-api" : "crit-ui"],
      index === 0 ? [] : [nodeKeys[index - 1]!])),
    nodeKeys.at(-1)!,
  );
  expect(submit(store, ref, { structure }).ok).toBe(true);
  approvePlan(store, RUN_ID);
  const graph = activeCompiledGraphs(store, PROJECT_ID)[0]!;
  const goal = readCriterionGoal(store, PROJECT_ID, GOAL_ID);
  if (!goal.ok) throw new Error(goal.code);
  // Non-vacuity: the roster the seam walks really is the one this arm seeded.
  expect(goal.graph.content.snapshot.nodes.filter((node) => node.executionBearing)
    .map((node) => node.nodeKey)).toEqual([...nodeKeys]);
  return { goal, refOf: (key: string): string => compiledExecutionRef(PROJECT_ID, graph, key), store };
}

/** Drives ONE node through the shipped review, verified-workspace and landing path, for real. */
async function landForReal(
  store: ReturnType<typeof boundWorld>, root: string, nodeRef: string, file: string,
): Promise<string> {
  writeFileSync(join(root, file), "working\n");
  const port = createVerifiedWorkspacePort(); const captured = await port.capture(root);
  if (!captured.ok) throw new Error(captured.code);
  const review = (kind: string, expectedVersion: number, payload: unknown, commandId: string) => runReviewCommand(store,
    new TextEncoder().encode(JSON.stringify({ kind, expectedVersion, payload, commandId, projectId: PROJECT_ID,
      principalId: "author-1", correlationId: "criterion-no-effect", decidedAt: "2026-09-06T00:00:00.000Z",
      schemaVersion: "moe-review-command/1" })));
  expect(review("review.submit", 0, submitPayload(1, [], { subjectRef: nodeRef }), `submit-${nodeRef}`).ok).toBe(true);
  const source = readReviewLedger(store, PROJECT_ID, nodeRef).rounds.at(-1)!;
  const verified = recordVerifierReceipt(store, { authority: { calibration: calibration(),
    packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"), policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }) },
    decidedAt: "2026-09-06T00:00:00.000Z", execution: { byteCount: 2, outputSha256: "a".repeat(64),
      test: "generic-suite", workspace: root, workspaceBinding: captured.binding }, projectId: PROJECT_ID,
    source: { aggregateVersion: source.aggregateVersion, decisionId: source.decisionId, resultSha256: source.resultSha256 },
    subjectRef: nodeRef });
  if (!verified.ok) throw new Error(verified.code);
  expect(review("integration.accept_output", verified.decision.currentVersion,
    { receiptId: verified.receipt.receiptId, subjectRef: nodeRef }, `accept-${nodeRef}`).ok).toBe(true);
  const committed = await port.commit(root, [file], `land ${file}\n`, captured.binding);
  if (!committed.ok) throw new Error(committed.code);
  expect(recordLandingReceipt(store, { projectId: PROJECT_ID, subjectRef: nodeRef, workspace: root,
    decidedAt: "2026-09-06T00:00:00.000Z", verifierReceiptId: verified.receipt.receiptId,
    refusal: null, commit: { ...committed.receipt, files: [file], message: `land ${file}\n` } }).ok).toBe(true);
  return committed.receipt.sha;
}

describe("the integrated criterion artifact over a node that landed nothing", () => {
  it("RESOLVES for a MIXED goal: one committed node, one that provably had nothing to commit", async () => {
    const root = repo("moe-criteria-mixed-");
    try {
      const { goal, refOf, store } = integratedWorld(["node-a", "node-b"]);
      const sha = await landForReal(store, root, refOf("node-a"), "product.txt");
      seedReviewAcceptance(store, refOf("node-b"));
      seedLandingReceipt(store, refOf("node-b"), NO_EFFECT);

      const artifact = readIntegratedCriterionArtifact(store, goal, root);

      expect(artifact).not.toBeNull();
      expect(artifact?.sha).toBe(sha);
      expect(artifact?.sha).toBe(git(root, ["rev-parse", "--verify", "HEAD"]));
      expect(artifact?.root).toBe(root);
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  }, 180000);

  it("REFUSES the same mixed goal when the sibling refused the POST-INTENT GIT_COMMIT_FAILED", async () => {
    // The discriminator is the refusal CODE, not merely "not COMMITTED". Exactly one literal
    // differs from the arm above, so this cannot pass while the rule is a blanket one.
    const root = repo("moe-criteria-post-intent-");
    try {
      const { goal, refOf, store } = integratedWorld(["node-a", "node-b"]);
      await landForReal(store, root, refOf("node-a"), "product.txt");
      seedReviewAcceptance(store, refOf("node-b"));
      seedLandingReceipt(store, refOf("node-b"), POST_INTENT);

      expect(readIntegratedCriterionArtifact(store, goal, root)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  }, 180000);

  it("RESOLVES at the untouched baseline HEAD when EVERY node of the goal landed nothing", async () => {
    const root = repo("moe-criteria-all-no-effect-");
    try {
      const { goal, refOf, store } = integratedWorld(["node-a"]);
      seedReviewAcceptance(store, refOf("node-a"));
      seedLandingReceipt(store, refOf("node-a"), NO_EFFECT);
      const baseline = git(root, ["rev-parse", "--verify", "HEAD"]);

      const artifact = readIntegratedCriterionArtifact(store, goal, root);

      // ZERO ancestry checks are possible here — no node carries a sha — and the artifact is the
      // baseline the goal was verified at. A criterion check runs against it: the runner needs
      // only root/sha/treeSha, nothing from a landing.
      expect(artifact).toMatchObject({ root, sha: baseline });
      expect(artifact?.treeSha).toBe(git(root, ["rev-parse", "--verify", "HEAD^{tree}"]));
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  }, 180000);

  it("still RUNS the ancestry check for a committed node — a landing off the artifact refuses", async () => {
    // The other half of "exactly one check, node-a's": the merge-base really executes, so the
    // skip proven above is not vacuous. Everything about the node stays valid — real receipt,
    // real verifier binding, same root — and ONLY the ancestry changes, because HEAD is rolled
    // back past the landed commit. That is the single check this arm can be failing.
    const root = repo("moe-criteria-unreachable-");
    try {
      const { goal, refOf, store } = integratedWorld(["node-a"]);
      const sha = await landForReal(store, root, refOf("node-a"), "product.txt");
      expect(readIntegratedCriterionArtifact(store, goal, root)).toMatchObject({ root, sha });

      git(root, ["reset", "--hard", "HEAD~1"]);

      expect(git(root, ["rev-parse", "--verify", "HEAD"])).not.toBe(sha);
      expect(git(root, ["cat-file", "-t", sha])).toBe("commit");
      expect(readIntegratedCriterionArtifact(store, goal, root)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  }, 180000);
});
