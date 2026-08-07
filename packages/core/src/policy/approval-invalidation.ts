/**
 * Approval lifecycle transitions and selective invalidation (design 7.2, 8 line 360, 263-269).
 *
 * Core VALIDATES AND APPLIES a supplied impact set; it never computes one. Design 265 makes the
 * graph diff the daemon's job, and the diff needs the whole graph, which this pure module does
 * not have. Every hash the impact set carries states a canonicalizer version (design 250); an
 * unrecognised version is refused outright rather than compared optimistically.
 *
 * `INVALIDATED` and `SUPERSEDED` are reached by DIFFERENT evidence and must not be conflated:
 * intersection with the impact set invalidates, while only an explicit successor linkage
 * supersedes. Old approval bytes are never relabelled as approval of the new revision (269), so
 * an already settled approval is returned untouched no matter what the impact set says.
 *
 * Registry note: `APPROVAL` is a valid source for `ILLEGAL_TRANSITION` but NOT for
 * `EXPECTED_VERSION_CONFLICT` or `IDEMPOTENCY_CONFLICT`; raising either from here would degrade
 * silently to `UNKNOWN_ERROR`. `INPUT_INVALID` declares no source and is raised without one.
 */
import { createRuntimeError } from "@moe/contracts";

import type {
  ApprovalCommandKind,
  ApprovalDecisionRecord,
  ApprovalImpactSet,
  ApprovalInvalidationInput,
  ApprovalLifecycle,
  ApprovalResult,
  ApprovalSuccessorLink,
  CarryForwardInput,
  CarryForwardReasonCode,
  CarryForwardVerdict,
} from "./approval-contract.js";
import { validateApprovalCommand, validateApprovalRecord } from "./approval-validation.js";
import { deepFreeze, exact, snapshotData, validHex64, validRef } from "./policy-validation.js";

function inputInvalid<T>(): ApprovalResult<T> {
  return { error: createRuntimeError({ code: "INPUT_INVALID" }), ok: false };
}

function illegalTransition<T>(
  state: ApprovalLifecycle,
  commandKind: ApprovalCommandKind,
): ApprovalResult<T> {
  return {
    error: createRuntimeError({
      code: "ILLEGAL_TRANSITION",
      details: { aggregateKind: "APPROVAL", commandKind, sourceState: state },
      source: { aggregate: "APPROVAL", state },
    }),
    ok: false,
  };
}

/**
 * `PENDING -> DECIDED | WITHDRAWN`. Both targets are terminal for the lifecycle: a decided
 * approval's `decision` is immutable and a withdrawn one has no outgoing edge at all.
 */
export function applyApprovalCommand(
  recordValue: unknown,
  commandValue: unknown,
): ApprovalResult<ApprovalDecisionRecord> {
  const record = validateApprovalRecord(recordValue);
  if (record === undefined) return inputInvalid();
  const command = validateApprovalCommand(commandValue);
  if (command === undefined) return inputInvalid();
  if (record.validity !== "CURRENT") return illegalTransition(record.lifecycle, command.kind);
  if (record.lifecycle !== "PENDING") return illegalTransition(record.lifecycle, command.kind);
  if (command.kind === "approval.withdraw") {
    return { ok: true, value: deepFreeze({ ...record, lifecycle: "WITHDRAWN" as const }) };
  }
  const humanStepUp = record.actorKind === "HUMAN" && validRef(command.stepUpAuthRef);
  const systemStepUp = record.actorKind === "SYSTEM_POLICY" && command.stepUpAuthRef === null;
  if (!humanStepUp && !systemStepUp) return illegalTransition(record.lifecycle, command.kind);
  if (record.riskTier === "R3" && !validRef(command.decisionReason)) {
    return illegalTransition(record.lifecycle, command.kind);
  }
  return {
    ok: true,
    value: deepFreeze({
      ...record,
      decision: command.decision,
      decisionReason: command.decisionReason,
      lifecycle: "DECIDED" as const,
      stepUpAuthRef: command.stepUpAuthRef,
    }),
  };
}

const IMPACT_KEYS = ["canonicalizerVersion", "changedNodeRefs", "changedRevisionHashes"] as const;
const LINK_KEYS = ["predecessorApprovalRef", "successorApprovalRef"] as const;
const INVALIDATION_KEYS = [
  "approvals", "impactSet", "successorLinks", "supportedCanonicalizerVersions",
] as const;

function validImpactSet(value: unknown, supported: readonly string[]): value is ApprovalImpactSet {
  return exact(value, IMPACT_KEYS) && validRef(value["canonicalizerVersion"])
    && supported.includes(value["canonicalizerVersion"] as string)
    && Array.isArray(value["changedNodeRefs"]) && value["changedNodeRefs"].every(validRef)
    && Array.isArray(value["changedRevisionHashes"])
    && value["changedRevisionHashes"].every(validHex64);
}

