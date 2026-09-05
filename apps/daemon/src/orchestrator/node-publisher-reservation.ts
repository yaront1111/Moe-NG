import { randomBytes } from "node:crypto";
import type { RepositoryExecutionController, RepositoryExecutionHandle, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import type { PublicationCandidate } from "../repository/publication-approval-contracts.js";
import { publicationRepositoryId } from "../repository/publication-approval-contracts.js";

export function publicationReservation(config: { repository: RepositoryExecutionPort; workspace: string; projectId: string;
  storeId: string; controller: RepositoryExecutionController; processAlive: (pid: number) => boolean },
  decisionId: string, candidate: PublicationCandidate): RepositoryExecutionHandle | null {
  const read = config.repository.readOwned(config.workspace, config.storeId, config.projectId);
  if (!read.ok) return null;
  let handle = read.handle;
  const nodeRef = `publish:${decisionId}`;
  if (handle === null) {
    const acquired = config.repository.acquire(config.workspace, { nodeRef, projectId: config.projectId,
      storeId: config.storeId, ownershipToken: randomBytes(32).toString("hex") }, config.controller);
    if (!acquired.ok) return null;
    handle = acquired.handle;
  }
  if (handle.owner.nodeRef !== nodeRef || handle.owner.projectId !== config.projectId || handle.owner.storeId !== config.storeId
    || publicationRepositoryId(handle.reservation.identity) !== candidate.approval.repositoryId) return null;
  if (handle.reservation.controllerId !== config.controller.controllerId) {
    if (config.processAlive(handle.reservation.controllerPid)) return null;
    const claimed = config.repository.claimController(config.workspace, handle.owner, handle.reservation.revision, config.controller);
    if (!claimed.ok) return null;
    handle = claimed.handle;
  }
  return handle;
}
