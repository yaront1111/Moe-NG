import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { REVIEW_ROUND_ABSOLUTE_CEILING } from "@moe/review";
import type { SqliteEventStore } from "@moe/store";
import { TRACKED_RUNTIME_METADATA_DIRTY, isMoeMetadata } from "../repository/git-landing-port.js";
import { LANDING_NOTHING_TO_COMMIT } from "../repository/landing-receipt-contracts.js";
import type { LandingReceiptV1 } from "../repository/landing-receipt-contracts.js";
import type { RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { readRepositoryIntegration } from "../repository/repository-integration-read.js";
import type { LandedSha } from "../repository/repository-integration-read.js";
import { landingIntentKey } from "../repository/repository-landing-intent.js";
import { readReviewLedgers } from "../review/review-read-model.js";
import type { ReviewLedger } from "../review/review-read-model.js";
import { runGit } from "./node-integration.js";
import type { IntegrationGit } from "./node-integration.js";
import { integratorMerges } from "./node-landed-branches.js";
import { adoptedSeatCommit, realPathOf } from "./node-lander-adopt.js";
import { recordNodeVerifierFailure } from "./node-verifier-failure-record.js";
import type { NodeVerifierConfig } from "./node-verifier.js";
import { ownNodeTree } from "./wrapper-node-trees.js";

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
 * Rule INTEGRATION_CONFLICT: the landing COMMITTED where the integrator merges from (`integratorMerges`:
 * the node's own tree, or a `moe/` branch), the integrator recorded a conflict with paths at that
 * exact commit, and the project's HEAD still lacks it.
 *
 * Rule LANDING_REFUSED: the landing was refused with a code in RECOVERABLE_LANDING_REFUSALS before
 * any landing intent was journaled. The same day a tracked `.moe-next/start.ps1` was edited while
 * a seat worked: the landing was refused TRACKED_RUNTIME_METADATA_DIRTY, a terminal receipt that
 * is never retried, and the accepted files sat uncommitted in the project's checkout. That dirt
 * then kept the integrator on SKIPPED, so one refusal stopped every other node's merge as well.
 * Only that code proves the work is still there; the table below says what the other one proves.
 *
 * Rule DELIVERED_NOTHING: the landing recorded NOTHING_TO_COMMIT with no intent, which is credited
 * as "this node owed no bytes", while the node's own tree still holds work the project lacks. A
 * restart without MOE_NODE_TREES had moved a node's mission back to the shared checkout: the
 * lander looked there, found nothing, and 34 changed files stayed in .moe-next/trees/<node>. A
 * genuine zero-byte delivery (no tree, or a clean tree the project PROVABLY already contains) keeps
 * its credit and is never withdrawn. A tree Git could not answer for is neither: only the lander's
 * NO_EFFECT answer finalises a receipt, and UNPROVEN is said once and asked again on the next pass.
 *
 * The two refused rules ship with two readers the staffing path asks (below). Without the pin the
 * node is re-staffed in an empty tree of its own while its work sits where the landing was
 * refused; without the own-dirt baseline its own uncommitted work refuses it admission.
 *
 * It never withdraws what it cannot prove or could not finish. Three cases are passed over in
 * silence, because they are not this scan's to answer: an unreadable ledger, a landing that is not
 * the current acceptance's (every newly accepted node, until its lander writes), and a refusal that
 * journaled an intent, which may have had a Git effect. The rest are said once per unchanged
 * reason and tried again on the next pass: intents that cannot be read, an ancestry probe Git did
 * not answer, a workspace the node still holds, no spec brief or verifier authority, a refused
 * withdrawal round. A node with fewer than two rounds left under the ceiling (the withdrawal is
 * one, the seat's answer is the other) is said once too, and stays unwithdrawn: rounds only grow.
 */
const MAX_PATHS = 20;
const MAX_PATH_CHARACTERS = 120;
// The failure payload keeps the TAIL of this text (node-verifier-failure.ts) and the brief keeps
// the HEAD of the finding (wrapper-review-missions.ts, 4000 characters). Only a text under both
// arrives whole, and what an overlong one loses is the instructions, not the paths.
export const WITHDRAWAL_OUTPUT_MAX_CHARACTERS = 3_800;

/**
 * THE CLOSED TABLE of landing refusals a new review round answers. Each is decided BEFORE a landing
 * intent is journaled, so no Git effect waits to be reconciled. TRACKED_RUNTIME_METADATA_DIRTY (a
 * tracked runtime file was edited under the seat) is decided at observe and touches no work: the
 * accepted work is still uncommitted in the workspace the receipt names.
 * LANDING_VERIFIED_WORKSPACE_CHANGED says only that the tree differs from what was verified, so
 * the work may be there, altered, or undone: its documented main cause is verified bytes restored
 * before landing (node-lander.ts), and the seat is told to look rather than that nothing is lost.
 * The accepted binding pins HEAD, tree and dirt together, so the same acceptance can never land; a
 * new round binds what is there now. A code outside the table (LANDING_BASELINE_MISSING, a binding
 * that is gone, a path that is no repository) is not something a seat answers by testing again,
 * and stays terminal.
 */
const LANDING_VERIFIED_WORKSPACE_CHANGED = "LANDING_VERIFIED_WORKSPACE_CHANGED";
export const RECOVERABLE_LANDING_REFUSALS: readonly string[] = Object.freeze([TRACKED_RUNTIME_METADATA_DIRTY, LANDING_VERIFIED_WORKSPACE_CHANGED]);

type WithdrawalRule = "INTEGRATION_CONFLICT" | "LANDING_REFUSED" | "DELIVERED_NOTHING";

/** The code of a landing REFUSED before any intent was journaled, else null. Unreadable intents (null) prove nothing. */
const refusedBeforeIntent = (receipt: LandingReceiptV1 | undefined, intents: ReadonlySet<string> | null): string | null =>
  receipt === undefined || receipt.outcome !== "REFUSED" || receipt.refusal === null || intents === null
    || intents.has(landingIntentKey(receipt.subjectRef, receipt.verifierReceiptId)) ? null : receipt.refusal.code;

/**
 * THE PIN: where a node whose landing was recoverably refused is staffed again, or null. Whatever
 * is left of its work is in the receipt's workspace and nowhere else. A node keeps the project's
 * checkout only while it HOLDS it (wrapper-node-trees.ts) and that hold ended with the refusal, so
 * unpinned it moves to an empty tree of its own while the project's checkout stays dirty and the
 * integrator stays on SKIPPED. A new landing receipt, or a PROVEN landing intent, ends the pin.
 * Unreadable intents (null) prove nothing, and everywhere else in this file nothing acts on them;
 * here "not pinned" IS an action (the node moves), so they keep the pin: one undecodable intent
 * row in the project would otherwise move every refused node off the workspace holding its work.
 * `ownsDirtIn` still reads them as unproven, so the node waits in place rather than being
 * admitted. It reads; it never throws: a raw throw out of the mission resolver is recorded as a
 * staffing failure that nothing clears (agent-wrapper.ts).
 */
export function refusedLandingWorkspace(store: SqliteEventStore, projectId: string, nodeRef: string): string | null {
  try {
    const reviews = readReviewLedgers(store, projectId, new Set([nodeRef]));
    const receipt = reviews.landings.get(nodeRef);
    if (receipt === undefined || receipt.outcome !== "REFUSED" || receipt.refusal === null
      || !RECOVERABLE_LANDING_REFUSALS.includes(receipt.refusal.code) || !existsSync(receipt.workspace)) return null;
    return reviews.landingIntents?.has(landingIntentKey(receipt.subjectRef, receipt.verifierReceiptId)) === true ? null : receipt.workspace;
  } catch { return null; }
}

/**
 * True when what is dirty in `root` is this node's OWN undelivered work, so admission's dirty-tree
 * gate may let it through with an empty baseline (node-lander.ts). Only a node that is no longer
 * accepted and whose last landing was refused before any intent, and only in the workspace a
 * recoverable refusal names or in the node's own tree, which no other node and no operator works
 * in. Any other node on the same dirt is still refused. It reads; it never throws.
 */
export function ownsDirtIn(store: SqliteEventStore, projectId: string, nodeRef: string, root: string): boolean {
  try {
    const reviews = readReviewLedgers(store, projectId, new Set([nodeRef]));
    const ledger = reviews.ledgers.get(nodeRef);
    const receipt = reviews.landings.get(nodeRef);
    const code = refusedBeforeIntent(receipt, reviews.landingIntents);
    if (ledger === undefined || ledger.unreadable || ledger.accepted !== undefined || receipt === undefined || code === null) return false;
    const at = realPathOf(root);
    if (RECOVERABLE_LANDING_REFUSALS.includes(code) && at === realPathOf(receipt.workspace)) return true;
    // A node's tree is <project>/.moe-next/trees/<name>: three levels under the project it belongs to.
    return ownNodeTree(resolve(at, "..", "..", ".."), nodeRef) === at;
  } catch { return false; }
}

export interface IntegrationConflictFacts {
  readonly branch: string;
  readonly paths: readonly string[];
  readonly projectBranch: string;
  readonly sha: string;
}

/**
 * The conflict brief a seat is handed, by this withdrawal and by the staffing-time tree sync
 * (node-tree-sync.ts): `lead` first, then the paths, then the four steps `last` closes. Paths give
 * way before the recipe does: Git lists them all at the merge.
 */
export function conflictRecipe(lead: readonly string[], paths: readonly string[], projectBranch: string, last: string): string {
  const render = (shown: number): string => [
    ...lead,
    `Git could not join ${String(paths.length)} path(s):`,
    ...paths.slice(0, shown).map((path) => path.slice(0, MAX_PATH_CHARACTERS)),
    ...(paths.length > shown ? [`[${String(paths.length - shown)} more not shown; Git names every one when you merge]`] : []),
    "Answer it in your own working tree:",
    `1. Run: git -c user.name=Moe -c user.email=moe@moe.local -c commit.gpgsign=false merge ${projectBranch}`,
    "2. Settle every conflicting path, keeping every criterion you own satisfied.",
    "3. COMMIT the merge. Leave no merge in progress and nothing uncommitted.",
    `4. ${last}`,
  ].join("\n");
  for (let shown = Math.min(paths.length, MAX_PATHS); ; shown -= 1) {
    const text = render(shown);
    if (text.length <= WITHDRAWAL_OUTPUT_MAX_CHARACTERS || shown === 0) return text;
  }
}

/** What the withdrawn seat is told. */
export function integrationConflictOutput(conflict: IntegrationConflictFacts): string {
  return conflictRecipe([
    `INTEGRATION_CONFLICT: nothing was tested. Your accepted work is safe on ${conflict.branch} at ${conflict.sha}: it is committed and is not lost.`,
    `It could not be merged into the project's branch ${conflict.projectBranch}, so the acceptance was withdrawn. Your branch is left out of integration until you land again.`,
  ], conflict.paths, conflict.projectBranch, "Re-run the test, then submit the review again.");
}

// Whatever a receipt or a path holds is cut before it is quoted, so the steps below it always arrive.
const cut = (text: string, most: number): string => text.length <= most ? text : `${text.slice(0, most - 1)}…`;

// Only TRACKED_RUNTIME_METADATA_DIRTY proves the work untouched. CHANGED's main cause is verified
// bytes restored before landing (node-lander.ts): "nothing is lost, keep your changes" would send
// that seat to re-run a test over files that are gone, with nothing saying why it now fails.
const landingRefusedOutput = (code: string, detail: string, workspace: string): string => [
  `LANDING_REFUSED: nothing was tested. Your accepted work was not committed: the landing was refused ${code}.`,
  cut(detail, 600),
  code === LANDING_VERIFIED_WORKSPACE_CHANGED
    ? `The workspace no longer matches what was verified: something in ${cut(workspace, 400)} changed after the test passed. Your changes may still be there or may have been undone; you are staffed there again.`
    : `Nothing is lost: your changes are still uncommitted in ${cut(workspace, 400)}, and you are staffed there again.`,
  "The acceptance was withdrawn, because a refused landing is never retried: only a new review round can land.",
  "Answer it in that workspace:",
  code === LANDING_VERIFIED_WORKSPACE_CHANGED
    ? "1. Check that your changes are still in place. Keep what is there; make again only what is missing. Do not stash, reset or clean anything."
    : "1. Keep your changes as they are. Do not stash, reset, clean or revert anything.",
  "2. Leave Moe's own files under .moe/ and .moe-next/ alone; Moe checkpoints a tracked one itself before you start.",
  "3. Re-run the test, then submit the review again.",
].join("\n");

const deliveredNothingOutput = (found: string, looked: string, tree: string): string => [
  `DELIVERED_NOTHING: nothing was tested. Your review was accepted, but the landing looked in ${cut(looked, 400)} and found nothing to commit there.`,
  `Your work is in your own working tree ${cut(tree, 400)}, which holds ${found}. Nothing is lost.`,
  "The acceptance was withdrawn so the work can land from where it is, and you are staffed in that tree again.",
  "Answer it there:",
  "1. Keep your work as it is. Do not stash, reset or clean anything, and do not copy it anywhere else.",
  "2. Re-run the test, then submit the review again.",
].join("\n");

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
  const waiting = (nodeRef: string, rule: WithdrawalRule, outcome: string, detail: string): void => {
    if (said.get(nodeRef) === outcome) return;
    said.set(nodeRef, outcome);
    config.log(`[withdrawal] ${nodeRef}: ${outcome} (${detail}; ${rule} is not withdrawn yet and is tried again on the next pass)`);
  };
  // A NOTHING_TO_COMMIT landing whose tree proved empty-handed is final for its receipt, and asking
  // costs synchronous Git calls: it is asked once per runtime, not on every pass of the timer.
  const owedNothing = new Set<string>();

  /** The guards every rule shares, then the one failed round. `output` runs last: it may ask Git. */
  const withdraw = (rule: WithdrawalRule, ledger: ReviewLedger, receipt: LandingReceiptV1, output: () => string | null, summary: string): void => {
    const nodeRef = receipt.subjectRef;
    const accepted = ledger.accepted;
    const latest = ledger.rounds.at(-1);
    if (accepted === undefined || latest === undefined) return;
    if (ledger.rounds.length > REVIEW_ROUND_ABSOLUTE_CEILING - 2) {
      return waiting(nodeRef, rule, "WITHDRAWAL_ROUND_CEILING", `${String(ledger.rounds.length)} review rounds leave no room for a withdrawal and the seat's answer`);
    }
    const held = config.repository.inspect(receipt.workspace);
    if (!held.ok) return waiting(nodeRef, rule, held.code, "the landed workspace's reservation could not be read");
    if (held.reservation?.nodeRef === nodeRef && held.reservation.projectId === projectId) {
      return waiting(nodeRef, rule, "WITHDRAWAL_WORKSPACE_HELD", `the node still holds its landed workspace (${held.reservation.phase})`);
    }
    const brief = config.verifier.nodeMission(nodeRef);
    if (brief === null) return waiting(nodeRef, rule, "NODE_BRIEF_MISSING", "no spec brief");
    const authority = config.verifier.verificationAuthority(nodeRef, brief);
    if (authority === null) return waiting(nodeRef, rule, "VERIFICATION_AUTHORITY_UNAVAILABLE", "host verifier authority unavailable");
    const text = output();
    if (text === null) return;
    const sent = recordNodeVerifierFailure(config.verifier, nodeRef, latest, { byteCount: Buffer.byteLength(text),
      exitCode: null, output: text, sha256: createHash("sha256").update(text).digest("hex") }, authority, accepted.verifierReceiptId);
    if (!sent.ok) return waiting(nodeRef, rule, sent.code, "the withdrawal round was refused");
    said.delete(nodeRef);
    config.log(`[withdrawal] ${nodeRef}: ${rule} (${summary}; the acceptance was withdrawn and the node returns to a seat)`);
  };

  const withdrawConflict = (workspace: string, conflict: LandedSha & { readonly paths: readonly string[] },
    ledger: ReviewLedger, receipt: LandingReceiptV1): void => {
    // EXACTLY 1 is Git's "not an ancestor" (node-lander-adopt.ts). 0 is merged; anything else proves
    // nothing, and this rule writes a durable round where the integrator's `!== 0` only costs a pass.
    // A conflict an operator merged by hand stays recorded, so this probe runs on every pass for
    // good: one timeout read as "no" would withdraw a node whose work is already in the project.
    const ancestry = git(workspace, ["merge-base", "--is-ancestor", conflict.sha, "HEAD"]).code;
    if (ancestry === 0) return;
    if (ancestry !== 1) {
      return waiting(conflict.nodeRef, "INTEGRATION_CONFLICT", "WITHDRAWAL_ANCESTRY_UNPROVED",
        `merge-base --is-ancestor exited ${String(ancestry)}, which proves neither answer`);
    }
    withdraw("INTEGRATION_CONFLICT", ledger, receipt, () => {
      // A detached project checkout has no branch name; its commit merges the same.
      const named = git(workspace, ["symbolic-ref", "--short", "-q", "HEAD"]);
      const head = named.code === 0 && named.stdout.trim() !== "" ? named : git(workspace, ["rev-parse", "HEAD"]);
      if (head.code === 0 && head.stdout.trim() !== "") {
        return integrationConflictOutput({ branch: conflict.branch, paths: conflict.paths, projectBranch: head.stdout.trim(), sha: conflict.sha });
      }
      waiting(conflict.nodeRef, "INTEGRATION_CONFLICT", "WITHDRAWAL_PROJECT_HEAD_UNREADABLE", "the project checkout's HEAD could not be named");
      return null;
    }, `${conflict.branch} ${conflict.sha.slice(0, 10)} conflicts with the project branch in ${String(conflict.paths.length)} path(s)`);
  };

  /**
   * What the node's own tree holds that the project lacks, in words. `found: null` is PROOF that it
   * owes no bytes (the lander's own NO_EFFECT); `unproven` is Git not saying, which is neither.
   */
  const undelivered = (workspace: string, tree: string, looked: string): { readonly found: string | null } | { readonly unproven: string } => {
    const asked = (args: readonly string[]): string => {
      const answer = git(tree, args);
      if (answer.code !== 0) throw new Error(`the node's own tree could not be read (git ${args[0] ?? ""})`);
      return answer.stdout;
    };
    // Dirt where the landing itself looked was there at the baseline: it is not this delivery's.
    if (realPathOf(tree) !== realPathOf(looked)) {
      // The lander's own observation (git-landing-port.ts): every dirty path but Moe's runtime files.
      const dirty = asked(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]).split("\0")
        .filter((entry) => entry.length > 3 && !isMoeMetadata(entry.slice(3))).length;
      if (dirty > 0) return { found: `${String(dirty)} uncommitted path(s)` };
    }
    // The lander's own adoption test: seat commits in the node's tree that the project lacks.
    const headSha = asked(["rev-parse", "HEAD"]).trim();
    const branch = git(tree, ["symbolic-ref", "-q", "HEAD"]);
    const branchRef = branch.code === 0 ? branch.stdout.trim() : "";
    const answer = adoptedSeatCommit(git, workspace, { branchRef, headSha, root: tree }, "");
    if (answer.kind === "UNPROVEN") return { unproven: answer.detail };
    return { found: answer.kind === "NO_EFFECT" ? null
      : `commits on ${cut(branchRef, 200)} at ${headSha} that the project's branch does not contain` };
  };

  const withdrawRefused = (workspace: string, ledger: ReviewLedger, receipt: LandingReceiptV1, intents: ReadonlySet<string> | null): void => {
    const nodeRef = receipt.subjectRef;
    const refusal = receipt.refusal;
    if (refusal === null || (intents?.has(landingIntentKey(nodeRef, receipt.verifierReceiptId)) ?? false)) return;
    if (RECOVERABLE_LANDING_REFUSALS.includes(refusal.code)) {
      if (intents === null) return waiting(nodeRef, "LANDING_REFUSED", "LANDING_INTENTS_UNREADABLE", "a landing intent could not be read, so nothing proves this refusal had no Git effect");
      return withdraw("LANDING_REFUSED", ledger, receipt, () => landingRefusedOutput(refusal.code, refusal.detail, receipt.workspace),
        `${refusal.code} in ${receipt.workspace}, before any landing intent`);
    }
    if (refusal.code !== LANDING_NOTHING_TO_COMMIT || owedNothing.has(receipt.receiptId)) return;
    const tree = ownNodeTree(workspace, nodeRef);
    const held = tree === null ? { found: null } : undelivered(workspace, tree, receipt.workspace);
    // Only PROOF finalises a receipt. "Git could not say" is said once and asked again next pass:
    // finalised, a tree whose commit was never merged would keep its no-effect credit for good.
    if ("unproven" in held) return waiting(nodeRef, "DELIVERED_NOTHING", "WITHDRAWAL_DELIVERY_UNPROVED", held.unproven);
    const { found } = held;
    if (tree === null || found === null) { owedNothing.add(receipt.receiptId); return; }
    if (intents === null) return waiting(nodeRef, "DELIVERED_NOTHING", "LANDING_INTENTS_UNREADABLE", "a landing intent could not be read, so nothing proves this landing had no Git effect");
    withdraw("DELIVERED_NOTHING", ledger, receipt, () => deliveredNothingOutput(found, receipt.workspace, tree),
      `the landing found nothing in ${receipt.workspace} while ${tree} holds ${found}`);
  };

  /** One walk of the review ledgers per pass. It never throws: a failed scan costs only this pass. */
  const scanOnce = (): void => {
    const workspace = config.projectWorkspace;
    if (workspace === null) return;
    // One node's throw never costs the others their withdrawal.
    const each = (nodeRef: string, rule: WithdrawalRule, run: () => void): void => {
      try { run(); } catch (error) {
        waiting(nodeRef, rule, "WITHDRAWAL_FAILED", error instanceof Error ? error.message.slice(0, 240) : "unknown failure");
      }
    };
    try {
      const reviews = readReviewLedgers(store, projectId, new Set(config.nodes().map(({ nodeRef }) => nodeRef)));
      const landed: LandedSha[] = [];
      for (const [nodeRef, ledger] of reviews.ledgers) {
        const receipt = reviews.landings.get(nodeRef);
        if (ledger.unreadable || ledger.accepted === undefined || receipt === undefined
          || receipt.verifierReceiptId !== ledger.accepted.verifierReceiptId) continue;
        if (receipt.outcome === "REFUSED") {
          each(nodeRef, RECOVERABLE_LANDING_REFUSALS.includes(receipt.refusal?.code ?? "") ? "LANDING_REFUSED" : "DELIVERED_NOTHING",
            () => withdrawRefused(workspace, ledger, receipt, reviews.landingIntents));
        } else if (receipt.commit !== null && integratorMerges(receipt.workspace, receipt.commit.branch)) {
          landed.push({ branch: receipt.commit.branch, nodeRef, sha: receipt.commit.sha });
        }
      }
      if (landed.length === 0) return;
      for (const branch of readRepositoryIntegration(store, projectId, landed).branches) {
        if (branch.state !== "CONFLICTED" || branch.conflictPaths.length === 0) continue;
        each(branch.nodeRef, "INTEGRATION_CONFLICT", () => withdrawConflict(workspace,
          { branch: branch.branch, nodeRef: branch.nodeRef, paths: branch.conflictPaths, sha: branch.sha },
          reviews.ledgers.get(branch.nodeRef)!, reviews.landings.get(branch.nodeRef)!));
      }
    } catch { /* an unreadable store is read again on the next pass */ }
  };
  return Object.freeze({ scanOnce });
}
