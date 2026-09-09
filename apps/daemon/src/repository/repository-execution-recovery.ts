import type { RepositoryExecutionHandle, RepositoryExecutionResult } from "./repository-execution-contracts.js";
import { repositoryExecutionFailure } from "./repository-execution-contracts.js";
import { resolveRepositoryExecutionIdentity } from "./repository-execution-identity.js";
import { accessRepositoryExecution } from "./repository-execution-persistence.js";
import { executionHandle, sameExecutionOwner, validExecutionOwner } from "./repository-execution-record.js";
import { recoveryDigest } from "./repository-recovery-facts.js";
import { repositoryRecoveryOwnerDigest } from "./repository-landing-intent.js";
export interface RepositoryExecutionRecoveryInput {
  readonly handle: RepositoryExecutionHandle;
  readonly expectedRevision: number;
  readonly commandId: string;
  readonly principalId: string;
  readonly requestSha256: string;
  readonly proof: { readonly kind: "ABORT_UNEXECUTED" } | { readonly kind: "LANDING_RECEIPT" | "LANDING_COMPLETION"; readonly id: string };
}
/** Internal operator effect. Authentication and durable approval precede this atomic CAS+receipt. */
export function recoverRepositoryExecution(input: RepositoryExecutionRecoveryInput): RepositoryExecutionResult<{ released: true; replayed: boolean }> {
  const { handle, proof } = input;
  if (!validExecutionOwner(handle.owner) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
    || !/^[a-f0-9]{64}$/u.test(input.requestSha256) || input.commandId.length === 0 || input.principalId.length === 0
    || !["ABORT_UNEXECUTED", "LANDING_RECEIPT", "LANDING_COMPLETION"].includes(proof.kind)) {
    return repositoryExecutionFailure("REPOSITORY_EXECUTION_OWNER_MISMATCH");
  }
  const resolved = resolveRepositoryExecutionIdentity(handle.reservation.identity.root); if (!resolved.ok) return resolved;
  if (resolved.identity.gitDirectory !== handle.reservation.identity.gitDirectory) return repositoryExecutionFailure("REPOSITORY_IDENTITY_UNKNOWN");
  const result = accessRepositoryExecution(resolved.identity, "UPDATE", (record) => {
    if (record === null || !sameExecutionOwner(record.owner, handle.owner)) return repositoryExecutionFailure("REPOSITORY_EXECUTION_OWNER_MISMATCH");
    if (record.revision !== input.expectedRevision) return repositoryExecutionFailure("REPOSITORY_EXECUTION_REVISION_CONFLICT");
    if (/^(?:publish|criterion):/u.test(record.owner.nodeRef)) return repositoryExecutionFailure("REPOSITORY_EXECUTION_TRANSITION_INVALID");
    const canAbort = !record.everExecuted && ["RESERVED", "BLOCKED"].includes(record.state.phase)
      && record.state.sessionId === null && record.state.pid === null;
    const canLand = record.everExecuted && record.state.baselineId !== null && record.state.sessionId !== null
      && (record.state.phase === "LANDING" || (record.state.phase === "BLOCKED" && proof.kind === "LANDING_COMPLETION"));
    if (proof.kind === "ABORT_UNEXECUTED" ? !canAbort : !canLand || !/^[a-f0-9]{64}$/u.test(proof.id)) {
      return repositoryExecutionFailure("REPOSITORY_EXECUTION_TRANSITION_INVALID");
    }
    return { ok: true, record: null, value: { released: true as const } };
  }, {
    key: recoveryDigest([handle.owner.projectId, input.principalId, input.commandId]),
    requestJson: JSON.stringify({ owner: repositoryRecoveryOwnerDigest(handle.owner), expectedRevision: input.expectedRevision,
      requestSha256: input.requestSha256, proof }),
    decode: (value) => typeof value === "object" && value !== null && Object.keys(value).length === 1
      && "released" in value && value.released === true ? { released: true as const } : null,
  });
  return result.ok ? { ok: true, released: true, replayed: result.replayed === true } : result;
}
export function readRepositoryRecoveryReservation(workspace: string, storeId: string, projectId: string):
RepositoryExecutionResult<{ handle: RepositoryExecutionHandle | null; everExecuted: boolean }> {
  const resolved = resolveRepositoryExecutionIdentity(workspace); if (!resolved.ok) return resolved;
  const result = accessRepositoryExecution(resolved.identity, "READ", (record) => {
    if (record !== null && (record.owner.projectId !== projectId || record.owner.storeId !== storeId)) {
      return repositoryExecutionFailure("REPOSITORY_EXECUTION_OWNER_MISMATCH");
    }
    return { ok: true, record, value: { handle: record === null ? null : executionHandle(record, resolved.identity), everExecuted: record?.everExecuted ?? false } };
  });
  return result.ok ? { ok: true, ...result.value } : result;
}
