import { RUNTIME_LIFECYCLES } from "@moe/contracts";

import type {
  NodeSummary,
  PlanApprovalWitness,
  PlanRevisionHashes,
  PlanRevisionSeal,
  PlanSubmissionWitness,
  PlanningAbsenceRecoveryWitness,
  PlanningActivationWitness,
  PlanningCancellationWitness,
  PlanningClaimWitness,
  PlanningEffectTerminalProof,
  PlanningReadinessWitness,
  PlanningRefusalWitness,
  PlanningReleaseWitness,
  PlanningResumeProof,
  PlanningRunFacets,
  PlanningRunKind,
  PlanningRunLifecycle,
  PlanningRunState,
  SubmissionFinalizeWitness,
} from "./planning-contract.js";
import {
  exact,
  humanApproved,
  snapshotData,
  strongTruth,
  validHex64,
  validRef,
} from "./planning-snapshot.js";

const HASH_KEYS = ["dependencyHash", "graphContentHash", "planHash", "qualityHash"] as const;
const FACET_KEYS = ["leaseSuspect", "livePlannerEffect", "owned", "resumable"] as const;
const STATE_KEYS = [
  "approvedHashes", "attemptRef", "facets", "goalRef", "graphRevisionRef", "leaseRef",
  "lifecycle", "runId", "runKind", "sealedHashes", "submissionHash", "version",
] as const;
const READINESS_KEYS = [
  "acceptanceCriteriaRef", "intentBaseRef", "planningBudgetRef", "truthClass",
] as const;
const CLAIM_KEYS = [
  "attemptRef", "contextRef", "leaseRef", "providerSlotRef", "truthClass",
] as const;
const RESUME_KEYS = [
  "handoffKind", "handoffRef", "priorAttemptTerminalRef", "truthClass",
] as const;
const RELEASE_KEYS = ["attemptTerminalRef", "handoffRef", "truthClass"] as const;
const RECOVERY_KEYS = [
  "effectsAbsentRef", "leaseFencedRef", "missingInMemoryState", "priorAttemptTerminalRef",
  "recoverySealRef", "resourcesAbsentRef", "truthClass",
] as const;
const SUBMISSION_KEYS = ["attemptRef", "submissionRef", "truthClass"] as const;
const EFFECT_TERMINAL_KEYS = [
  "effectTerminalRef", "resourcesTerminalRef", "truthClass",
] as const;
const NODE_SUMMARY_KEYS = ["executionBearing", "nodeKey"] as const;
const FINALIZE_KEYS = [
  "attemptTerminalRef", "effectTerminalRef", "nodeSummaries", "providerSlotTerminalRef",
  "resourcesTerminalRef", "truthClass",
] as const;
const SEAL_KEYS = [...HASH_KEYS, "graphRevisionRef"] as const;
const REFUSAL_KEYS = ["findingsRef", "successorRunId", "truthClass"] as const;
const APPROVAL_KEYS = [...HASH_KEYS, "approvalRef", "truthClass"] as const;
const ACTIVATION_KEYS = [
  "activationRef", "budgetHash", "expectedGoalVersion", "goalDraftNoActiveRevision",
  "graphHash", "policyHash", "qualityHash", "truthClass",
] as const;
const CANCELLATION_KEYS = [
  "authorizationRef", "noLiveOrUnknownEffect", "truthClass",
] as const;

export const PLANNING_RUN_KINDS = Object.freeze(
  ["INITIAL", "REVISION", "EXPANSION"] as const satisfies readonly PlanningRunKind[],
);

export function validRunKind(value: unknown): value is PlanningRunKind {
  return PLANNING_RUN_KINDS.some((kind) => kind === value);
}

export function validHashes(value: unknown): value is PlanRevisionHashes {
  return exact(value, HASH_KEYS) && HASH_KEYS.every((key) => validHex64(value[key]));
}

export function sameHashes(left: PlanRevisionHashes, right: PlanRevisionHashes): boolean {
  return HASH_KEYS.every((key) => left[key] === right[key]);
}

export function validReadiness(value: unknown): value is PlanningReadinessWitness {
  return exact(value, READINESS_KEYS) && validRef(value["acceptanceCriteriaRef"])
    && validRef(value["intentBaseRef"]) && validRef(value["planningBudgetRef"])
    && strongTruth(value["truthClass"]);
}

