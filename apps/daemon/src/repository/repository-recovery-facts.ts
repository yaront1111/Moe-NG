import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { recoveryRefusal } from "./repository-recovery-contracts.js";
import type { RepositoryRecoveryResult } from "./repository-recovery-contracts.js";

export const RECOVERY_FACT_PRINCIPAL = "daemon:repository-recovery";
export const recoveryDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const encoder = new TextEncoder();
export function readRecoveryFact(store: SqliteEventStore, projectId: string, commandId: string, kind: string, aggregateId: string):
RepositoryRecoveryResult<{ value: unknown | null }> {
  try {
    const row = store.getCommandDecision({ projectId, principalId: RECOVERY_FACT_PRINCIPAL, commandId });
    if (row === null) return { ok: true, value: null };
    if (row.effectDisposition !== "EFFECTS_COMMITTED" || row.commandKind !== kind || row.targetAggregateId !== aggregateId
      || row.key.projectId !== projectId || row.key.commandId !== commandId || row.key.principalId !== RECOVERY_FACT_PRINCIPAL) {
      return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
    }
    const parsed = decodeBoundedJsonBytes(row.resultBytes);
    return parsed.ok ? { ok: true, value: parsed.value } : recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
  } catch { return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID"); }
}
export function writeRecoveryFact(store: SqliteEventStore, projectId: string, commandId: string, kind: string, aggregateId: string,
  value: unknown): RepositoryRecoveryResult<Record<never, never>> {
  const previous = readRecoveryFact(store, projectId, commandId, kind, aggregateId);
  if (!previous.ok) return previous;
  if (previous.value !== null) return JSON.stringify(previous.value) === JSON.stringify(value)
    ? { ok: true } : recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_CONFLICT");
  try {
    const bytes = encoder.encode(JSON.stringify(value));
    if (!decodeBoundedJsonBytes(bytes).ok) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
    const response = store.commitExpectedVersionDecision({ commandKind: kind, committedResultBytes: bytes,
      correlationId: commandId, decidedAt: new Date().toISOString(),
      events: [{ eventId: `${commandId}-recorded`, eventType: "RepositoryRecoveryEvidenceRecorded", payload: bytes }],
      expectedVersion: store.getAggregateVersion(aggregateId), key: { projectId, principalId: RECOVERY_FACT_PRINCIPAL, commandId },
      requestBytes: bytes, targetAggregateId: aggregateId });
    if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_CONFLICT");
    const stored = readRecoveryFact(store, projectId, commandId, kind, aggregateId);
    return stored.ok && JSON.stringify(stored.value) === JSON.stringify(value) ? { ok: true }
      : recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
  } catch { return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_INVALID"); }
}
