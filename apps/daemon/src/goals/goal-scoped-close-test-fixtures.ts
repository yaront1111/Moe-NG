import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOAL_ID, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { createCriterionEvidenceService } from "../criterion-evidence/criterion-service.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { OPERATOR } from "../planning/plan-reject-test-fixtures.js";
import { createVerifiedWorkspacePort } from "../repository/git-verified-workspace-port.js";
import { recordLandingReceipt } from "../repository/landing-ledger.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { calibration, packageItems, policyInput, submitPayload } from "../review/review-test-fixtures.js";
import { NODE_VERIFIER_PRINCIPAL_ID, recordVerifierReceipt } from "../review/verifier-receipt-ledger.js";
import { runReviewCommand } from "../review/review-services.js";
import { createScopedGoalWorld } from "./goal-scoped-test-fixtures.js";

const DECIDED_AT = "2026-09-06T00:00:00.000Z";
const encoder = new TextEncoder();
const git = (root: string, args: string[]): string => execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8", windowsHide: true, timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
}).replace(/\r?\n$/u, "");

/** Real Git delivery and contained criterion checks; workload and verifier authority are fixtures. */
export async function createScopedCloseWorld() {
  const world = createScopedGoalWorld();
  const { store, graph } = world;
  const workspace = mkdtempSync(join(tmpdir(), "moe-scoped-close-"));
  const service = createCriterionEvidenceService({ store, projectId: PROJECT_ID,
    storeId: `scoped-close-${workspace}`, workspace, clock: () => DECIDED_AT });
  const cleanup = async () => { await service.close(); rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); };
  try {
    git(workspace, ["init", "-b", "main"]);
    git(workspace, ["config", "user.name", "Scoped closure fixture"]);
    git(workspace, ["config", "user.email", "scoped-closure@example.invalid"]);
    writeFileSync(join(workspace, "README.md"), "initial\n");
    git(workspace, ["add", "README.md"]); git(workspace, ["commit", "-m", "initial"]);
    writeFileSync(join(workspace, "product.txt"), "crit-api\ncrit-ui\n");
    const workspacePort = createVerifiedWorkspacePort();
    const captured = await workspacePort.capture(workspace);
    if (!captured.ok) throw new Error(captured.code);
    const test = "if(require('fs').readFileSync('product.txt','utf8')!=='crit-api\\ncrit-ui\\n')process.exit(7);process.stdout.write('node passed')";
    const output = execFileSync(process.execPath, ["-e", test], { cwd: workspace, windowsHide: true, timeout: 30000 });
    const nodeRef = world.nodeRefs[0]!;
    const review = (kind: string, expectedVersion: number, payload: unknown, commandId: string) => {
      const answer = runReviewCommand(store, encoder.encode(JSON.stringify({ kind, expectedVersion, payload,
        commandId, projectId: PROJECT_ID, principalId: "author-1", correlationId: "scoped-close",
        decidedAt: DECIDED_AT, schemaVersion: "moe-review-command/1" })));
      if (!answer.ok) throw new Error(`scoped review refused: ${answer.code}`);
    };
    review("review.submit", 0, submitPayload(1, [], { subjectRef: nodeRef }), "scoped-review");
    const source = readReviewLedger(store, PROJECT_ID, nodeRef).rounds.at(-1)!;
    const verified = recordVerifierReceipt(store, { authority: { calibration: calibration(),
      packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"), policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }) },
      decidedAt: DECIDED_AT, execution: { byteCount: output.length, outputSha256: createHash("sha256").update(output).digest("hex"),
        test, workspace, workspaceBinding: captured.binding }, projectId: PROJECT_ID,
      source: { aggregateVersion: source.aggregateVersion, decisionId: source.decisionId, resultSha256: source.resultSha256 }, subjectRef: nodeRef });
    if (!verified.ok) throw new Error(verified.code);
    review("integration.accept_output", verified.decision.currentVersion,
      { receiptId: verified.receipt.receiptId, subjectRef: nodeRef }, "scoped-accept");
    const committed = await workspacePort.commit(workspace, ["product.txt"], "land scoped product\n", captured.binding);
    if (!committed.ok) throw new Error(committed.code);
    const landed = recordLandingReceipt(store, { projectId: PROJECT_ID, subjectRef: nodeRef, workspace,
      decidedAt: DECIDED_AT, verifierReceiptId: verified.receipt.receiptId, refusal: null,
      commit: { ...committed.receipt, files: ["product.txt"], message: "land scoped product\n" } });
    if (!landed.ok) throw new Error(landed.code);
    const human = createOperatorSessionHandshakePort({ store, projectId: PROJECT_ID,
      operatorPrincipalId: OPERATOR, capabilities: OPERATOR_CAPABILITIES, clock: () => Date.parse(DECIDED_AT), sessionTtlMs: 60000 }).mint();
    if (!human.ok) throw new Error(human.code);
    const criteria = ["crit-api", "crit-ui"];
    for (const [index, criterionId] of criteria.entries()) {
      const code = `if(!require('fs').readFileSync('product.txt','utf8').split('\\n').includes(${JSON.stringify(criterionId)}))process.exit(7);process.stdout.write(${JSON.stringify(criterionId)})`;
      const approved = service.approve({ commandId: `scoped-approve-${criterionId}`, correlationId: "scoped-close",
        expectedVersion: index, principalId: human.principalId, payload: { goalRef: GOAL_ID,
          planningRunRef: graph.planningRunRef!, contractRef: world.contractRef, criterionId,
          check: { checkId: `${criterionId}-check`, checkVersion: "1", program: process.execPath, args: ["-e", code], timeoutMs: 30000 } } });
      if (!approved.ok) throw new Error(approved.code);
    }
    const queued = service.verify({ commandId: "scoped-verify-all", correlationId: "scoped-close", expectedVersion: 0,
      principalId: human.principalId, payload: { goalRef: GOAL_ID, planningRunRef: graph.planningRunRef!,
        contractRef: world.contractRef, integratedSha: committed.receipt.sha,
        approvals: criteria.map((criterionId) => ({ criterionId, approvalId: `scoped-approve-${criterionId}` })) } });
    if (!queued.ok) throw new Error(queued.code);
    await service.advance();
    const read = service.read(GOAL_ID);
    if (read.outcome !== "CRITERION_EVIDENCE" || read.run?.status !== "COMPLETED"
      || read.criteria.length !== 2 || read.criteria.some((row) => row.evidence?.status !== "PASSED"
        || row.evidence.sha !== committed.receipt.sha || row.evidence.byteCount !== row.criterionId.length)) {
      throw new Error(`scoped criterion execution did not prove all checks: ${JSON.stringify(read)}`);
    }
    return { ...world, workspace, cleanup, sha: committed.receipt.sha };
  } catch (error) { await cleanup(); throw error; }
}
