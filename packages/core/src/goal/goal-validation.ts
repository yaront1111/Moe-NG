import { RUNTIME_LIFECYCLES } from "@moe/contracts";

import type {
  AcceptanceClosureWitness,
  CancellationAuthorizationWitness,
  GoalCommand,
  GoalCommandKind,
  GoalLifecycle,
  GoalSchedulingControl,
  GoalState,
  InitialGraphActivationWitness,
  ProjectReadyWitness,
  QualificationInvalidationWitness,
  ReopenAuthorizationWitness,
  ZeroAuthorityWitness,
} from "./goal-contract.js";

export const GOAL_COMMAND_KINDS = Object.freeze([
  "goal.create", "goal.activate_initial_graph", "goal.close",
  "goal.qualification_invalidated", "goal.cancel", "goal.reopen_as_revision",
  "goal.pause", "goal.resume",
] as const satisfies readonly GoalCommandKind[]);

const PROJECT_READY_KEYS = ["projectReadyRef", "truthClass"] as const;
const ACTIVATION_KEYS = ["activeGraphRevisionRef", "graphApprovalRef", "truthClass"] as const;
const CLOSURE_KEYS = [
  "acceptanceClosureRef", "completionNodeAcceptedRef", "noCurrentPreparationGeneration",
  "noPendingDraftOrSupersession", "obligationsHoldRef", "truthClass",
] as const;
const ZERO_KEYS = ["truthClass", "zeroAuthorityProofRef"] as const;
const INVALIDATION_KEYS = ["proofInvalidatedRef", "truthClass"] as const;
const CANCELLATION_KEYS = [
  "authorizationRef", "subordinateAuthorityFenced", "truthClass",
] as const;
const REOPEN_KEYS = ["authorizationRef", "truthClass"] as const;
const RECOVERY_KEYS = ["qualificationInvalidatedRef"] as const;
const STATE_KEYS = [
  "activeGraphRevisionRef", "budgetAccountRef", "generation", "goalId", "graphEpoch",
  "lifecycle", "planningRunRef", "predecessorGoalRef", "projectId", "recoveryFacets",
  "schedulingControl", "version",
] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

type DataSnapshot = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
const SNAPSHOT_FAILURE = Object.freeze({ ok: false as const });

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

export function snapshotGoalCommand(value: unknown): GoalCommand | undefined {
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
      record[key] = nested.ok ? nested.value : undefined;
    }
    if (!GOAL_COMMAND_KINDS.some((kind) => kind === record["kind"])) return undefined;
    return record as unknown as GoalCommand;
  } catch {
    return undefined;
  }
}

export function validRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function strongTruth(value: unknown): boolean {
  return value === "DAEMON_VERIFIED" || value === "HUMAN_APPROVED";
}

export function validProjectReady(value: unknown): value is ProjectReadyWitness {
  return exact(value, PROJECT_READY_KEYS) && validRef(value["projectReadyRef"])
    && strongTruth(value["truthClass"]);
}

export function validActivation(value: unknown): value is InitialGraphActivationWitness {
  return exact(value, ACTIVATION_KEYS) && validRef(value["activeGraphRevisionRef"])
    && validRef(value["graphApprovalRef"]) && strongTruth(value["truthClass"]);
}

export function validClosure(value: unknown): value is AcceptanceClosureWitness {
  return exact(value, CLOSURE_KEYS) && validRef(value["acceptanceClosureRef"])
    && validRef(value["completionNodeAcceptedRef"])
    && value["noCurrentPreparationGeneration"] === true
    && value["noPendingDraftOrSupersession"] === true
    && validRef(value["obligationsHoldRef"]) && strongTruth(value["truthClass"]);
}

export function validZeroAuthority(value: unknown): value is ZeroAuthorityWitness {
  return exact(value, ZERO_KEYS) && validRef(value["zeroAuthorityProofRef"])
    && strongTruth(value["truthClass"]);
}

export function validInvalidation(value: unknown): value is QualificationInvalidationWitness {
  return exact(value, INVALIDATION_KEYS) && validRef(value["proofInvalidatedRef"])
    && strongTruth(value["truthClass"]);
}

export function validCancellation(value: unknown): value is CancellationAuthorizationWitness {
  return exact(value, CANCELLATION_KEYS) && validRef(value["authorizationRef"])
    && value["subordinateAuthorityFenced"] === true
    && value["truthClass"] === "HUMAN_APPROVED";
}

export function validReopen(value: unknown): value is ReopenAuthorizationWitness {
  return exact(value, REOPEN_KEYS) && validRef(value["authorizationRef"])
    && value["truthClass"] === "HUMAN_APPROVED";
}

export function validPause(value: unknown): value is Exclude<GoalSchedulingControl, "RUNNING"> {
  return value === "PAUSE_AFTER_CURRENT_STEP" || value === "DRAIN_AND_PAUSE";
}

export function validExpectedVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validLifecycle(value: unknown): value is GoalLifecycle {
  return typeof value === "string"
    && RUNTIME_LIFECYCLES.GOAL.some((lifecycle) => lifecycle === value);
}

function validScheduling(value: unknown): value is GoalSchedulingControl {
  return typeof value === "string"
    && RUNTIME_LIFECYCLES.GOAL_SCHEDULING.some((control) => control === value);
}

function validRecoveryFacets(value: unknown, lifecycle: GoalLifecycle): boolean {
  return exact(value, RECOVERY_KEYS)
    && (value["qualificationInvalidatedRef"] === null
      || (lifecycle === "EXECUTION_ENABLED"
        && validRef(value["qualificationInvalidatedRef"])));
}

function validLineage(goalId: unknown, predecessor: unknown, generation: unknown): boolean {
  if (!validRef(goalId) || !Number.isSafeInteger(generation) || (generation as number) < 1) {
    return false;
  }
  return generation === 1
    ? predecessor === null
    : validRef(predecessor) && predecessor !== goalId;
}

export function validGoalState(value: unknown): value is GoalState {
  if (!exact(value, STATE_KEYS) || !validLifecycle(value["lifecycle"])) return false;
  const lifecycle = value["lifecycle"];
  const active = lifecycle === "EXECUTION_ENABLED" || lifecycle === "CLOSING";
  const version = value["version"];
  const generation = value["generation"];
  const epoch = value["graphEpoch"];
  return validLineage(value["goalId"], value["predecessorGoalRef"], generation)
    && validRef(value["projectId"])
    && validRef(value["budgetAccountRef"]) && validRef(value["planningRunRef"])
    && validRecoveryFacets(value["recoveryFacets"], lifecycle)
    && validScheduling(value["schedulingControl"])
    && Number.isSafeInteger(version) && (version as number) >= 1
    && Number.isSafeInteger(epoch) && (epoch as number) >= 0
    && (lifecycle !== "DRAFT" || epoch === 0)
    && (lifecycle !== "COMPLETED" || (epoch as number) > 0)
    && (active ? validRef(value["activeGraphRevisionRef"]) && (epoch as number) > 0
      : value["activeGraphRevisionRef"] === null);
}

export function snapshotGoalState(value: unknown): GoalState | undefined {
  const snapshot = snapshotData(value);
  return snapshot.ok && validGoalState(snapshot.value) ? snapshot.value : undefined;
}
