import type { SqliteEventStore } from "@moe/store";
import { PUBLISH_PUSH_REJECTED } from "../repository/git-publication-port.js";
import type { PublicationGitPort } from "../repository/publication-effect-contracts.js";
import type { RepositoryExecutionController, RepositoryExecutionHandle, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { readPublishLedger, recordPublishReceipt } from "../repository/publish-ledger.js";
import type { PublishRequest } from "../repository/publish-ledger.js";
import { publishLinkFor } from "../repository/publish-receipt-contracts.js";
import { samePublicationApproval } from "../repository/publication-approval-contracts.js";
import type { PublicationCandidate } from "../repository/publication-approval-contracts.js";
import { PUBLICATION_TIP_UNREADABLE, publicationOwnerDigest, readPublicationIntent, readPublicationTransmission, recordPublicationIntent,
  recordPublicationTransmission } from "../repository/publication-effect-ledger.js";
import type { PublicationPushOutcome } from "../repository/publication-effect-ledger.js";
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
/** The one refusal this publisher writes on its own evidence: git refused the push and the remote tip never moved. */
const PUBLISH_NOT_LANDED = "PUBLISH_NOT_LANDED";

/** A persisted effect intent is never permission to repeat a push. Recovery only observes. */
export function createNodePublisher(config: NodePublisherConfig) {
  const clock = config.clock ?? (() => new Date().toISOString());
  let active = false;
  // THE ONE PUSH UNDER AN INTENT, WITH ITS EVIDENCE: the remote tip read before it and git's answer,
  // journaled once beside the intent. A throw or a lost answer is INDETERMINATE, and the durable
  // intent still forbids another transmission either way.
  const transmit = async (request: PublishRequest, candidate: PublicationCandidate): Promise<void> => {
    let tipBefore: string | null = PUBLICATION_TIP_UNREADABLE;
    try { const tip = await config.git.observe(candidate); if (tip.ok) tipBefore = tip.sha; } catch { /* stays UNREADABLE */ }
    let outcome: PublicationPushOutcome = "INDETERMINATE";
    try {
      const pushed = await config.git.push(candidate);
      outcome = pushed.ok ? "ACCEPTED" : pushed.code === PUBLISH_PUSH_REJECTED ? "REJECTED" : "INDETERMINATE";
    } catch { /* stays INDETERMINATE */ }
    recordPublicationTransmission(config.store, { projectId: config.projectId, goalId: request.goalId, decisionId: request.decisionId,
      tipBefore, outcome, transmittedAt: clock() });
  };
  /** Gives a PUBLISHING hold back once its PUBLISH_NOT_LANDED receipt exists, so a fresh decision can push again. */
  const giveBack = (goalId: string, workspace: string, handle: RepositoryExecutionHandle, detail: string): PublishReport | null =>
    config.repository.release(workspace, handle.owner, handle.reservation.revision, "PUBLISH_NOT_TRANSMITTED", config.controller.controllerId).ok
      ? report(goalId, "REFUSED", `${PUBLISH_NOT_LANDED}: ${detail}`) : null;
  // BOTH CONDITIONS, NEVER ONE, each read from the evidence journaled beside the intent:
  // (1) git REFUSED the push. Alone it is not enough: git can exit non-zero after the remote ref already moved.
  // (2) the remote tip still equals the tip read before the push. Alone it is not enough: a push that landed and
  //     was force-pushed back leaves it unchanged too, and resolving that would permit a SECOND transmission.
  // A push that succeeded, threw, lost its answer or followed an unreadable tip is never resolved here.
  const notLanded = (request: PublishRequest, candidate: PublicationCandidate, workspace: string,
    handle: RepositoryExecutionHandle, tip: string | null): PublishReport | null => {
    const { goalId, decisionId } = request;
    const sent = readPublicationTransmission(config.store, config.projectId, goalId, decisionId);
    if (sent === null || sent.outcome !== "REJECTED" || sent.tipBefore === PUBLICATION_TIP_UNREADABLE || sent.tipBefore !== tip) return null;
    const detail = `git refused the push of ${candidate.approval.sha} to ${candidate.approval.branch}; the remote tip was `
      + `${sent.tipBefore ?? "absent"} before the push and is ${tip ?? "absent"} after it`;
    const receipt = recordPublishReceipt(config.store, { branch: candidate.approval.branch, decidedAt: clock(), decisionId, goalId,
      projectId: config.projectId, refusal: { code: PUBLISH_NOT_LANDED, detail }, remoteUrl: candidate.approval.remoteUrl,
      sha: candidate.approval.sha, url: null });
    return receipt.ok && receipt.receipt.refusal?.code === PUBLISH_NOT_LANDED
      ? giveBack(goalId, workspace, handle, receipt.receipt.refusal.detail) : null;
  };
  /** `settled` is the detail of this decision's PUBLISH_NOT_LANDED receipt when one was already recorded. */
  const publish = async (request: PublishRequest, settled: string | null = null): Promise<PublishReport> => {
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
      // A crash or a refused release after the receipt left only the hold to give back: the receipt is the decision.
      if (settled !== null) return giveBack(goalId, config.workspace, handle, settled) ?? unknown();
      if (fresh) await transmit(request, candidate);
      const observed = await config.git.observe(candidate);
      if (!observed.ok || observed.sha !== candidate.approval.sha) {
        return (observed.ok ? notLanded(request, candidate, config.workspace, handle, observed.sha) : null) ?? unknown();
      }
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
          const settled = receipt?.refusal?.code === PUBLISH_NOT_LANDED ? receipt.refusal.detail : null;
          if (receipt !== undefined) {
            // A crash after receipt commit but before release still needs remote reconciliation.
            if ((receipt.outcome !== "PUSHED" && settled === null) || config.workspace === null) continue;
            const held = config.repository.inspect(config.workspace);
            if (held.ok && held.reservation === null) continue;
            if (held.ok && held.reservation?.nodeRef !== `publish:${request.decisionId}`) continue;
          }
          reports.push(await publish(request, settled));
        }
      }
      return reports;
    } finally { active = false; }
  };
  return Object.freeze({ publishOnce });
}
