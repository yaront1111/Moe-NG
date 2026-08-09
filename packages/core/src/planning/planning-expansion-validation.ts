/** Fail-closed inspection for PlanningRun EXPANSION contracts.
 *
 * This leaf preserves the full legacy validator at its 250-line cap and composes its production
 * predicates instead of restating them. Expansion-local bounds do not change INITIAL behavior.
 * Shape validity grants no hold, approval, activation, authority, or transition.
 * Consumer: task-93b0314e09f248118e21f92699989468.
 */
import type {
  PlanningExpansionHoldBinding,
  PlanningExpansionProposalIdentity,
} from "./planning-command-contract.js";
import type { PlanningRunContractState } from "./planning-event-contract.js";
import {
  deepFreeze,
  exact,
  snapshotData,
  validExpectedVersion,
  validHex64,
  validRef,
} from "./planning-snapshot.js";
import {
  validEffectTerminal,
  validPlanningRunState,
  validSubmission,
} from "./planning-validation.js";

export const PLANNING_EXPANSION_TARGETS = Object.freeze([
  "HOLD_BINDING", "PROPOSAL_IDENTITY", "CREATE_COMMAND", "PROPOSE_COMMAND", "CREATED_EVENT",
  "SEALED_EVENT", "CONTRACT_STATE",
] as const);

export const PLANNING_EXPANSION_ERROR_CODES = Object.freeze([
  "PLANNING_EXPANSION_HOLD_BINDING_INVALID", "PLANNING_EXPANSION_PROPOSAL_IDENTITY_INVALID",
  "PLANNING_EXPANSION_CREATE_COMMAND_INVALID", "PLANNING_EXPANSION_PROPOSE_COMMAND_INVALID",
  "PLANNING_EXPANSION_CREATED_EVENT_INVALID", "PLANNING_EXPANSION_SEALED_EVENT_INVALID",
  "PLANNING_EXPANSION_CONTRACT_STATE_INVALID", "PLANNING_EXPANSION_TARGET_INVALID",
] as const);

/** Which layer refused, so a cross-kind carrier is never confused with a malformed member. */
export const PLANNING_EXPANSION_LAYERS = Object.freeze([
  "BINDING", "IDENTITY", "COMMAND", "EVENT", "STATE", "TARGET",
] as const);

export type PlanningExpansionTarget = (typeof PLANNING_EXPANSION_TARGETS)[number];
export type PlanningExpansionErrorCode = (typeof PLANNING_EXPANSION_ERROR_CODES)[number];
export type PlanningExpansionLayer = (typeof PLANNING_EXPANSION_LAYERS)[number];

export type PlanningExpansionInspection =
  | { readonly ok: true; readonly target: PlanningExpansionTarget; readonly value: unknown }
  | { readonly code: PlanningExpansionErrorCode; readonly layer: PlanningExpansionLayer;
    readonly ok: false; readonly target: string };

/** Expansion-local bound. Legacy `validRef` stays unbounded so INITIAL behaviour is unchanged. */
const MAX_EXPANSION_REF = 256;

const HANDOFF_KEYS = ["digest", "ref"] as const;
const HOLD_KEYS = [
  "generation", "goalVersion", "graphEpoch", "holdId", "lifecycle", "parentNodeRef",
  "parentRunRef", "proposalBaseHash", "sourceFingerprint", "truthClass", "workerHandoff",
] as const;
const IDENTITY_KEYS = ["proposalHash", "proposalRef", "truthClass"] as const;
const CREATE_KEYS = [
  "commandId", "expansion", "expectedVersion", "goalRef", "kind", "runId", "runKind",
] as const;
const PROPOSE_KEYS = [
  "commandId", "expansion", "expectedVersion", "kind", "proposalKind", "sealedProposal",
  "submissionHash", "witness",
] as const;
const PROPOSE_PROOF_KEYS = [...PROPOSE_KEYS, "effectTerminalProof"] as const;
const CREATED_KEYS = [
  "commandId", "expansion", "goalRef", "kind", "runId", "runKind", "version",
] as const;
const SEALED_KEYS = [
  "commandId", "draining", "expansion", "kind", "proposalKind", "sealedProposal",
  "submissionHash", "version",
] as const;
const BASE_STATE_KEYS = [
  "approvedHashes", "attemptRef", "facets", "goalRef", "graphRevisionRef", "leaseRef",
  "lifecycle", "runId", "runKind", "sealedHashes", "submissionHash", "version",
] as const;
const STATE_KEYS = [...BASE_STATE_KEYS, "expansion", "sealedProposal"] as const;

