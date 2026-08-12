import type { RestoreQuiesceWitness } from "../project/project-contract.js";

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
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== BINDING_KEYS.length) return null;
    const copy: Record<string, unknown> = {};
    for (const key of BINDING_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      copy[key] = descriptor.value;
    }
    if (!isRecoveryAuthenticationRef(copy.recoveryIncarnationRef)) return null;
    if (!isRecoveryAuthenticationRef(copy.keyEpochRef)) return null;
    return Object.freeze({
      recoveryIncarnationRef: copy.recoveryIncarnationRef,
      keyEpochRef: copy.keyEpochRef,
    });
  } catch {
    return null;
  }
}

export function snapshotRecoveryAuthenticationBindings(
  value: unknown,
): readonly RecoveryAuthenticationBinding[] | null {
  try {
    if (!Array.isArray(value)) return null;
    if (Object.getOwnPropertyDescriptor(value, Symbol.iterator) !== undefined) return null;
    const ownKeys = Object.keys(value);
    if (ownKeys.length !== value.length) return null;
    if (!ownKeys.every((key, index) => key === String(index))) return null;
    const snapshots: RecoveryAuthenticationBinding[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return null;
      const snapshot = createRecoveryAuthenticationBinding(descriptor.value);
      if (snapshot === null) return null;
      snapshots.push(snapshot);
    }
    return Object.freeze(snapshots);
  } catch {
    return null;
  }
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
