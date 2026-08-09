import { RUNTIME_LIFECYCLES } from "@moe/contracts";

import type {
  GraphActivationBinding,
  GraphRevisionActivationWitness,
  GraphRevisionApprovalWitness,
  GraphRevisionLifecycle,
  GraphRevisionRefusalWitness,
  GraphRevisionState,
  GraphRevisionSuccessionBinding,
  GraphSubmissionWitness,
} from "./graph-revision-contract.js";
import {
  exact,
  snapshotData,
  strongTruth,
  validHex64,
  validRef,
} from "./planning-snapshot.js";

const BINDING_KEYS = [
  "budgetHash", "expectedGoalVersion", "graphHash", "policyHash", "qualityHash",
] as const;
const SUBMISSION_KEYS = ["submissionRef", "truthClass"] as const;
const APPROVAL_KEYS = [...BINDING_KEYS, "approvalRef", "truthClass"] as const;
const ACTIVATION_KEYS = [...BINDING_KEYS, "activationRef", "graphEpoch", "truthClass"] as const;
/** The succession binding is optional, and `exact` rejects extra keys, so it needs its own tuple. */
const SUCCESSION_ACTIVATION_KEYS = [...ACTIVATION_KEYS, "succession"] as const;
const SUCCESSION_KEYS = [
  "predecessorGraphContentHash", "predecessorGraphEpoch", "predecessorRevisionId",
] as const;
const REFUSAL_KEYS = ["findingsRef", "truthClass"] as const;
const STATE_KEYS = [
  "boundHashes", "goalRef", "graphContentHash", "graphEpoch", "lifecycle", "planHash",
  "revisionId", "submissionRef", "version",
] as const;
const BOUND_STATES: readonly GraphRevisionLifecycle[] = ["APPROVED", "ACTIVE", "SUPERSEDED"];
const EPOCH_BOUND_STATES: readonly GraphRevisionLifecycle[] = ["ACTIVE", "SUPERSEDED"];

function bindingShape(value: Readonly<Record<string, unknown>>): boolean {
  return validHex64(value["budgetHash"]) && validHex64(value["graphHash"])
    && validHex64(value["policyHash"]) && validHex64(value["qualityHash"])
    && Number.isSafeInteger(value["expectedGoalVersion"])
    && (value["expectedGoalVersion"] as number) >= 1;
}

export function validBinding(value: unknown): value is GraphActivationBinding {
  return exact(value, BINDING_KEYS) && bindingShape(value);
}

/** Exact identity equality: any drifted byte or goal version is a stale binding. */
export function sameBinding(left: GraphActivationBinding, right: GraphActivationBinding): boolean {
  return BINDING_KEYS.every((key) => left[key] === right[key]);
}

export function bindingOf(source: GraphActivationBinding): GraphActivationBinding {
  return {
    budgetHash: source.budgetHash, expectedGoalVersion: source.expectedGoalVersion,
    graphHash: source.graphHash, policyHash: source.policyHash, qualityHash: source.qualityHash,
  };
}

export function validSubmission(value: unknown): value is GraphSubmissionWitness {
  return exact(value, SUBMISSION_KEYS) && validRef(value["submissionRef"])
    && strongTruth(value["truthClass"]);
}

export function validApproval(value: unknown): value is GraphRevisionApprovalWitness {
  return exact(value, APPROVAL_KEYS) && bindingShape(value) && validRef(value["approvalRef"])
    && strongTruth(value["truthClass"]);
}

/** Names the predecessor a successor activation replaces; an unusable epoch here is UNKNOWN. */
export function validSuccessionBinding(value: unknown): value is GraphRevisionSuccessionBinding {
  return exact(value, SUCCESSION_KEYS) && validHex64(value["predecessorGraphContentHash"])
    && validRef(value["predecessorRevisionId"])
    && Number.isSafeInteger(value["predecessorGraphEpoch"])
    && (value["predecessorGraphEpoch"] as number) >= 1;
}

/**
 * The epoch is goal-issued authority bound onto this activation, never a counter advanced here:
 * an initial activation lands at exactly 1 and a successor at exactly the named predecessor's
 * epoch + 1. Absent, non-integer, negative or skipped epochs refuse rather than default.
 */
function validActivationEpoch(value: Readonly<Record<string, unknown>>): boolean {
  const graphEpoch = value["graphEpoch"];
  if (!Number.isSafeInteger(graphEpoch)) return false;
  if (!("succession" in value)) return graphEpoch === 1;
  const succession = value["succession"];
  return validSuccessionBinding(succession)
    && graphEpoch === succession.predecessorGraphEpoch + 1;
}

export function validActivation(value: unknown): value is GraphRevisionActivationWitness {
  if (!exact(value, ACTIVATION_KEYS) && !exact(value, SUCCESSION_ACTIVATION_KEYS)) return false;
  return bindingShape(value) && validRef(value["activationRef"])
    && strongTruth(value["truthClass"]) && validActivationEpoch(value);
}

export function validRefusal(value: unknown): value is GraphRevisionRefusalWitness {
  return exact(value, REFUSAL_KEYS) && validRef(value["findingsRef"])
    && strongTruth(value["truthClass"]);
}

function validLifecycle(value: unknown): value is GraphRevisionLifecycle {
  return typeof value === "string"
    && RUNTIME_LIFECYCLES.GRAPH_REVISION.some((lifecycle) => lifecycle === value);
}

/** A bound identity may exist only where approval has happened, and always over this content. */
function validBoundPlacement(
  lifecycle: GraphRevisionLifecycle,
  bound: unknown,
  content: unknown,
): boolean {
  if (bound === null) return !BOUND_STATES.includes(lifecycle);
  return (BOUND_STATES.includes(lifecycle) || lifecycle === "REJECTED")
    && validBinding(bound) && bound.graphHash === content;
}

/** A bound epoch may exist only where activation has happened; anything else is UNKNOWN. */
function validGraphEpochPlacement(
  lifecycle: GraphRevisionLifecycle,
  graphEpoch: unknown,
): boolean {
  if (!Number.isSafeInteger(graphEpoch)) return false;
  return EPOCH_BOUND_STATES.includes(lifecycle)
    ? (graphEpoch as number) >= 1 : graphEpoch === 0;
}

function validSubmissionPlacement(
  lifecycle: GraphRevisionLifecycle,
  submissionRef: unknown,
): boolean {
  if (lifecycle === "DRAFT") return submissionRef === null;
  if (lifecycle === "REJECTED") return submissionRef === null || validRef(submissionRef);
  return validRef(submissionRef);
}

export function validGraphRevisionState(value: unknown): value is GraphRevisionState {
  if (!exact(value, STATE_KEYS) || !validLifecycle(value["lifecycle"])) return false;
  const lifecycle = value["lifecycle"];
  const version = value["version"];
  const content = value["graphContentHash"];
  return validRef(value["revisionId"]) && validRef(value["goalRef"]) && validHex64(content)
    && validHex64(value["planHash"]) && Number.isSafeInteger(version) && (version as number) >= 1
    && validBoundPlacement(lifecycle, value["boundHashes"], content)
    && validGraphEpochPlacement(lifecycle, value["graphEpoch"])
    && validSubmissionPlacement(lifecycle, value["submissionRef"]);
}

export function snapshotGraphRevisionState(value: unknown): GraphRevisionState | undefined {
  const snapshot = snapshotData(value);
  return snapshot.ok && validGraphRevisionState(snapshot.value) ? snapshot.value : undefined;
}
