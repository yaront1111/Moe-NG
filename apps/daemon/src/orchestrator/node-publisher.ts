import type { SqliteEventStore } from "@moe/store";
import type { PublicationGitPort } from "../repository/publication-effect-contracts.js";
import type { RepositoryExecutionController, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { readPublishLedger, recordPublishReceipt } from "../repository/publish-ledger.js";
import type { PublishRequest } from "../repository/publish-ledger.js";
import { publishLinkFor } from "../repository/publish-receipt-contracts.js";
import type { PublishRefusal } from "../repository/publish-receipt-contracts.js";
import { samePublicationApproval } from "../repository/publication-approval-contracts.js";
import type { PublicationCandidate, PublicationRefusal } from "../repository/publication-approval-contracts.js";
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
/**
 * One report per publish request per pass. `outcome` is one of:
 * - `PUSHED`   — the remote branch was observed at exactly the approved sha; receipt recorded.
 * - `REFUSED`  — a REFUSED receipt was recorded: a legacy unbound decision, or a pre-flight
 *   refusal decided BEFORE any intent is journaled, so no push was attempted and the
 *   reservation was given back: `PUBLISH_REMOTE_DIVERGED` when the remote branch holds a
 *   commit the approved sha does not contain (an operator merged or pushed behind Moe's back),
 *   or the git port's own code (`PUBLISH_REMOTE_UNREADABLE`, `PUBLISH_REPOSITORY_CHANGED`, …)
 *   with its detail when the remote or the candidate's repository could not be read. The
 *   operator decides again to retry.
 * - `WAITING`  — nothing was recorded or transmitted, and the next pass retries. ONLY the
 *   held-repository case (`node-publisher-reservation.ts`): the single repository reservation
 *   is held by another owner (a coding seat, a landing, a criterion check). A pre-flight
 *   failure is never WAITING, because `pendingPublication()` names the goal while no intent
 *   exists and `publishWaiting` would then turn every delivery away until the remote reads.
 * - `UNKNOWN`  — the durable state and the remote could not be brought to agreement this pass;
 *   `detail` names the check that failed (`PUBLISH_EFFECT_RECONCILIATION_REQUIRED: <reason>`).
 *   Once an intent is journaled the push is never repeated; recovery only observes.
 * - `WORKSPACE_UNSET` — no MOE_NODE_WORKSPACE, nothing attempted.
 */
export interface PublishReport { readonly detail: string; readonly goalId: string; readonly outcome: string }
const report = (goalId: string, outcome: string, detail = outcome): PublishReport => ({ detail, goalId, outcome });
export const PUBLISH_EFFECT_RECONCILIATION_REQUIRED = "PUBLISH_EFFECT_RECONCILIATION_REQUIRED";
export const PUBLISH_REMOTE_DIVERGED = "PUBLISH_REMOTE_DIVERGED";

const said = (error: unknown): string => error instanceof Error ? error.message : String(error);
const short = (sha: string | null): string => sha === null ? "absent" : sha.slice(0, 10);

/**
 * The goal of the oldest approved publish that has neither a receipt nor a journaled intent —
 * a publish the operator decided that has not yet held the repository — or null. The delivery
 * coordinator leaves a free repository alone while this names one (`publishWaiting`), so the
 * publisher's pass, which runs after the delivery pass, can take it. A request WITH an intent
 * is excluded on purpose: the publisher already holds the reservation for it, and a wedged
 * effect must not turn every delivery away. Read failures answer null: a broken ledger must
 * not stall deliveries, and the publisher's own pass reports it.
 */
export function pendingPublication(store: SqliteEventStore, projectId: string): string | null {
  try {
    for (const [, state] of readPublishLedger(store, projectId)) {
      for (const request of state.requests) {
        if (state.receipts.has(request.decisionId) || request.candidate === null) continue;
        if (readPublicationIntent(store, projectId, request.goalId, request.decisionId) === null) return request.goalId;
      }
    }
  } catch { return null; }
  return null;
}

/** A persisted effect intent is never permission to repeat a push. Recovery only observes. */
export function createNodePublisher(config: NodePublisherConfig) {
  const clock = config.clock ?? (() => new Date().toISOString());
  let active = false;
  // PRE-FLIGHT, BEFORE ANY INTENT. A non-fast-forward push is refused by the remote, and once
  // an intent is journaled this publisher may only observe: on UnAI (2026-09-18) an operator's
  // merge on GitHub would have left the reservation PUBLISHING forever, every delivery
  // REPOSITORY_EXECUTION_BUSY and every pass UNKNOWN. So the remote tip is checked first.
  // EVERY failure here is a REFUSED receipt, never WAITING: `pendingPublication()` keeps naming
  // this goal while no intent exists, so a WAITING pre-flight would turn every delivery away
  // from a free repository until the remote read again — a dead token or a bad URL would
  // starve the whole product. A transient blip therefore costs the operator one more decision,
  // which is the right trade against blocking every node. Answers the refusal to receipt, or
  // null when the push may proceed.
  const preflight = async (candidate: PublicationCandidate): Promise<PublishRefusal | null> => {
    const retry = (refused: PublicationRefusal): PublishRefusal => ({ code: refused.code, detail: `${refused.detail}; decide again to retry` });
    const tip = await config.git.observe(candidate);
    if (!tip.ok) return retry(tip);
    const ancestry = await config.git.contains(candidate, tip.sha);
    if (!ancestry.ok) return retry(ancestry);
    if (ancestry.contains) return null;
    return { code: PUBLISH_REMOTE_DIVERGED, detail: `remote ${candidate.approval.branch} is at ${short(tip.sha)}, which the approved `
      + `${short(candidate.approval.sha)} does not contain: fetch and merge (or rebase) it into the workspace branch, then decide again` };
  };
  const publish = async (request: PublishRequest): Promise<PublishReport> => {
    const { goalId, decisionId, candidate } = request;
    if (config.workspace === null) return report(goalId, "WORKSPACE_UNSET", "MOE_NODE_WORKSPACE is not set");
    if (candidate === null || candidate.approval.remoteUrl !== request.remoteUrl) {
      recordPublishReceipt(config.store, { branch: null, decidedAt: clock(), decisionId, goalId,
        projectId: config.projectId, refusal: { code: "PUBLISH_APPROVAL_REQUIRED", detail: "PUBLISH_APPROVAL_REQUIRED" },
        remoteUrl: request.remoteUrl, sha: null, url: null });
      return report(goalId, "REFUSED", "PUBLISH_APPROVAL_REQUIRED");
    }
    // EVERY UNKNOWN NAMES ITS CHECK. Ten exits used to share one bare code; the wrapper log then
    // read "UNKNOWN (PUBLISH_EFFECT_RECONCILIATION_REQUIRED)" whether the repository was merely
    // held by a seat, the push was refused by the remote, or the receipt did not persist.
    const unknown = (reason: string) => report(goalId, "UNKNOWN", `${PUBLISH_EFFECT_RECONCILIATION_REQUIRED}: ${reason}`);
    try {
      const reserved = publicationReservation({ ...config, workspace: config.workspace,
        processAlive: config.processAlive ?? probeProcessAlive }, decisionId, candidate);
      if (!reserved.ok) return reserved.waiting ? report(goalId, "WAITING", reserved.detail) : unknown(reserved.detail);
      let handle = reserved.handle;
      let intent = readPublicationIntent(config.store, config.projectId, goalId, decisionId);
      let fresh = false;
      if (intent === null) {
        if (handle.reservation.phase !== "RESERVED") return unknown(`reservation phase ${handle.reservation.phase} before any intent was journaled`);
        // Whatever the pre-flight refuses releases the reservation again: nothing was journaled
        // or transmitted under it, so ABORTED_BEFORE_EXECUTION is the truth. The release runs
        // before the receipt so a refused release can never strand a receipted request.
        const refusal = await preflight(candidate);
        if (refusal !== null) {
          const released = config.repository.release(config.workspace, handle.owner, handle.reservation.revision, "ABORTED_BEFORE_EXECUTION", config.controller.controllerId);
          if (!released.ok) return unknown(`pre-flight ${refusal.code}, nothing journaled, but the reservation release was refused: ${released.code}`);
          const receipt = recordPublishReceipt(config.store, { branch: candidate.approval.branch, decidedAt: clock(), decisionId, goalId,
            projectId: config.projectId, refusal, remoteUrl: candidate.approval.remoteUrl, sha: candidate.approval.sha, url: null });
          if (!receipt.ok) return unknown(`pre-flight ${refusal.code}, nothing journaled, but the REFUSED receipt was not recorded: ${receipt.code}`);
          return report(goalId, "REFUSED", `${refusal.code}: ${refusal.detail}`);
        }
        const recorded = recordPublicationIntent(config.store, { version: "moe-publication-intent/1", candidate,
          decisionId, goalId, projectId: config.projectId, ownerDigest: publicationOwnerDigest(handle.owner),
          reservationRevision: handle.reservation.revision, controllerId: config.controller.controllerId, intendedAt: clock() });
        intent = recorded.intent; fresh = !recorded.replayed;
      }
      if (!samePublicationApproval(intent.candidate.approval, candidate.approval)) return unknown("the journaled intent approves a different candidate than this request");
      if (intent.ownerDigest !== publicationOwnerDigest(handle.owner)) return unknown("the journaled intent belongs to a different reservation owner");
      if (intent.reservationRevision > handle.reservation.revision) return unknown("the reservation revision is older than the journaled intent");
      if (handle.reservation.phase === "RESERVED") {
        const moved = config.repository.transition(config.workspace, handle.owner, handle.reservation.revision,
          { ...config.controller, phase: "PUBLISHING", baselineId: null, sessionId: null, pid: null });
        if (!moved.ok) return unknown(`transition to PUBLISHING refused: ${moved.code}`); handle = moved.handle;
      }
      if (handle.reservation.phase !== "PUBLISHING") return unknown(`reservation phase ${handle.reservation.phase}, expected PUBLISHING`);
      let transmission = "no push this pass (an intent was already journaled)";
      if (fresh) {
        // Any thrown/lost result is ambiguous. The durable intent forbids another transmission.
        try {
          const pushed = await config.git.push(candidate);
          transmission = pushed.ok ? "push exited 0" : `push refused ${pushed.code}: ${pushed.detail}`;
        } catch (error) { transmission = `push threw: ${said(error)}`; }
      }
      const observed = await config.git.observe(candidate);
      if (!observed.ok) return unknown(`remote unreadable ${observed.code}: ${observed.detail}; ${transmission}`);
      if (observed.sha !== candidate.approval.sha) {
        return unknown(`remote ${candidate.approval.branch} is at ${short(observed.sha)}, expected ${short(candidate.approval.sha)}; ${transmission}`);
      }
      const receipt = recordPublishReceipt(config.store, { branch: candidate.approval.branch,
        decidedAt: clock(), decisionId, goalId, projectId: config.projectId, refusal: null,
        remoteUrl: candidate.approval.remoteUrl, sha: candidate.approval.sha,
        url: publishLinkFor(candidate.approval.remoteUrl, candidate.approval.branch) });
      if (!receipt.ok) return unknown(`remote holds the sha but the receipt was not recorded: ${receipt.code}`);
      if (receipt.receipt.outcome !== "PUSHED" || receipt.receipt.sha !== candidate.approval.sha
        || receipt.receipt.branch !== candidate.approval.branch || receipt.receipt.remoteUrl !== candidate.approval.remoteUrl) {
        return unknown("remote holds the sha but the recorded receipt does not match the candidate");
      }
      const released = config.repository.release(config.workspace, handle.owner, handle.reservation.revision, "PUBLISHED", config.controller.controllerId);
      return released.ok ? report(goalId, "PUSHED", `${candidate.approval.sha.slice(0, 10)} ${candidate.approval.branch} -> ${candidate.approval.remoteUrl}`)
        : unknown(`pushed and receipted, but the reservation release was refused: ${released.code}`);
    } catch (error) { return unknown(`threw: ${said(error)}`); }
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
