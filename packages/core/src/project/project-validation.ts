import { RUNTIME_LIFECYCLES } from "@moe/contracts";

import type {
  ProjectActivationWitness,
  ProjectCommand,
  ProjectCommandKind,
  ProjectLifecycle,
  ProjectState,
  RecoveryCompletionWitness,
  RepositoryObservation,
  RestoreQuiesceWitness,
} from "./project-contract.js";

export const PROJECT_COMMAND_KINDS = Object.freeze([
  "project.register", "project.bind_repository", "project.activate",
  "recovery.restore_quiesce", "recovery.complete",
] as const satisfies readonly ProjectCommandKind[]);

const HASH_64 = /^[0-9a-f]{64}$/;
const OBSERVATION_KEYS = ["baseRevisionHash", "repositoryRef", "scopeRef", "truthClass"];
const ACTIVATION_KEYS = [
  "artifactPathRef", "backupPathRef", "credentialRef", "distributionManifestHash",
  "policyRevisionHash", "providerMinimumProfileRef", "signingKeyRef", "storeDriverRef",
  "truthClass",
];
const RESTORE_KEYS = ["backupGenerationHash", "recoveryIncarnationRef", "truthClass"];
const RECOVERY_KEYS = [
  "coverageProofHash", "inventoryReconciliationHash", "recoveryDecisionRef",
  "recoveryIncarnationRef", "truthClass",
];
const STATE_KEYS = [
  "lifecycle", "owner", "projectId", "recoveryRequired", "repositoryObservations", "version",
];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

type DataSnapshot = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
const SNAPSHOT_FAILURE = Object.freeze({ ok: false as const });
const INVALID_SNAPSHOT_VALUE = Symbol("INVALID_SNAPSHOT_VALUE");

function snapshotData(value: unknown, seen = new WeakSet<object>()): DataSnapshot {
  const kind = typeof value;
  if (value === null || kind === "undefined" || kind === "boolean"
    || kind === "number" || kind === "string") return { ok: true, value };
  if (kind !== "object") return SNAPSHOT_FAILURE;
  const source = value as object;
  if (seen.has(source)) return SNAPSHOT_FAILURE;
  seen.add(source);
  try {
    if (Array.isArray(source)) {
      const lengthProperty = Object.getOwnPropertyDescriptor(source, "length");
      const length = lengthProperty !== undefined && "value" in lengthProperty
        ? lengthProperty.value : undefined;
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
        return SNAPSHOT_FAILURE;
      }
      const keys = Reflect.ownKeys(source).filter((key) => key !== "length");
      if (keys.length !== length) return SNAPSHOT_FAILURE;
      const items: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const property = Object.getOwnPropertyDescriptor(source, String(index));
        if (property === undefined || !property.enumerable || !("value" in property)) {
          return SNAPSHOT_FAILURE;
        }
        const nested = snapshotData(property.value, seen);
        if (!nested.ok) return nested;
        items.push(nested.value);
      }
      return { ok: true, value: items };
    }
    const prototype = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) return SNAPSHOT_FAILURE;
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== "string") return SNAPSHOT_FAILURE;
      const property = Object.getOwnPropertyDescriptor(source, key);
      if (property === undefined || !property.enumerable || !("value" in property)) {
        return SNAPSHOT_FAILURE;
      }
      const nested = snapshotData(property.value, seen);
      if (!nested.ok) return nested;
      copy[key] = nested.value;
    }
    return { ok: true, value: copy };
  } catch {
    return SNAPSHOT_FAILURE;
  } finally {
    seen.delete(source);
  }
}
function exact(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return false;
  try {
    return Reflect.ownKeys(value).length === keys.length && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

export function snapshotProjectCommand(value: unknown): ProjectCommand | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined;
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property === undefined || !property.enumerable || !("value" in property)) return undefined;
      const nested = snapshotData(property.value);
      record[key] = nested.ok ? nested.value : INVALID_SNAPSHOT_VALUE;
    }
    if (!PROJECT_COMMAND_KINDS.some((kind) => kind === record["kind"])) return undefined;
    return record as unknown as ProjectCommand;
  } catch {
    return undefined;
  }
}

export function validProjectRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && HASH_64.test(value);
}

function strongTruth(value: unknown): boolean {
  return value === "DAEMON_VERIFIED" || value === "HUMAN_APPROVED";
}

function validLifecycle(value: unknown): value is ProjectLifecycle {
  return typeof value === "string"
    && RUNTIME_LIFECYCLES.PROJECT.some((lifecycle) => lifecycle === value);
}

export function validObservation(value: unknown): value is RepositoryObservation {
  if (!exact(value, OBSERVATION_KEYS)) return false;
  const truth = value["truthClass"];
  return validProjectRef(value["repositoryRef"]) && validHash(value["baseRevisionHash"])
    && validProjectRef(value["scopeRef"])
    && (truth === "OBSERVED" || truth === "DAEMON_VERIFIED" || truth === "HUMAN_APPROVED");
}

export function validActivation(value: unknown): value is ProjectActivationWitness {
  return exact(value, ACTIVATION_KEYS) && validProjectRef(value["artifactPathRef"])
    && validProjectRef(value["backupPathRef"]) && validProjectRef(value["credentialRef"])
    && validHash(value["distributionManifestHash"]) && validHash(value["policyRevisionHash"])
    && validProjectRef(value["providerMinimumProfileRef"])
    && validProjectRef(value["signingKeyRef"]) && validProjectRef(value["storeDriverRef"])
    && strongTruth(value["truthClass"]);
}

export function validRestore(value: unknown): value is RestoreQuiesceWitness {
  return exact(value, RESTORE_KEYS) && validHash(value["backupGenerationHash"])
    && validProjectRef(value["recoveryIncarnationRef"]) && strongTruth(value["truthClass"]);
}

export function validRecovery(value: unknown): value is RecoveryCompletionWitness {
  return exact(value, RECOVERY_KEYS) && validHash(value["coverageProofHash"])
    && validHash(value["inventoryReconciliationHash"])
    && validProjectRef(value["recoveryDecisionRef"])
    && validProjectRef(value["recoveryIncarnationRef"])
    && value["truthClass"] === "HUMAN_APPROVED";
}

export function validExpectedVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function validProjectState(value: unknown): value is ProjectState {
  if (!exact(value, STATE_KEYS) || !validLifecycle(value["lifecycle"])) return false;
  const observations = value["repositoryObservations"];
  const version = value["version"];
  return validProjectRef(value["owner"]) && validProjectRef(value["projectId"])
    && Array.isArray(observations) && observations.every(validObservation)
    && Number.isSafeInteger(version) && (version as number) >= 1
    && value["recoveryRequired"] === (value["lifecycle"] === "QUIESCED");
}

export function snapshotProjectState(value: unknown): ProjectState | undefined {
  const snapshot = snapshotData(value);
  return snapshot.ok && validProjectState(snapshot.value) ? snapshot.value : undefined;
}
