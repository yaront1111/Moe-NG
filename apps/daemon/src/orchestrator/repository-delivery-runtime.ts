import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { createGitLandingPort, TRACKED_RUNTIME_METADATA_DIRTY } from "../repository/git-landing-port.js";
import { createGitPublicationPort } from "../repository/git-publication-port.js";
import { createCriterionEvidenceService } from "../criterion-evidence/criterion-service.js";
import type { RepositoryExecutionHandle } from "../repository/repository-execution-contracts.js";
import { createVerifiedWorkspacePort } from "../repository/git-verified-workspace-port.js";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import { resolveRepositoryExecutionIdentity } from "../repository/repository-execution-identity.js";
import { readLandingReceipt } from "../repository/landing-ledger.js";
import { readRepositoryLandingEvidence } from "../repository/repository-landing-intent.js";
import { landingReceiptId } from "../repository/landing-receipt-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { reviewContinuationAvailable } from "../review/review-continuation.js";
import { reviewDecisionRequired } from "../review/review-stall.js";
import { readReviewSubmissionSource } from "../review/review-submission-source.js";
import type { RepositoryExecutionPhase } from "../repository/repository-execution-contracts.js";
import { describeRepositoryHolder } from "./repository-holder-words.js";
import { createRepositoryContainmentLedger } from "./repository-containment-witness.js";
import type { AgentSessionFence } from "./agent-session-fence.js";
import type { AgentSpawnStart } from "./agent-spawn-contract.js";
import { createNodeLander } from "./node-lander.js";
import { landingVerificationClass } from "./node-lander-verification.js";
import { createNodeIntegration } from "./node-integration.js";
import { createDeliveryWithdrawal } from "./node-delivery-withdrawal.js";
import { landedNodeBranches } from "./node-landed-branches.js";
import { createNodePublisher, pendingPublication } from "./node-publisher.js";
import type { ReleasePublisher } from "../release/release-decide-service.js";
import { createNodeVerifier } from "./node-verifier.js";
import type { NodeVerifierConfig } from "./node-verifier.js";
import { createRepositoryDeliveryCoordinator } from "./repository-delivery-coordinator.js";
import { checkpointRuntimeMetadata } from "./runtime-metadata-checkpoint.js";
import { deliveryRefusal } from "./repository-delivery-contracts.js";
import type { RepositoryDeliveryFacts } from "./repository-delivery-contracts.js";
import { probeProcessAlive } from "./process-runner-lifecycle.js";

interface RepositoryDeliveryRuntimeConfig {
  readonly publisher?: ReleasePublisher;
  /** The Windows Job broker that owns this runtime's Job; null or absent = unnamed, never inferred from. */
  readonly runtimeBrokerPid?: number | null;
  readonly compiledWorkspace: string | null;
  readonly fence: AgentSessionFence;
  readonly landingOn: boolean;
  readonly log: (line: string) => void;
  readonly nodes: () => readonly { nodeRef: string }[];
  readonly storePath: string;
  readonly verifier: Omit<NodeVerifierConfig, "nodes" | "verifiedWorkspace">;
}

/**
 * A refusal that journaled no landing intent left no effect to reconcile. The discriminator is the
 * journal itself rather than a list of refusal codes: every refusal decided before
 * `commitJournaledLanding` has no intent by construction, and one decided after it always does.
 * Without a handle the intent key cannot be computed, so the answer falls back to plain REFUSED —
 * fail closed, because REFUSED contains the checkout and REFUSED_NO_EFFECT gives it away.
 */
function refusedFact(store: NodeVerifierConfig["store"], handle: RepositoryExecutionHandle | undefined): RepositoryDeliveryFacts {
  if (handle === undefined) return "REFUSED";
  const journal = readRepositoryLandingEvidence(store, handle);
  return !journal.ok && journal.code === "REPOSITORY_RECOVERY_EVIDENCE_MISSING" ? "REFUSED_NO_EFFECT" : "REFUSED";
}