export function validClaim(value: unknown): value is PlanningClaimWitness {
  return exact(value, CLAIM_KEYS) && validRef(value["attemptRef"])
    && validRef(value["contextRef"]) && validRef(value["leaseRef"])
    && validRef(value["providerSlotRef"]) && strongTruth(value["truthClass"]);
}

export function validResume(value: unknown): value is PlanningResumeProof {
  return exact(value, RESUME_KEYS)
    && (value["handoffKind"] === "SAFE_RELEASE_HANDOFF"
      || value["handoffKind"] === "NO_HANDOFF_RECOVERY")
    && validRef(value["handoffRef"]) && validRef(value["priorAttemptTerminalRef"])
    && strongTruth(value["truthClass"]);
}

export function validRelease(value: unknown): value is PlanningReleaseWitness {
  return exact(value, RELEASE_KEYS) && validRef(value["attemptTerminalRef"])
    && validRef(value["handoffRef"]) && strongTruth(value["truthClass"]);
}

export function validAbsenceRecovery(value: unknown): value is PlanningAbsenceRecoveryWitness {
  return exact(value, RECOVERY_KEYS) && validRef(value["effectsAbsentRef"])
    && validRef(value["leaseFencedRef"]) && value["missingInMemoryState"] === "UNKNOWN"
    && validRef(value["priorAttemptTerminalRef"]) && validRef(value["recoverySealRef"])
    && validRef(value["resourcesAbsentRef"]) && strongTruth(value["truthClass"]);
}

export function validSubmission(value: unknown): value is PlanSubmissionWitness {
  return exact(value, SUBMISSION_KEYS) && validRef(value["attemptRef"])
    && validRef(value["submissionRef"]) && strongTruth(value["truthClass"]);
}

export function validEffectTerminal(value: unknown): value is PlanningEffectTerminalProof {
  return exact(value, EFFECT_TERMINAL_KEYS) && validRef(value["effectTerminalRef"])
    && validRef(value["resourcesTerminalRef"]) && strongTruth(value["truthClass"]);
}

function validNodeSummary(value: unknown): value is NodeSummary {
  return exact(value, NODE_SUMMARY_KEYS) && typeof value["executionBearing"] === "boolean"
    && validRef(value["nodeKey"]);
}

export function validFinalize(value: unknown): value is SubmissionFinalizeWitness {
  if (!exact(value, FINALIZE_KEYS) || !validRef(value["attemptTerminalRef"])
    || !validRef(value["effectTerminalRef"]) || !validRef(value["providerSlotTerminalRef"])
    || !validRef(value["resourcesTerminalRef"]) || !strongTruth(value["truthClass"])) {
    return false;
  }
  const summaries = value["nodeSummaries"];
  if (!Array.isArray(summaries) || summaries.length === 0) return false;
  const keys = new Set<string>();
  for (const summary of summaries as readonly unknown[]) {
    if (!validNodeSummary(summary) || keys.has(summary.nodeKey)) return false;
    keys.add(summary.nodeKey);
  }
  return true;
}

/** The reducer derives the admission count itself; a caller-supplied count is never proof. */
export function executionBearingKeys(witness: SubmissionFinalizeWitness): readonly string[] {
  return witness.nodeSummaries.filter((summary) => summary.executionBearing)
    .map((summary) => summary.nodeKey);
}

export function validSeal(value: unknown): value is PlanRevisionSeal {
  return exact(value, SEAL_KEYS) && HASH_KEYS.every((key) => validHex64(value[key]))
    && validRef(value["graphRevisionRef"]);
}

export function validRefusal(value: unknown): value is PlanningRefusalWitness {
  return exact(value, REFUSAL_KEYS) && validRef(value["findingsRef"])
    && validRef(value["successorRunId"]) && strongTruth(value["truthClass"]);
}

export function validHumanRefusal(value: unknown): value is PlanningRefusalWitness {
  return validRefusal(value) && humanApproved(value.truthClass);
}