function validLink(value: unknown): value is ApprovalSuccessorLink {
  return exact(value, LINK_KEYS) && LINK_KEYS.every((key) => validRef(value[key]));
}

function validateInvalidationInput(value: unknown): ApprovalInvalidationInput | undefined {
  const snapshot = snapshotData(value);
  if (!snapshot.ok || !exact(snapshot.value, INVALIDATION_KEYS)) return undefined;
  const input = snapshot.value;
  const supported = input["supportedCanonicalizerVersions"];
  if (!Array.isArray(supported) || supported.length === 0 || !supported.every(validRef)) {
    return undefined;
  }
  if (!validImpactSet(input["impactSet"], supported)) return undefined;
  const links = input["successorLinks"];
  if (!Array.isArray(links) || !links.every(validLink)) return undefined;
  const approvals = input["approvals"];
  if (!Array.isArray(approvals)) return undefined;
  if (approvals.some((entry) => validateApprovalRecord(entry) === undefined)) return undefined;
  return input as unknown as ApprovalInvalidationInput;
}

function nextValidity(
  record: ApprovalDecisionRecord,
  input: ApprovalInvalidationInput,
): ApprovalDecisionRecord["validity"] {
  if (record.validity !== "CURRENT") return record.validity;
  if (input.successorLinks.some((link) => link.predecessorApprovalRef === record.approvalRef)) {
    return "SUPERSEDED";
  }
  const { changedNodeRefs, changedRevisionHashes } = input.impactSet;
  const intersects = changedRevisionHashes.includes(record.exactRevisionHash)
    || record.approvedNodeScope.some((ref) => changedNodeRefs.includes(ref));
  return intersects ? "INVALIDATED" : "CURRENT";
}

/**
 * Applies the impact set. Every returned record is a fresh frozen copy, so the caller's input
 * array is provably unmutated; a non-intersecting approval comes back value-identical.
 */
export function applyApprovalInvalidation(
  value: unknown,
): ApprovalResult<readonly ApprovalDecisionRecord[]> {
  const input = validateInvalidationInput(value);
  if (input === undefined) return inputInvalid();
  const applied = input.approvals.map((record) => ({ ...record, validity: nextValidity(record, input) }));
  return { ok: true, value: deepFreeze(applied) };
}

const CARRY_FORWARD_KEYS = [
  "canonicalizerVersion", "dependenciesPresent", "environmentClosureUnchanged",
  "policySliceUnchanged", "predecessorResultUnchanged", "sourceHash", "targetHash",
] as const;
const BOOLEAN_KEYS = [
  "dependenciesPresent", "environmentClosureUnchanged", "policySliceUnchanged",
  "predecessorResultUnchanged",
] as const;

function validateCarryForwardInput(value: unknown): CarryForwardInput | undefined {
  const snapshot = snapshotData(value);
  if (!snapshot.ok || !exact(snapshot.value, CARRY_FORWARD_KEYS)) return undefined;
  const input = snapshot.value;
  if (!validHex64(input["sourceHash"]) || !validHex64(input["targetHash"])) return undefined;
  if (!validRef(input["canonicalizerVersion"])) return undefined;
  if (!BOOLEAN_KEYS.every((key) => typeof input[key] === "boolean")) return undefined;
  return input as unknown as CarryForwardInput;
}

/**
 * Design 265's six carry-forward invalidation conditions. Every failing condition is reported,
 * not just the first, so an operator sees the whole reason a reuse was refused.
 */
export function evaluateCarryForward(
  value: unknown,
  supportedCanonicalizerVersions: unknown,
): ApprovalResult<CarryForwardVerdict> {
  const input = validateCarryForwardInput(value);
  const supported = snapshotData(supportedCanonicalizerVersions);
  if (input === undefined || !supported.ok) return inputInvalid();
  const versions = supported.value;
  if (!Array.isArray(versions) || versions.length === 0 || !versions.every(validRef)) {
    return inputInvalid();
  }
  const reasonCodes: CarryForwardReasonCode[] = [];
  if (input.sourceHash !== input.targetHash) reasonCodes.push("CARRY_FORWARD_HASH_MISMATCH");
  if (!input.dependenciesPresent) reasonCodes.push("CARRY_FORWARD_DEPENDENCY_MISSING");
  if (!input.policySliceUnchanged) reasonCodes.push("CARRY_FORWARD_POLICY_SLICE_CHANGED");
  if (!input.predecessorResultUnchanged) {
    reasonCodes.push("CARRY_FORWARD_PREDECESSOR_RESULT_CHANGED");
  }
  if (!input.environmentClosureUnchanged) reasonCodes.push("CARRY_FORWARD_ENVIRONMENT_CHANGED");
  if (!versions.includes(input.canonicalizerVersion)) {
    reasonCodes.push("CARRY_FORWARD_CANONICALIZATION_UNKNOWN");
  }
  return { ok: true, value: deepFreeze({ reasonCodes, valid: reasonCodes.length === 0 }) };
}
