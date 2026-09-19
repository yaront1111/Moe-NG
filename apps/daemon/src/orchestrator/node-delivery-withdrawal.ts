import { createHash } from "node:crypto";
import { REVIEW_ROUND_ABSOLUTE_CEILING } from "@moe/review";
import type { RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { readRepositoryIntegration } from "../repository/repository-integration-read.js";
import { readReviewLedgers } from "../review/review-read-model.js";
import type { ReviewLedger } from "../review/review-read-model.js";
import { runGit } from "./node-integration.js";
import type { IntegrationGit, LandedBranch } from "./node-integration.js";
import { recordNodeVerifierFailure } from "./node-verifier-failure-record.js";
import type { NodeVerifierConfig } from "./node-verifier.js";
import { NODE_BRANCH_PREFIX } from "./node-worktrees.js";

/**
 * AN ACCEPTED NODE WHOSE DELIVERY FAILED GOES BACK TO A SEAT. Acceptance was final: a node whose
 * accepted work then could not be delivered stayed accepted forever, no seat was ever staffed for
 * it again, and nothing durable said so. UnAI 2026-09-19: one node's branch conflicted with the
 * project's branch in 4 paths. The integrator recorded the conflict and, by design, merged nothing
 * later until it was answered. The text that was meant to hand the conflict back to its node was
 * only ever added to the brief of a node that is accepted AND landed, which is exactly the node
 * that is never staffed again. So every later branch waited behind a conflict nobody was told of.
 *
 * Each pass walks the review ledgers once and withdraws the acceptance of a node whose delivery
 * provably failed, as ONE host-recorded failed review round naming the accepted receipt it takes
 * back (review-services.ts). That round is the whole mechanism: the node reads READY, leaves the
 * integrator's candidates so the halt lasts one pass, and its next seat reads the finding through
 * the ordinary verifier diagnostic. It costs the node one unsuccessful round, like any failure.
 *
 * Rule INTEGRATION_CONFLICT: the landing COMMITTED on the node's own `moe/` branch, the integrator
 * recorded a conflict with paths at that exact commit, and the project's HEAD still lacks it.
 *
 * It never withdraws what it cannot prove or could not finish: an unreadable ledger, a landing
 * that is not the current acceptance's, a node with fewer than two rounds left under the ceiling
 * (the withdrawal is one, the seat's answer is the other), a workspace the node still holds, or
 * no verifier authority. Each of those is said once and tried again on the next pass.
 */
const MAX_PATHS = 20;
const MAX_PATH_CHARACTERS = 120;
// The failure payload keeps the TAIL of this text (node-verifier-failure.ts) and the brief keeps
// the HEAD of the finding (wrapper-review-missions.ts, 4000 characters). Only a text under both
// arrives whole, and what an overlong one loses is the instructions, not the paths.
export const WITHDRAWAL_OUTPUT_MAX_CHARACTERS = 3_800;

export interface IntegrationConflictFacts {
  readonly branch: string;
  readonly paths: readonly string[];
  readonly projectBranch: string;
  readonly sha: string;
}

/** What the seat is told. Paths give way before the recipe does: Git lists them all at the merge. */
export function integrationConflictOutput(conflict: IntegrationConflictFacts): string {
  const render = (shown: number): string => [
    `INTEGRATION_CONFLICT: nothing was tested. Your accepted work is safe on ${conflict.branch} at ${conflict.sha}: it is committed and is not lost.`,
    `It could not be merged into the project's branch ${conflict.projectBranch}, so the acceptance was withdrawn. No later branch merges until this is answered.`,
    `Git could not join ${String(conflict.paths.length)} path(s):`,
    ...conflict.paths.slice(0, shown).map((path) => path.slice(0, MAX_PATH_CHARACTERS)),
    ...(conflict.paths.length > shown ? [`[${String(conflict.paths.length - shown)} more not shown; Git names every one when you merge]`] : []),
    "Answer it in your own working tree:",
    `1. Run: git -c user.name=Moe -c user.email=moe@moe.local -c commit.gpgsign=false merge ${conflict.projectBranch}`,
    "2. Settle every conflicting path, keeping every criterion you own satisfied.",
    "3. COMMIT the merge. Leave no merge in progress and nothing uncommitted.",
    "4. Re-run the test, then submit the review again.",
  ].join("\n");
  for (let shown = Math.min(conflict.paths.length, MAX_PATHS); ; shown -= 1) {
    const text = render(shown);
    if (text.length <= WITHDRAWAL_OUTPUT_MAX_CHARACTERS || shown === 0) return text;
  }
}

export interface DeliveryWithdrawalConfig {
  readonly git?: IntegrationGit;
  readonly log: (line: string) => void;
  readonly nodes: () => readonly { readonly nodeRef: string }[];
  /** The project's own checkout, whose HEAD says what is merged. Absent = nothing to withdraw. */
  readonly projectWorkspace: string | null;
  readonly repository: Pick<RepositoryExecutionPort, "inspect">;
  readonly verifier: Pick<NodeVerifierConfig,
    "deps" | "nodeMission" | "operatorCredential" | "projectId" | "store" | "verificationAuthority">;
}

export function createDeliveryWithdrawal(config: DeliveryWithdrawalConfig) {
  const git = config.git ?? runGit;
  const { projectId, store } = config.verifier;
  // The scan runs on the wrapper's timer. A reason that has not changed is said once, not every
  // few seconds; a withdrawal is a durable round and is always said.
  const said = new Map<string, string>();
  const waiting = (nodeRef: string, outcome: string, detail: string): void => {
    if (said.get(nodeRef) === outcome) return;
    said.set(nodeRef, outcome);
    config.log(`[withdrawal] ${nodeRef}: ${outcome} (${detail}; INTEGRATION_CONFLICT is not withdrawn yet and is tried again on the next pass)`);
  };

  const withdrawConflict = (workspace: string, conflict: LandedBranch & { readonly paths: readonly string[] },
    ledger: ReviewLedger, receiptWorkspace: string): void => {
    const { nodeRef } = conflict;
    const accepted = ledger.accepted;
    const latest = ledger.rounds.at(-1);
    if (accepted === undefined || latest === undefined) return;
    // The integrator's own test for "still pending": whatever it holds the halt for is withdrawn.
    if (git(workspace, ["merge-base", "--is-ancestor", conflict.sha, "HEAD"]).code === 0) return;
    if (ledger.rounds.length > REVIEW_ROUND_ABSOLUTE_CEILING - 2) {
      return waiting(nodeRef, "WITHDRAWAL_ROUND_CEILING", `${String(ledger.rounds.length)} review rounds leave no room for a withdrawal and the seat's answer`);
    }
    const held = config.repository.inspect(receiptWorkspace);
    if (!held.ok) return waiting(nodeRef, held.code, "the landed workspace's reservation could not be read");
    if (held.reservation?.nodeRef === nodeRef && held.reservation.projectId === projectId) {
      return waiting(nodeRef, "WITHDRAWAL_WORKSPACE_HELD", `the node still holds its landed workspace (${held.reservation.phase})`);
    }
    const brief = config.verifier.nodeMission(nodeRef);
    if (brief === null) return waiting(nodeRef, "NODE_BRIEF_MISSING", "no spec brief");
    const authority = config.verifier.verificationAuthority(nodeRef, brief);
    if (authority === null) return waiting(nodeRef, "VERIFICATION_AUTHORITY_UNAVAILABLE", "host verifier authority unavailable");
    // A detached project checkout has no branch name; its commit merges the same.
    const named = git(workspace, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const head = named.code === 0 && named.stdout.trim() !== "" ? named : git(workspace, ["rev-parse", "HEAD"]);
    if (head.code !== 0 || head.stdout.trim() === "") return waiting(nodeRef, "WITHDRAWAL_PROJECT_HEAD_UNREADABLE", "the project checkout's HEAD could not be named");
    const output = integrationConflictOutput({ branch: conflict.branch, paths: conflict.paths, projectBranch: head.stdout.trim(), sha: conflict.sha });
    const sent = recordNodeVerifierFailure(config.verifier, nodeRef, latest, { byteCount: Buffer.byteLength(output),
      exitCode: null, output, sha256: createHash("sha256").update(output).digest("hex") }, authority, accepted.verifierReceiptId);
    if (!sent.ok) return waiting(nodeRef, sent.code, "the withdrawal round was refused");
    said.delete(nodeRef);
    config.log(`[withdrawal] ${nodeRef}: INTEGRATION_CONFLICT (${conflict.branch} ${conflict.sha.slice(0, 10)} conflicts with the project branch in ${String(conflict.paths.length)} path(s); the acceptance was withdrawn and the node returns to a seat)`);
  };

  /** One walk of the review ledgers per pass. It never throws: a failed scan costs only this pass. */
  const scanOnce = (): void => {
    const workspace = config.projectWorkspace;
    if (workspace === null) return;
    try {
      const reviews = readReviewLedgers(store, projectId, new Set(config.nodes().map(({ nodeRef }) => nodeRef)));
      const landed: LandedBranch[] = [];
      for (const [nodeRef, ledger] of reviews.ledgers) {
        const receipt = reviews.landings.get(nodeRef);
        if (ledger.unreadable || ledger.accepted === undefined || receipt === undefined
          || receipt.verifierReceiptId !== ledger.accepted.verifierReceiptId) continue;
        if (receipt.outcome !== "COMMITTED" || receipt.commit === null || !receipt.commit.branch.startsWith(NODE_BRANCH_PREFIX)) continue;
        landed.push({ branch: receipt.commit.branch, nodeRef, sha: receipt.commit.sha });
      }
      if (landed.length === 0) return;
      for (const branch of readRepositoryIntegration(store, projectId, landed).branches) {
        if (branch.state !== "CONFLICTED" || branch.conflictPaths.length === 0) continue;
        try {
          withdrawConflict(workspace, { branch: branch.branch, nodeRef: branch.nodeRef, paths: branch.conflictPaths, sha: branch.sha },
            reviews.ledgers.get(branch.nodeRef)!, reviews.landings.get(branch.nodeRef)!.workspace);
        } catch (error) {
          // One node's throw never costs the others their withdrawal.
          waiting(branch.nodeRef, "WITHDRAWAL_FAILED", error instanceof Error ? error.message.slice(0, 240) : "unknown failure");
        }
      }
    } catch { /* an unreadable store is read again on the next pass */ }
  };
  return Object.freeze({ scanOnce });
}
