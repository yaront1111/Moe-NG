import type { SqliteEventStore } from "@moe/store";
import type { RepositoryLandingIntent } from "./repository-landing-intent-contracts.js";
import type { RepositoryRecoveryResult } from "./repository-recovery-contracts.js";
import { recoveryRefusal } from "./repository-recovery-contracts.js";
import { readRecoveryFact, recoveryDigest, RECOVERY_FACT_PRINCIPAL } from "./repository-recovery-facts.js";
const kind = "internal.repository.landing_attempt";
const target = (intent: RepositoryLandingIntent) => `repository-landing-attempt:${intent.intentId}`;
const key = (intent: RepositoryLandingIntent, version: number) => recoveryDigest([kind, intent.intentId, version]);
export function repositoryLandingMayRetry(store: SqliteEventStore, intent: RepositoryLandingIntent): boolean {
  const version = store.getAggregateVersion(target(intent)); if (version < 1) return false;
  const prior = readRecoveryFact(store, intent.projectId, key(intent, version), kind, target(intent));
  return prior.ok && JSON.stringify(prior.value) === JSON.stringify({ intentId: intent.intentId, version, state: "NO_EFFECT" });
}
function append(store: SqliteEventStore, intent: RepositoryLandingIntent, version: number, state: "STARTED" | "NO_EFFECT"):
RepositoryRecoveryResult<Record<never, never>> {
  try {
    const commandId = key(intent, version + 1); const bytes = new TextEncoder().encode(JSON.stringify({ intentId: intent.intentId, version: version + 1, state }));
    const response = store.commitExpectedVersionDecision({ commandKind: kind, committedResultBytes: bytes, correlationId: commandId,
      decidedAt: new Date().toISOString(), events: [{ eventId: commandId, eventType: "RepositoryLandingAttemptRecorded", payload: bytes }],
      expectedVersion: version, key: { projectId: intent.projectId, principalId: RECOVERY_FACT_PRINCIPAL, commandId },
      requestBytes: bytes, targetAggregateId: target(intent) });
    return response.disposition === "DECIDED" && response.decision.effectDisposition === "EFFECTS_COMMITTED" ? { ok: true }
      : recoveryRefusal("REPOSITORY_RECOVERY_REQUIRED");
  } catch { return recoveryRefusal("REPOSITORY_RECOVERY_REQUIRED"); }
}
export function startRepositoryLandingAttempt(store: SqliteEventStore, intent: RepositoryLandingIntent): RepositoryRecoveryResult<{ version: number }> {
  const version = store.getAggregateVersion(target(intent));
  if (version > 0) {
    if (!repositoryLandingMayRetry(store, intent)) {
      return recoveryRefusal("REPOSITORY_RECOVERY_REQUIRED");
    }
  }
  const result = append(store, intent, version, "STARTED"); return result.ok ? { ok: true, version: version + 1 } : result;
}
export function finishRepositoryLandingNoEffect(store: SqliteEventStore, intent: RepositoryLandingIntent, version: number): RepositoryRecoveryResult<Record<never, never>> {
  if (store.getAggregateVersion(target(intent)) !== version) return recoveryRefusal("REPOSITORY_RECOVERY_REQUIRED");
  const prior = readRecoveryFact(store, intent.projectId, key(intent, version), kind, target(intent));
  if (!prior.ok || JSON.stringify(prior.value) !== JSON.stringify({ intentId: intent.intentId, version, state: "STARTED" })) {
    return recoveryRefusal("REPOSITORY_RECOVERY_REQUIRED");
  }
  return append(store, intent, version, "NO_EFFECT");
}
