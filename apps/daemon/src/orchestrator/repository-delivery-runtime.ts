import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { createGitLandingPort } from "../repository/git-landing-port.js";
import { createGitPublicationPort } from "../repository/git-publication-port.js";
import { createCriterionEvidenceService } from "../criterion-evidence/criterion-service.js";
import type { RepositoryExecutionHandle } from "../repository/repository-execution-contracts.js";
import { createVerifiedWorkspacePort } from "../repository/git-verified-workspace-port.js";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import { resolveRepositoryExecutionIdentity } from "../repository/repository-execution-identity.js";
import { readLandingReceipt } from "../repository/landing-ledger.js";
import { landingReceiptId } from "../repository/landing-receipt-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import type { AgentSessionFence } from "./agent-session-fence.js";
import type { AgentSpawnStart } from "./agent-spawn-contract.js";
import { createNodeLander } from "./node-lander.js";
import { createNodePublisher } from "./node-publisher.js";
import type { ReleasePublisher } from "../release/release-decide-service.js";
import { createNodeVerifier } from "./node-verifier.js";
import type { NodeVerifierConfig } from "./node-verifier.js";
import { createRepositoryDeliveryCoordinator } from "./repository-delivery-coordinator.js";
import { deliveryRefusal } from "./repository-delivery-contracts.js";
import type { RepositoryDeliveryFacts } from "./repository-delivery-contracts.js";
import { probeProcessAlive } from "./process-runner-lifecycle.js";

interface RepositoryDeliveryRuntimeConfig {
  readonly publisher?: ReleasePublisher;
  readonly compiledWorkspace: string | null;
  readonly fence: AgentSessionFence;
  readonly landingOn: boolean;
  readonly log: (line: string) => void;
  readonly nodes: () => readonly { nodeRef: string }[];
  readonly storePath: string;
  readonly verifier: Omit<NodeVerifierConfig, "nodes" | "verifiedWorkspace">;
}

/** Durable facts only; agent acceptance and an absent landing receipt never free ownership. */
export function readRepositoryDeliveryFacts(
  store: NodeVerifierConfig["store"], projectId: string, nodeRef: string,
): RepositoryDeliveryFacts {
  try {
    const review = readReviewLedger(store, projectId, nodeRef);
    if (review.unreadable) return "UNKNOWN";
    if (review.accepted !== undefined) {
      const landed = readLandingReceipt(store, projectId, landingReceiptId(projectId, nodeRef, review.accepted.verifierReceiptId));
      if (!landed.ok) return landed.code === "LANDING_RECEIPT_NOT_FOUND" ? "ACCEPTED" : "UNKNOWN";
      if (landed.receipt.subjectRef !== nodeRef || landed.receipt.verifierReceiptId !== review.accepted.verifierReceiptId) return "UNKNOWN";
      return landed.receipt.outcome === "COMMITTED" && landed.receipt.commit !== null ? "LANDED" : "REFUSED";
    }
    if (review.escalated || review.replanned) return "UNKNOWN";
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
    ...(reservationHandle === undefined ? {} : { reservationHandle }),
  });
  const coordinator = createRepositoryDeliveryCoordinator({
    controller: { controllerId: randomBytes(32).toString("hex"), controllerPid: process.pid },
    facts: (nodeRef) => readRepositoryDeliveryFacts(store, projectId, nodeRef),
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
      const observed = await git.observe(brief.workspace);
      if (!observed.ok || observed.observation.entries.length !== 0) {
        config.log(`[lander] ${nodeRef}: ${observed.ok ? "BASELINE_WORKSPACE_DIRTY" : observed.code}`);
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
      return reports.some((report) => report.outcome === "GIT_INDEX_LOCKED") ? "RETRY" : undefined;
    },
  });
  const storeId = realpathSync.native(config.storePath);
  const publisher = config.publisher ?? createNodePublisher({ git: createGitPublicationPort(), repository, storeId,
    controller: { controllerId: randomBytes(32).toString("hex"), controllerPid: process.pid },
    projectId, store, workspace: config.compiledWorkspace });
  const criteria = createCriterionEvidenceService({ store, projectId, storeId,
    workspace: config.compiledWorkspace, clock: () => new Date().toISOString() });
  let closed = false;
  const close = (): Promise<void> => { closed = true; return criteria.close(); };
  const start: (spawn: AgentSpawnStart) => AgentSpawnStart = (spawn) => async (request) => {
    if (closed) return deliveryRefusal("REPOSITORY_DELIVERY_CLOSED");
    if (request.kind === "node.deliver" && !config.landingOn) return deliveryRefusal("REPOSITORY_DELIVERY_LANDING_REQUIRED");
    return coordinator.start(request, spawn);
  };
  const advance = async (): Promise<void> => {
    if (closed) return;
    await coordinator.advance();
    if (closed) return;
    await criteria.advance();
    if (closed || config.compiledWorkspace === null) return;
    for (const report of await publisher.publishOnce()) config.log(`[publisher] ${report.goalId}: ${report.outcome} (${report.detail})`);
  };
  return Object.freeze({ start, advance, close });
}
