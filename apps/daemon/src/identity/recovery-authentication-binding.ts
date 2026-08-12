import { RECOVERY_BINDING_SLOTS } from "@moe/store";
import type { SqliteEventStore } from "@moe/store";
import type { RecoveryAuthenticationBinding } from "@moe/core";

const DIGEST_REF = /^[0-9a-f]{64}$/u;

export function isRecoveryAuthenticationRef(value: unknown): value is string {
  return typeof value === "string" && DIGEST_REF.test(value);
}

/** Drops every non-public/non-binding property from a wider trusted record. */
export function projectRecoveryAuthenticationBinding(
  value: RecoveryAuthenticationBinding,
): RecoveryAuthenticationBinding {
  return Object.freeze({
    keyEpochRef: value.keyEpochRef,
    recoveryIncarnationRef: value.recoveryIncarnationRef,
  });
}

/**
 * Reads the installer-selected authority directly from the project-scoped store.
 * The fixed ACTIVE slot is deliberate: accepting a request-selected slot or ref
 * would let restored credentials choose which recovery identity is "current".
 */
export function readCurrentRecoveryAuthenticationBinding(
  store: SqliteEventStore,
): RecoveryAuthenticationBinding | null {
  try {
    const read = store.readRecoveryBinding(RECOVERY_BINDING_SLOTS[0]);
    if (!read.ok || read.outcome !== "FOUND") return null;
    const { incarnationRef, keyEpochRef } = read.binding;
    if (!isRecoveryAuthenticationRef(incarnationRef)) return null;
    if (!isRecoveryAuthenticationRef(keyEpochRef)) return null;
    return projectRecoveryAuthenticationBinding({
      keyEpochRef, recoveryIncarnationRef: incarnationRef,
    });
  } catch {
    return null;
  }
}
