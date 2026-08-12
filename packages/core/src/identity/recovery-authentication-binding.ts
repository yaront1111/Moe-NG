import type { RestoreQuiesceWitness } from "../project/project-contract.js";
import { snapshotExactArray, snapshotExactRecord } from "./identity-snapshot.js";

export type RecoveryIncarnationRef = RestoreQuiesceWitness["recoveryIncarnationRef"];
export type KeyEpochRef = string;

export interface RecoveryAuthenticationBinding {
  readonly recoveryIncarnationRef: RecoveryIncarnationRef;
  readonly keyEpochRef: KeyEpochRef;
}

const BINDING_KEYS = ["recoveryIncarnationRef", "keyEpochRef"] as const;
const DIGEST_REF = /^[a-f0-9]{64}$/u;

export function isRecoveryAuthenticationRef(value: unknown): value is string {
  return typeof value === "string" && DIGEST_REF.test(value);
}

/** Hostile-safe exact snapshot of the public recovery authority refs. */
export function createRecoveryAuthenticationBinding(
  value: unknown,
): RecoveryAuthenticationBinding | null {
  const copy = snapshotExactRecord(value, BINDING_KEYS);
  if (copy === null) return null;
  if (!isRecoveryAuthenticationRef(copy.recoveryIncarnationRef)) return null;
  if (!isRecoveryAuthenticationRef(copy.keyEpochRef)) return null;
  return Object.freeze({
    recoveryIncarnationRef: copy.recoveryIncarnationRef,
    keyEpochRef: copy.keyEpochRef,
  });
}

export function snapshotRecoveryAuthenticationBindings(
  value: unknown,
): readonly RecoveryAuthenticationBinding[] | null {
  const entries = snapshotExactArray(value);
  if (entries === null) return null;
  const snapshots: RecoveryAuthenticationBinding[] = [];
  for (const entry of entries) {
    const snapshot = createRecoveryAuthenticationBinding(entry);
    if (snapshot === null) return null;
    snapshots.push(snapshot);
  }
  return Object.freeze(snapshots);
}

export function sameRecoveryAuthenticationBinding(
  left: RecoveryAuthenticationBinding,
  right: RecoveryAuthenticationBinding,
): boolean {
  return (
    left.recoveryIncarnationRef === right.recoveryIncarnationRef &&
    left.keyEpochRef === right.keyEpochRef
  );
}