function boundedRef(value: unknown): value is string {
  return validRef(value) && value.length <= MAX_EXPANSION_REF;
}

function positiveSafe(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function validHandoff(value: unknown): boolean {
  return exact(value, HANDOFF_KEYS) && validHex64(value["digest"]) && boundedRef(value["ref"]);
}

export function validExpansionHoldBinding(value: unknown): value is PlanningExpansionHoldBinding {
  return exact(value, HOLD_KEYS) && positiveSafe(value["generation"])
    && positiveSafe(value["goalVersion"]) && validExpectedVersion(value["graphEpoch"])
    && boundedRef(value["holdId"]) && value["lifecycle"] === "ACTIVE"
    && boundedRef(value["parentNodeRef"]) && boundedRef(value["parentRunRef"])
    && validHex64(value["proposalBaseHash"]) && validHex64(value["sourceFingerprint"])
    && value["truthClass"] === "DAEMON_VERIFIED" && validHandoff(value["workerHandoff"]);
}

export function validExpansionProposalIdentity(
  value: unknown,
): value is PlanningExpansionProposalIdentity {
  return exact(value, IDENTITY_KEYS) && validHex64(value["proposalHash"])
    && boundedRef(value["proposalRef"]) && value["truthClass"] === "DAEMON_VERIFIED";
}

export function validExpansionCreateCommand(value: unknown): boolean {
  return exact(value, CREATE_KEYS) && boundedRef(value["commandId"])
    && value["expectedVersion"] === 0 && boundedRef(value["goalRef"])
    && value["kind"] === "planning.create_draft" && boundedRef(value["runId"])
    && value["runKind"] === "EXPANSION" && validExpansionHoldBinding(value["expansion"]);
}

/** The effect-terminal proof stays optional exactly as the committed command type declares it. */
function proposeShape(value: unknown): value is Readonly<Record<string, unknown>> {
  return exact(value, PROPOSE_KEYS)
    || (exact(value, PROPOSE_PROOF_KEYS) && validEffectTerminal(value["effectTerminalProof"]));
}

export function validExpansionProposeCommand(value: unknown): boolean {
  if (!proposeShape(value)) return false;
  const sealed = value["sealedProposal"];
  const witness = value["witness"];
  return boundedRef(value["commandId"]) && validExpectedVersion(value["expectedVersion"])
    && value["kind"] === "plan.propose" && value["proposalKind"] === "EXPANSION"
    && validHex64(value["submissionHash"]) && validSubmission(witness)
    && validExpansionHoldBinding(value["expansion"]) && validExpansionProposalIdentity(sealed)
    && sealed.proposalHash === value["submissionHash"]
    && sealed.proposalRef === witness.submissionRef;
}

export function validExpansionCreatedEvent(value: unknown): boolean {
  return exact(value, CREATED_KEYS) && boundedRef(value["commandId"])
    && boundedRef(value["goalRef"]) && value["kind"] === "PlanningRunCreated"
    && boundedRef(value["runId"]) && value["runKind"] === "EXPANSION"
    && positiveSafe(value["version"]) && validExpansionHoldBinding(value["expansion"]);
}

export function validExpansionSealedEvent(value: unknown): boolean {
  if (!exact(value, SEALED_KEYS)) return false;
  const sealed = value["sealedProposal"];
  return boundedRef(value["commandId"]) && typeof value["draining"] === "boolean"
    && value["kind"] === "PlanningSubmissionSealed" && value["proposalKind"] === "EXPANSION"
    && validHex64(value["submissionHash"]) && positiveSafe(value["version"])
    && validExpansionHoldBinding(value["expansion"]) && validExpansionProposalIdentity(sealed)
    && sealed.proposalHash === value["submissionHash"];
}

/** The unchanged 12 common keys, handed to the legacy predicate rather than re-judged here. */
function baseProjection(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const key of BASE_STATE_KEYS) base[key] = record[key];
  return base;
}