export function validPlanApproval(value: unknown): value is PlanApprovalWitness {
  return exact(value, APPROVAL_KEYS) && HASH_KEYS.every((key) => validHex64(value[key]))
    && validRef(value["approvalRef"]) && strongTruth(value["truthClass"]);
}

export function validActivation(value: unknown): value is PlanningActivationWitness {
  return exact(value, ACTIVATION_KEYS) && validRef(value["activationRef"])
    && validHex64(value["budgetHash"]) && Number.isSafeInteger(value["expectedGoalVersion"])
    && (value["expectedGoalVersion"] as number) >= 1
    && value["goalDraftNoActiveRevision"] === true && validHex64(value["graphHash"])
    && validHex64(value["policyHash"]) && validHex64(value["qualityHash"])
    && strongTruth(value["truthClass"]);
}

export function validCancellation(value: unknown): value is PlanningCancellationWitness {
  return exact(value, CANCELLATION_KEYS) && validRef(value["authorizationRef"])
    && value["noLiveOrUnknownEffect"] === true && humanApproved(value["truthClass"]);
}

function validFacets(value: unknown): value is PlanningRunFacets {
  return exact(value, FACET_KEYS) && FACET_KEYS.every((key) => typeof value[key] === "boolean");
}

function validLifecycle(value: unknown): value is PlanningRunLifecycle {
  return typeof value === "string"
    && RUNTIME_LIFECYCLES.PLANNING_RUN.some((lifecycle) => lifecycle === value);
}

function optionalHashes(value: unknown): boolean {
  return value === null || validHashes(value);
}

function validFacetPlacement(facets: PlanningRunFacets, lifecycle: PlanningRunLifecycle): boolean {
  const claimable = lifecycle === "PLANNING" || lifecycle === "SUBMISSION_DRAINING";
  return (!facets.owned || claimable) && (!facets.livePlannerEffect || claimable)
    && (!facets.resumable || (lifecycle === "PLANNING" && !facets.owned))
    && (!facets.leaseSuspect || lifecycle === "PLANNING");
}

function validContentPlacement(
  value: Readonly<Record<string, unknown>>,
  lifecycle: PlanningRunLifecycle,
): boolean {
  const sealed = lifecycle === "PLAN_REVIEW" || lifecycle === "APPROVED"
    || lifecycle === "ACTIVATED";
  const blank = lifecycle === "DRAFT" || lifecycle === "READY";
  if (blank) {
    return value["submissionHash"] === null && value["sealedHashes"] === null
      && value["approvedHashes"] === null && value["graphRevisionRef"] === null;
  }
  if (lifecycle === "SUBMISSION_DRAINING" && !validHex64(value["submissionHash"])) return false;
  if (!sealed) return true;
  return validHex64(value["submissionHash"]) && validHashes(value["sealedHashes"])
    && validRef(value["graphRevisionRef"])
    && (lifecycle === "PLAN_REVIEW"
      ? value["approvedHashes"] === null : validHashes(value["approvedHashes"]));
}

export function validPlanningRunState(value: unknown): value is PlanningRunState {
  if (!exact(value, STATE_KEYS) || !validLifecycle(value["lifecycle"])) return false;
  const lifecycle = value["lifecycle"];
  const facets = value["facets"];
  const version = value["version"];
  if (!validFacets(facets) || !validFacetPlacement(facets, lifecycle)) return false;
  const owned = facets.owned;
  return validRef(value["runId"]) && validRef(value["goalRef"]) && validRunKind(value["runKind"])
    && Number.isSafeInteger(version) && (version as number) >= 1
    && (owned ? validRef(value["attemptRef"]) && validRef(value["leaseRef"])
      : value["attemptRef"] === null && value["leaseRef"] === null)
    && (value["submissionHash"] === null || validHex64(value["submissionHash"]))
    && optionalHashes(value["sealedHashes"]) && optionalHashes(value["approvedHashes"])
    && (value["graphRevisionRef"] === null || validRef(value["graphRevisionRef"]))
    && validContentPlacement(value, lifecycle);
}

export function snapshotPlanningRunState(value: unknown): PlanningRunState | undefined {
  const snapshot = snapshotData(value);
  return snapshot.ok && validPlanningRunState(snapshot.value) ? snapshot.value : undefined;
}
