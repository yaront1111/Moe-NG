import type { RepositoryExecutionHandle } from "./repository-execution-contracts.js";
import { repositoryExecutionFailure } from "./repository-execution-contracts.js";
import { accessRepositoryExecution } from "./repository-execution-persistence.js";
import { sameExecutionOwner } from "./repository-execution-record.js";
import { repositoryRecoveryOwnerDigest } from "./repository-landing-intent.js";
import { recoveryDigest } from "./repository-recovery-facts.js";
import type { RepositoryReviewDrainEvidence } from "./repository-review-drain-contracts.js";
import type { RepositoryReplanEvidence } from "./repository-replan-recovery-evidence.js";

/** Private audited CAS: callers hold native containment and the complete durable evidence lock. */
export function releaseReplannedRepository(input: { readonly handle: RepositoryExecutionHandle; readonly principalId: string;
  readonly commandId: string; readonly requestSha256: string; readonly evidence: RepositoryReplanEvidence;
  readonly drain: RepositoryReviewDrainEvidence; readonly snapshotDigest: string }) {
  const { handle, evidence } = input;
  const proof = { kind: "RELEASE_REPLANNED", reviewDigest: evidence.reviewDigest, reviewVersion: evidence.reviewVersion,
    replanDecisionId: evidence.replanDecisionId, replanDigest: evidence.replanDigest, replanPrincipalId: evidence.replanPrincipalId,
    sourceDigest: evidence.sourceDigest, seatStartDigest: evidence.seatStartDigest, drain: input.drain, snapshotDigest: input.snapshotDigest };
  return accessRepositoryExecution(handle.reservation.identity, "UPDATE", (record) => {
    if (record === null || !sameExecutionOwner(record.owner, handle.owner)) return repositoryExecutionFailure("REPOSITORY_EXECUTION_OWNER_MISMATCH");
    if (record.revision !== handle.reservation.revision) return repositoryExecutionFailure("REPOSITORY_EXECUTION_REVISION_CONFLICT");
    const expected = handle.reservation;
    if (!record.everExecuted || record.state.phase !== "BLOCKED" || record.state.baselineId === null
      || record.state.sessionId === null || record.state.controllerPid !== input.drain.controllerPid
      || record.state.baselineId !== expected.baselineId || record.state.sessionId !== expected.sessionId
      || record.state.controllerId !== expected.controllerId || record.state.pid !== expected.pid) {
      return repositoryExecutionFailure("REPOSITORY_EXECUTION_TRANSITION_INVALID");
    }
    return { ok: true, record: null, value: { released: true as const } };
  }, { key: recoveryDigest([handle.owner.projectId, input.principalId, input.commandId]),
    requestJson: JSON.stringify({ owner: repositoryRecoveryOwnerDigest(handle.owner), expectedRevision: handle.reservation.revision,
      requestSha256: input.requestSha256, proof }),
    decode: (value) => typeof value === "object" && value !== null && Object.keys(value).length === 1
      && "released" in value && value.released === true ? { released: true as const } : null });
}
