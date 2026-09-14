import type { RepositoryExecutionHandle } from "./repository-execution-contracts.js";
import { repositoryExecutionFailure } from "./repository-execution-contracts.js";
import { accessRepositoryExecution } from "./repository-execution-persistence.js";
import { sameExecutionOwner } from "./repository-execution-record.js";
import { repositoryRecoveryOwnerDigest } from "./repository-landing-intent.js";
import { recoveryDigest } from "./repository-recovery-facts.js";
import type { RepositoryReviewDrainEvidence } from "./repository-review-drain-contracts.js";

/** Audited CAS preserves the reservation itself; this is not the release primitive. */
export function resumeRepositoryReview(input: { readonly handle: RepositoryExecutionHandle; readonly principalId: string;
  readonly commandId: string; readonly requestSha256: string; readonly reviewDigest: string; readonly drain: RepositoryReviewDrainEvidence;
  readonly snapshotDigest: string }) {
  const { handle } = input;
  const proof = { kind: "RESUME_REVIEW", reviewDigest: input.reviewDigest, drain: input.drain, snapshotDigest: input.snapshotDigest };
  return accessRepositoryExecution(handle.reservation.identity, "UPDATE", (record, nextRevision) => {
    if (record === null || !sameExecutionOwner(record.owner, handle.owner)) return repositoryExecutionFailure("REPOSITORY_EXECUTION_OWNER_MISMATCH");
    if (record.revision !== handle.reservation.revision) return repositoryExecutionFailure("REPOSITORY_EXECUTION_REVISION_CONFLICT");
    const expected = handle.reservation;
    if (!record.everExecuted || record.state.phase !== "BLOCKED" || record.state.baselineId === null
      || record.state.sessionId === null || record.state.controllerPid !== input.drain.controllerPid
      || record.state.baselineId !== expected.baselineId || record.state.sessionId !== expected.sessionId
      || record.state.controllerId !== expected.controllerId || record.state.pid !== expected.pid) {
      return repositoryExecutionFailure("REPOSITORY_EXECUTION_TRANSITION_INVALID");
    }
    return { ok: true, record: { ...record, revision: nextRevision,
      state: { ...record.state, phase: "RESERVED", sessionId: null, pid: null } }, value: { resumed: true as const } };
  }, { key: recoveryDigest([handle.owner.projectId, input.principalId, input.commandId]),
    requestJson: JSON.stringify({ owner: repositoryRecoveryOwnerDigest(handle.owner), expectedRevision: handle.reservation.revision,
      requestSha256: input.requestSha256, proof }),
    decode: (value) => typeof value === "object" && value !== null && Object.keys(value).length === 1
      && "resumed" in value && value.resumed === true ? { resumed: true as const } : null });
}