/** Durable facts only; agent acceptance and an absent landing receipt never free ownership. */
export function readRepositoryDeliveryFacts(
  store: NodeVerifierConfig["store"], projectId: string, nodeRef: string, handle?: RepositoryExecutionHandle,
): RepositoryDeliveryFacts {
  try {
    const review = readReviewLedger(store, projectId, nodeRef);
    if (review.unreadable) return "UNKNOWN";
    if (review.accepted !== undefined) {
      const landed = readLandingReceipt(store, projectId, landingReceiptId(projectId, nodeRef, review.accepted.verifierReceiptId));
      if (!landed.ok) return landed.code === "LANDING_RECEIPT_NOT_FOUND" ? "ACCEPTED" : "UNKNOWN";
      if (landed.receipt.subjectRef !== nodeRef || landed.receipt.verifierReceiptId !== review.accepted.verifierReceiptId) return "UNKNOWN";
      return landed.receipt.outcome === "COMMITTED" && landed.receipt.commit !== null ? "LANDED" : refusedFact(store, handle);
    }
    // `escalated` records that a human answered, including ALLOW_MORE_ATTEMPTS.
    // Only REPLAN closes this node; allowed later rounds keep their actual review facts.
    if (review.replanned) return "REPLANNED";
    return review.rounds.at(-1)?.routing.route === "ACCEPT" ? "SUBMITTED" : "READY";
  } catch { return "UNKNOWN"; }
}