/** Identity is sealed exactly when a submission hash exists, and binds to that same hash. */
function sealedPlacement(record: Readonly<Record<string, unknown>>): boolean {
  const sealed = record["sealedProposal"];
  const submission = record["submissionHash"];
  if (submission === null) return sealed === null;
  return validExpansionProposalIdentity(sealed) && sealed.proposalHash === submission;
}

export function validExpansionContractState(value: unknown): boolean {
  return exact(value, STATE_KEYS) && value["runKind"] === "EXPANSION"
    && validPlanningRunState(baseProjection(value))
    && validExpansionHoldBinding(value["expansion"]) && sealedPlacement(value);
}

/** INITIAL and REVISION keep exactly their unchanged 12-key legacy shape, bytes included. */
export function validPlanningRunContractState(
  value: unknown,
): value is PlanningRunContractState {
  return validExpansionContractState(value)
    || (validPlanningRunState(value) && value.runKind !== "EXPANSION");
}

/** Rebuild null-prototype snapshots as ordinary detached contract records. */
function plainClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainClone);
  if (value === null || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) copy[key] = plainClone(nested);
  return copy;
}

/** Detached and deeply frozen on acceptance; refused outright otherwise, never repaired. */
export function snapshotPlanningRunContractState(
  value: unknown,
): PlanningRunContractState | undefined {
  const snapshot = snapshotData(value);
  if (!snapshot.ok || !validPlanningRunContractState(snapshot.value)) return undefined;
  return deepFreeze(plainClone(snapshot.value) as PlanningRunContractState);
}

interface TargetSpec {
  readonly code: PlanningExpansionErrorCode;
  readonly layer: PlanningExpansionLayer;
  readonly valid: (value: unknown) => boolean;
}

const SPECS: Readonly<Record<PlanningExpansionTarget, TargetSpec>> = Object.freeze({
  CONTRACT_STATE: { code: "PLANNING_EXPANSION_CONTRACT_STATE_INVALID", layer: "STATE",
    valid: validExpansionContractState },
  CREATED_EVENT: { code: "PLANNING_EXPANSION_CREATED_EVENT_INVALID", layer: "EVENT",
    valid: validExpansionCreatedEvent },
  CREATE_COMMAND: { code: "PLANNING_EXPANSION_CREATE_COMMAND_INVALID", layer: "COMMAND",
    valid: validExpansionCreateCommand },
  HOLD_BINDING: { code: "PLANNING_EXPANSION_HOLD_BINDING_INVALID", layer: "BINDING",
    valid: validExpansionHoldBinding },
  PROPOSAL_IDENTITY: { code: "PLANNING_EXPANSION_PROPOSAL_IDENTITY_INVALID", layer: "IDENTITY",
    valid: validExpansionProposalIdentity },
  PROPOSE_COMMAND: { code: "PLANNING_EXPANSION_PROPOSE_COMMAND_INVALID", layer: "COMMAND",
    valid: validExpansionProposeCommand },
  SEALED_EVENT: { code: "PLANNING_EXPANSION_SEALED_EVENT_INVALID", layer: "EVENT",
    valid: validExpansionSealedEvent },
});

/** Snapshot once, then return only frozen evidence or the selected predicate's stable refusal. */
export function inspectPlanningExpansionContract(
  target: PlanningExpansionTarget,
  value: unknown,
): PlanningExpansionInspection {
  if (typeof target !== "string") {
    return Object.freeze({ code: "PLANNING_EXPANSION_TARGET_INVALID", layer: "TARGET",
      ok: false as const, target: "<invalid-target>" });
  }
  const spec = Object.prototype.hasOwnProperty.call(SPECS, target)
    ? SPECS[target] as TargetSpec : undefined;
  if (spec === undefined) {
    return Object.freeze({ code: "PLANNING_EXPANSION_TARGET_INVALID", layer: "TARGET",
      ok: false as const, target: String(target) });
  }
  const snapshot = snapshotData(value);
  return snapshot.ok && spec.valid(snapshot.value)
    ? Object.freeze({ ok: true as const, target,
      value: deepFreeze(plainClone(snapshot.value)) })
    : Object.freeze({ code: spec.code, layer: spec.layer, ok: false as const, target });
}
