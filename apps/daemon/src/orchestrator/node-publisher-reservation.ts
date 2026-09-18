import { randomBytes } from "node:crypto";
import type { RepositoryExecutionController, RepositoryExecutionHandle, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";

/**
 * Why the publisher could not hold the repository for this decision. `waiting` separates the
 * one benign case — another owner (a coding seat, a landing, a criterion check) holds the
 * single repository reservation right now and will release it — from every case that means
 * the durable state and this process disagree. The publisher reports the first as WAITING
 * and the rest as UNKNOWN; before 2026-09-18 both were one silent `null`, and on UnAI a
 * publish queued behind a running seat was logged nine times as
 * "UNKNOWN (PUBLISH_EFFECT_RECONCILIATION_REQUIRED)" with nothing to reconcile.
 */
export type PublicationReservationOutcome =
  | Readonly<{ ok: true; handle: RepositoryExecutionHandle }>
  | Readonly<{ ok: false; waiting: boolean; detail: string }>;

const refused = (waiting: boolean, detail: string): PublicationReservationOutcome => Object.freeze({ ok: false, waiting, detail });

export function publicationReservation(config: { repository: RepositoryExecutionPort; workspace: string; projectId: string;
  storeId: string; controller: RepositoryExecutionController; processAlive: (pid: number) => boolean },
  decisionId: string): PublicationReservationOutcome {
  const read = config.repository.readOwned(config.workspace, config.storeId, config.projectId);
  if (!read.ok) return refused(false, `reservation unreadable: ${read.code}`);
  let handle = read.handle;
  const nodeRef = `publish:${decisionId}`;
  if (handle === null) {
    const acquired = config.repository.acquire(config.workspace, { nodeRef, projectId: config.projectId,
      storeId: config.storeId, ownershipToken: randomBytes(32).toString("hex") }, config.controller);
    // BUSY here is a race lost to another owner between the read and the acquire: it will release.
    if (!acquired.ok) return refused(acquired.code === "REPOSITORY_EXECUTION_BUSY", `reservation not acquired: ${acquired.code}`);
    handle = acquired.handle;
  }
  if (handle.owner.nodeRef !== nodeRef) {
    return refused(true, `repository held by ${handle.owner.nodeRef} (${handle.reservation.phase})`);
  }
  if (handle.owner.projectId !== config.projectId || handle.owner.storeId !== config.storeId) {
    return refused(false, "repository held for another project or store");
  }
  if (handle.reservation.controllerId !== config.controller.controllerId) {
    if (config.processAlive(handle.reservation.controllerPid)) {
      return refused(false, `another live controller (pid ${String(handle.reservation.controllerPid)}) owns this publication`);
    }
    const claimed = config.repository.claimController(config.workspace, handle.owner, handle.reservation.revision, config.controller);
    if (!claimed.ok) return refused(false, `controller claim refused: ${claimed.code}`);
    handle = claimed.handle;
  }
  return Object.freeze({ ok: true, handle });
}