export function createRepositoryDeliveryRuntime(config: RepositoryDeliveryRuntimeConfig) {
  const { nodeMission, projectId, store } = config.verifier;
  const repository = createRepositoryExecutionPort();
  const git = createGitLandingPort();
  const verifiedWorkspace = createVerifiedWorkspacePort();
  const missionIn = (root: string) => (nodeRef: string) => {
    const brief = nodeMission(nodeRef);
    if (brief === null) return null;
    const identity = resolveRepositoryExecutionIdentity(brief.workspace);
    return identity.ok && identity.identity.root === root ? brief : null;
  };
  const landerFor = (nodeRef: string, root: string, baselineId: string | null, reservationHandle?: RepositoryExecutionHandle) => createNodeLander({
    git, verifiedWorkspace, nodeMission: missionIn(root), nodes: () => [{ nodeRef }], projectId, store,
    baselineId: () => baselineId,
    // Whose HEAD decides whether a seat's own commit on a node branch is still unmerged work.
    projectRoot: config.compiledWorkspace,
    ...(reservationHandle === undefined ? {} : { reservationHandle }),
  });
  let closed = false;
  // `baseline` is retried on the wrapper's timer, so one checkpoint is attempted per node per
  // UNCHANGED dirty set: re-running a failing commit against the operator's repository every few
  // seconds would turn one bug into a write storm. The key is the dirty set itself, so the attempt
  // re-arms as soon as that set changes. The prior outcome is kept so every later pass still shows
  // the operator the DISTINCT actionable code instead of an opaque repeating refusal.
  const metadataCheckpoints = new Map<string, { attempt: string; outcome: string }>();
  const checkpointMetadata = async (nodeRef: string, workspace: string, paths: readonly string[]): Promise<boolean> => {
    const attempt = paths.join("\0");
    const prior = metadataCheckpoints.get(nodeRef);
    if (prior?.attempt === attempt) {
      config.log(`[lander] ${nodeRef}: ${prior.outcome} (already attempted for this unchanged set of ${String(paths.length)} runtime metadata path(s); not retried. Resolve or checkpoint them by hand.)`);
      return false;
    }
    const report = await checkpointRuntimeMetadata({ git, nodeRef, paths, workspace });
    metadataCheckpoints.set(nodeRef, { attempt, outcome: report.outcome });
    config.log(`[lander] ${nodeRef}: ${report.outcome} (${report.detail})`);
    return report.ok;
  };
  const describeHolder = (nodeRef: string, phase: RepositoryExecutionPhase): string => {
    try {
      const review = readReviewLedger(store, projectId, nodeRef);
      return describeRepositoryHolder({ accepted: review.accepted !== undefined, continuation: reviewContinuationAvailable(review),
        decisionDue: !review.unreadable && reviewDecisionRequired(review),
        nodeKey: readReviewSubmissionSource(store, projectId, nodeRef)?.nodeKey ?? nodeRef, phase, replanned: review.replanned });
    } catch { return `held by ${nodeRef}`; }
  };
  const coordinator = createRepositoryDeliveryCoordinator({
    closed: () => closed,
    // Deliveries leave a free repository to an approved publish that has not held it yet; the
    // publisher (below) runs after the delivery pass and would otherwise lose every race.
    publishWaiting: () => config.compiledWorkspace === null ? null : pendingPublication(store, projectId),
    containment: createRepositoryContainmentLedger(store, config.runtimeBrokerPid ?? null),
    // A probe that throws reads as "not clean": any throw inside advance blocks the reservation.
    clean: async (root) => {
      try {
        const observed = await git.observe(root);
        return observed.ok && observed.observation.entries.length === 0;
      } catch { return false; }
    },
    describeHolder,
    controller: { controllerId: randomBytes(32).toString("hex"), controllerPid: process.pid },
    facts: (nodeRef, handle) => readRepositoryDeliveryFacts(store, projectId, nodeRef, handle),
    isProcessAlive: probeProcessAlive, port: repository, projectId,
    retired: (nodeRef) => config.fence.admit(`node.deliver@${nodeRef}`, new Date().toISOString()).ok,
    storeId: realpathSync.native(config.storePath),
    workspaces: () => [...new Set([
      ...(config.compiledWorkspace === null ? [] : [config.compiledWorkspace]),
      ...config.nodes().flatMap(({ nodeRef }) => {
        const brief = nodeMission(nodeRef); return brief === null ? [] : [brief.workspace];
      }),
    ])],
    baseline: async (nodeRef, root) => {
      const brief = missionIn(root)(nodeRef);
      if (brief === null) return null;
      let observed = await git.observe(brief.workspace);
      // GATE A ONLY. Tracked runtime metadata (`.moe/`, `.moe-next/`) that was already dirty when
      // the node was staffed is checkpointed by Moe so execution can proceed; the checkpoint module
      // fences the paths itself. Gate B below is untouched: ordinary PRODUCT dirt still refuses.
      const dirtyMetadata = !observed.ok && observed.code === TRACKED_RUNTIME_METADATA_DIRTY ? observed.paths ?? [] : [];
      if (dirtyMetadata.length > 0 && await checkpointMetadata(nodeRef, brief.workspace, dirtyMetadata)) {
        observed = await git.observe(brief.workspace);
      }
      if (!observed.ok || observed.observation.entries.length !== 0) {
        config.log(observed.ok
          ? `[lander] ${nodeRef}: BASELINE_WORKSPACE_DIRTY (${observed.observation.entries.length} changed paths). Review git status --short and checkpoint existing work before execution; Moe rechecks automatically.`
          : `[lander] ${nodeRef}: ${observed.code} (${observed.detail}); Moe rechecks repository admission automatically.`);
        return null;
      }
      const report = await landerFor(nodeRef, root, null).baseline(nodeRef);
      config.log(`[lander] ${report.nodeRef}: ${report.outcome} (${report.detail})`);
      return report.baselineId ?? null;
    },
    verify: async (nodeRef, root) => {
      const verifier = createNodeVerifier({ ...config.verifier, verifiedWorkspace,
        nodeMission: missionIn(root), nodes: () => [{ nodeRef }] });
      for (const report of await verifier.verifyOnce()) config.log(`[verifier] ${report.nodeRef}: ${report.outcome} (${report.detail})`);
    },
    land: async (nodeRef, baselineId, root, reservationHandle) => {
      if (!config.landingOn) {
        config.log(`[lander] ${nodeRef}: REPOSITORY_DELIVERY_LANDING_REQUIRED`);
        return "RETRY";
      }
      const reports = await landerFor(nodeRef, root, baselineId, reservationHandle).landOnce();
      for (const report of reports) config.log(`[lander] ${report.nodeRef}: ${report.outcome} (${report.detail})`);
      // Only what provably had no effect is retried: the strict port's index lock, a bare observe
      // GIT_FAILED — a read-only `status`/`hash-object` that failed before this attempt journaled
      // any intent, which the lander reports without recording exactly so a later pass can retry
      // it — and a verification refusal the lander's table calls TRANSIENT, likewise decided before
      // any intent. Each keeps the ACCEPTED work and its reservation for the next pass. Anything
      // else blocks: an unknown or post-effect outcome is never retried by default.
      return reports.some((report) => report.outcome === "GIT_INDEX_LOCKED"
        || report.outcome === "GIT_FAILED"
        || landingVerificationClass(report.outcome) === "TRANSIENT") ? "RETRY" : undefined;
    },
  });
  const storeId = realpathSync.native(config.storePath);
  const publisher = config.publisher ?? createNodePublisher({ git: createGitPublicationPort(), repository, storeId,
    controller: { controllerId: randomBytes(32).toString("hex"), controllerPid: process.pid },
    projectId, store, workspace: config.compiledWorkspace });
  const criteria = createCriterionEvidenceService({ store, projectId, storeId,
    workspace: config.compiledWorkspace, clock: () => new Date().toISOString() });
  // Where the nodes' own branches meet the project's own branch (owner decision 2026-09-16). It
  // has nothing to do until a node lands on a branch of its own, so a project whose nodes share
  // the project's checkout never sees it act.
  const integration = createNodeIntegration({
    candidates: () => landedNodeBranches(store, projectId, config.nodes()),
    clock: () => new Date().toISOString(),
    controller: { controllerId: randomBytes(32).toString("hex"), controllerPid: process.pid },
    projectId, repository, store, storeId, workspace: config.compiledWorkspace });
  const withdrawal = createDeliveryWithdrawal({ log: config.log, nodes: config.nodes,
    projectWorkspace: config.compiledWorkspace, repository, verifier: config.verifier });
  const close =(): Promise<void> => { closed = true; return criteria.close(); };
  const start: (spawn: AgentSpawnStart) => AgentSpawnStart = (spawn) => async (request) => {
    if (closed) return deliveryRefusal("REPOSITORY_DELIVERY_CLOSED");
    if (request.kind === "node.deliver" && !config.landingOn) return deliveryRefusal("REPOSITORY_DELIVERY_LANDING_REQUIRED");
    return coordinator.start(request, spawn);
  };
  const advance = async (): Promise<void> => {
    if (closed) return;
    // FIRST, so a node whose delivery failed is READY before this same pass staffs and integrates:
    // withdrawn, it is out of the integrator's candidates below and the branches that waited
    // behind its conflict merge now rather than a pass later (UnAI 2026-09-19).
    withdrawal.scanOnce();
    await coordinator.advance();
    if (closed) return;
    await criteria.advance();
    if (closed || config.compiledWorkspace === null) return;
    for (const report of await integration.integrateOnce()) {
      config.log(`[integration] ${report.nodeRef}: ${report.outcome} (${report.detail})`);
    }
    if (closed) return;
    for (const report of await publisher.publishOnce()) config.log(`[publisher] ${report.goalId}: ${report.outcome} (${report.detail})`);
  };
  const admission = (nodeRef: string, workspace: string) => closed ? null : coordinator.admission(workspace, nodeRef);
  return Object.freeze({ start, advance, close, admission });
}
