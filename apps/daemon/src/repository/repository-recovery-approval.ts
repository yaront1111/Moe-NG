import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import type { RepositoryExecutionIdentity } from "./repository-execution-contracts.js";
import type { RepositoryRecoveryCommand } from "./repository-recovery-service.js";
import { recoveryRefusal } from "./repository-recovery-contracts.js";
import type { RepositoryRecoveryResult } from "./repository-recovery-contracts.js";
import { RECOVERY_FACT_PRINCIPAL, recoveryDigest } from "./repository-recovery-facts.js";
export interface RecoveryApproval { readonly requestSha256: string; readonly ownerDigest: string; readonly identity: RepositoryExecutionIdentity }
const kind = "repository.recovery.approved";
const approvalKey = (projectId: string, input: RepositoryRecoveryCommand) => ({ projectId, principalId: RECOVERY_FACT_PRINCIPAL,
  commandId: recoveryDigest([kind, input.principalId, input.commandId]) });
export function readRecoveryApproval(store: SqliteEventStore, projectId: string, input: RepositoryRecoveryCommand,
  requestSha256: string): RepositoryRecoveryResult<{ approval: RecoveryApproval | null }> {
  try {
    const key = approvalKey(projectId, input); const row = store.getCommandDecision(key);
    if (row === null) return { ok: true, approval: null };
    if (row.commandKind !== kind || row.effectDisposition !== "EFFECTS_COMMITTED" || row.targetAggregateId !== input.targetAggregateId
      || row.key.commandId !== key.commandId || row.key.projectId !== projectId || row.key.principalId !== key.principalId) {
      return recoveryRefusal("REPOSITORY_RECOVERY_APPROVAL_CONFLICT");
    }
    const decoded = decodeBoundedJsonBytes(row.resultBytes); const value = decoded.ok ? decoded.value as Partial<RecoveryApproval> | null : null;
    if (value === null || typeof value !== "object" || value.requestSha256 !== requestSha256 || typeof value.ownerDigest !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.ownerDigest) || typeof value.identity?.root !== "string" || typeof value.identity.gitDirectory !== "string") {
      return recoveryRefusal("REPOSITORY_RECOVERY_APPROVAL_CONFLICT");
    }
    return { ok: true, approval: value as RecoveryApproval };
  } catch { return recoveryRefusal("REPOSITORY_RECOVERY_APPROVAL_UNKNOWN"); }
}
export function recordRecoveryApproval(store: SqliteEventStore, projectId: string, input: RepositoryRecoveryCommand,
  approval: RecoveryApproval, decidedAt: string): RepositoryRecoveryResult<Record<never, never>> {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(approval)); const key = approvalKey(projectId, input);
    const response = store.commitExpectedVersionDecision({ commandKind: kind, committedResultBytes: bytes,
      correlationId: input.correlationId, decidedAt, events: [{ eventId: `${key.commandId}:approved`, eventType: "RepositoryRecoveryApproved",
        payload: new TextEncoder().encode(JSON.stringify({ ...approval, principalId: input.principalId, commandId: input.commandId, payload: input.payload })) }],
      expectedVersion: input.expectedVersion, key, requestBytes: bytes, targetAggregateId: input.targetAggregateId });
    if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") return recoveryRefusal("REPOSITORY_RECOVERY_VERSION_CONFLICT");
    const checked = readRecoveryApproval(store, projectId, input, approval.requestSha256);
    return checked.ok && JSON.stringify(checked.approval) === JSON.stringify(approval) ? { ok: true }
      : recoveryRefusal("REPOSITORY_RECOVERY_APPROVAL_CONFLICT");
  } catch { return recoveryRefusal("REPOSITORY_RECOVERY_APPROVAL_UNKNOWN"); }
}
