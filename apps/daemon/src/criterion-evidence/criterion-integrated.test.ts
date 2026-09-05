import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closeStores, GOAL_ID, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { criterionWorld } from "./criterion-test-fixtures.js";
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

it("executes approved criterion checks on the fully integrated Git SHA and invalidates evidence when it changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "moe-criteria-integrated-"));
  const fixture = criterionWorld({ workspace: root });
  const { store, service, approveAll, verifyInput } = fixture;
  try {
    git(root, ["init", "-b", "main"]);
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
    expect(after).toMatchObject({ run: { status: "COMPLETED", integratedSha: committed.receipt.sha },
      criteria: [{ evidence: { status: "PASSED", sha: committed.receipt.sha, byteCount: 16 } },
        { evidence: { status: "PASSED", sha: committed.receipt.sha, byteCount: 16 } }] });
    expect(createRepositoryExecutionPort().inspect(root)).toMatchObject({ ok: true, reservation: null });
    expect(coverage.readCoverage({ goalRef: GOAL_ID })).toMatchObject({ totals: { verified: 2, criteria: 2 } });
    writeFileSync(join(root, "README.md"), "changed integrated artifact\n");
    git(root, ["add", "README.md"]); git(root, ["commit", "-m", "new integration"]);
    expect(coverage.readCoverage({ goalRef: GOAL_ID })).toMatchObject({ totals: { verified: 0, criteria: 2 } });
    expect(service.read(GOAL_ID)).toMatchObject({ criteria: [{ evidence: { sha: committed.receipt.sha } }, { evidence: { sha: committed.receipt.sha } }] });
  } finally { await service.close(); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
}, 300000);
