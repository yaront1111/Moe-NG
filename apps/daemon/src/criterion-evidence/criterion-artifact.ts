import { execFileSync } from "node:child_process";
import type { SqliteEventStore } from "@moe/store";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { resolveRepositoryExecutionIdentity } from "../repository/repository-execution-identity.js";
import { readLandingReceipt } from "../repository/landing-ledger.js";
import { readVerifierReceipt } from "../review/verifier-receipt-ledger.js";
import { readReviewLedgers } from "../review/review-read-model.js";
import type { CriterionGoal } from "./criterion-goal.js";
import type { IntegratedCriterionArtifact } from "./criterion-contracts.js";
import { criterionGitSha } from "./criterion-codec.js";

function git(root: string, args: readonly string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  return execFileSync("git", ["-C", root, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
    encoding: "utf8", env, shell: false, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
export function readCriterionArtifact(workspace: string): IntegratedCriterionArtifact | null {
  try {
    const resolved = resolveRepositoryExecutionIdentity(workspace); if (!resolved.ok) return null;
    const root = resolved.identity.root;
    const sha = git(root, ["rev-parse", "--verify", "HEAD"]);
    const treeSha = git(root, ["rev-parse", "--verify", "HEAD^{tree}"]);
    if (!criterionGitSha(sha) || !criterionGitSha(treeSha)
      || git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) !== ""
      || git(root, ["rev-parse", "--verify", "HEAD"]) !== sha) return null;
    return { root, sha, treeSha };
  } catch { return null; }
}
export const sameCriterionArtifact = (a: IntegratedCriterionArtifact, b: IntegratedCriterionArtifact | null): boolean =>
  b !== null && a.root === b.root && a.sha === b.sha && a.treeSha === b.treeSha;

/** An integrated candidate contains every execution-bearing node's exact, verified landing. */
export function readIntegratedCriterionArtifact(
  store: SqliteEventStore, goal: CriterionGoal, workspace: string | null,
): IntegratedCriterionArtifact | null {
  if (workspace === null) return null;
  try {
    const nodes = goal.graph.content.snapshot.nodes.filter((node) => node.executionBearing)
      .map((node) => compiledExecutionRef(goal.binding.projectId, goal.graph, node.nodeKey));
    if (nodes.length === 0) return null;
    const reviews = readReviewLedgers(store, goal.binding.projectId, new Set(nodes));
    const artifact = readCriterionArtifact(workspace); if (artifact === null) return null;
    for (const nodeRef of nodes) {
      const accepted = reviews.ledgers.get(nodeRef)?.accepted;
      const candidate = reviews.landings.get(nodeRef);
      if (accepted === undefined || candidate === undefined || candidate.outcome !== "COMMITTED" || candidate.commit === null) return null;
      const landing = readLandingReceipt(store, goal.binding.projectId, candidate.receiptId);
      const verifier = readVerifierReceipt(store, goal.binding.projectId, candidate.verifierReceiptId);
      if (!landing.ok || landing.receipt.subjectRef !== nodeRef || landing.receipt.commit === null
        || !verifier.ok || verifier.receipt.subjectRef !== nodeRef || accepted.verifierReceiptId !== candidate.verifierReceiptId
        || verifier.receiptSha256 !== accepted.verifierReceiptSha256
        || verifier.receipt.execution.workspaceBinding?.root !== artifact.root) return null;
      const identity = resolveRepositoryExecutionIdentity(candidate.workspace);
      if (!identity.ok || identity.identity.root !== artifact.root) return null;
      git(artifact.root, ["merge-base", "--is-ancestor", landing.receipt.commit.sha, artifact.sha]);
    }
    return sameCriterionArtifact(artifact, readCriterionArtifact(artifact.root)) ? artifact : null;
  } catch { return null; }
}
