import type { SqliteEventStore } from "@moe/store";
import type { PublicationGitPort } from "../repository/publication-effect-contracts.js";
import type { RepositoryExecutionController, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { readPublishLedger, recordPublishReceipt } from "../repository/publish-ledger.js";
import type { PublishRequest } from "../repository/publish-ledger.js";
import { publishLinkFor } from "../repository/publish-receipt-contracts.js";
import { samePublicationApproval } from "../repository/publication-approval-contracts.js";
import { publicationOwnerDigest, readPublicationIntent, recordPublicationIntent } from "../repository/publication-effect-ledger.js";
import { publicationReservation } from "./node-publisher-reservation.js";
import { probeProcessAlive } from "./process-runner-lifecycle.js";

export interface NodePublisherConfig {
  readonly clock?: () => string;
  readonly git: PublicationGitPort;
  readonly projectId: string;
  readonly store: SqliteEventStore;
  readonly workspace: string | null;
  readonly repository: RepositoryExecutionPort;
  readonly storeId: string;
  readonly controller: RepositoryExecutionController;
  readonly processAlive?: (pid: number) => boolean;
}
export interface PublishReport { readonly detail: string; readonly goalId: string; readonly outcome: string }
const report = (goalId: string, outcome: string, detail = outcome): PublishReport => ({ detail, goalId, outcome });

/** A persisted effect intent is never permission to repeat a push. Recovery only observes. */
export function createNodePublisher(config: NodePublisherConfig) {
  const clock = config.clock ?? (() => new Date().toISOString());
  let active = false;
  const publish = async (request: PublishRequest): Promise<PublishReport> => {
    const { goalId, decisionId, candidate } = request;
    if (config.workspace === null) return report(goalId, "WORKSPACE_UNSET", "MOE_NODE_WORKSPACE is not set");
    if (candidate === null || candidate.approval.remoteUrl !== request.remoteUrl) {
      recordPublishReceipt(config.store, { branch: null, decidedAt: clock(), decisionId, goalId,
        projectId: config.projectId, refusal: { code: "PUBLISH_APPROVAL_REQUIRED", detail: "PUBLISH_APPROVAL_REQUIRED" },
        remoteUrl: request.remoteUrl, sha: null, url: null });
      return report(goalId, "REFUSED", "PUBLISH_APPROVAL_REQUIRED");
    }
    const unknown = () => report(goalId, "UNKNOWN", "PUBLISH_EFFECT_RECONCILIATION_REQUIRED");
    try {
      let handle = publicationReservation({ ...config, workspace: config.workspace,
        processAlive: config.processAlive ?? probeProcessAlive }, decisionId, candidate);
      if (handle === null) return unknown();
      let intent = readPublicationIntent(config.store, config.projectId, goalId, decisionId);
      let fresh = false;
      if (intent === null) {
        if (handle.reservation.phase !== "RESERVED") return unknown();
        const recorded = recordPublicationIntent(config.store, { version: "moe-publication-intent/1", candidate,
          decisionId, goalId, projectId: config.projectId, ownerDigest: publicationOwnerDigest(handle.owner),
          reservationRevision: handle.reservation.revision, controllerId: config.controller.controllerId, intendedAt: clock() });
        intent = recorded.intent; fresh = !recorded.replayed;
      }
      if (!samePublicationApproval(intent.candidate.approval, candidate.approval)
        || intent.ownerDigest !== publicationOwnerDigest(handle.owner)
        || intent.reservationRevision > handle.reservation.revision) return unknown();
      if (handle.reservation.phase === "RESERVED") {
        const moved = config.repository.transition(config.workspace, handle.owner, handle.reservation.revision,
          { ...config.controller, phase: "PUBLISHING", baselineId: null, sessionId: null, pid: null });
        if (!moved.ok) return unknown(); handle = moved.handle;
      }
      if (handle.reservation.phase !== "PUBLISHING") return unknown();
      if (fresh) {
        // Any thrown/lost result is ambiguous. The durable intent forbids another transmission.
        try { await config.git.push(candidate); } catch { /* reconcile below */ }
      }
      const observed = await config.git.observe(candidate);
      if (!observed.ok || observed.sha !== candidate.approval.sha) return unknown();
      const receipt = recordPublishReceipt(config.store, { branch: candidate.approval.branch,
        decidedAt: clock(), decisionId, goalId, projectId: config.projectId, refusal: null,
        remoteUrl: candidate.approval.remoteUrl, sha: candidate.approval.sha,
        url: publishLinkFor(candidate.approval.remoteUrl, candidate.approval.branch) });
      if (!receipt.ok || receipt.receipt.outcome !== "PUSHED" || receipt.receipt.sha !== candidate.approval.sha
        || receipt.receipt.branch !== candidate.approval.branch || receipt.receipt.remoteUrl !== candidate.approval.remoteUrl) return unknown();
      const released = config.repository.release(config.workspace, handle.owner, handle.reservation.revision, "PUBLISHED", config.controller.controllerId);
      return released.ok ? report(goalId, "PUSHED", `${candidate.approval.sha.slice(0, 10)} ${candidate.approval.branch} -> ${candidate.approval.remoteUrl}`) : unknown();
    } catch { return unknown(); }
  };
  const publishOnce = async (): Promise<readonly PublishReport[]> => {
    if (active) return [];
    active = true;
    try {
      const reports: PublishReport[] = [];
      for (const [, state] of readPublishLedger(config.store, config.projectId)) {
        for (const request of state.requests) {
          const receipt = state.receipts.get(request.decisionId);
          if (receipt !== undefined) {
            // A crash after receipt commit but before release still needs remote reconciliation.
            if (receipt.outcome !== "PUSHED" || config.workspace === null) continue;
            const held = config.repository.inspect(config.workspace);
            if (held.ok && held.reservation === null) continue;
            if (held.ok && held.reservation?.nodeRef !== `publish:${request.decisionId}`) continue;
          }
          reports.push(await publish(request));
        }
      }
      return reports;
    } finally { active = false; }
  };
  return Object.freeze({ publishOnce });
}
