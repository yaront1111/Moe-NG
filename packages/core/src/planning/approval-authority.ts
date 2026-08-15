/**
 * The human authority gate: work that cannot proceed without a named human,
 * whatever the approval policy says.
 *
 * IT BINDS TO THE UNIT OF WORK, NOT TO A STATUS, AND THAT IS THE WHOLE POINT.
 * The next reader will be tempted to model this as another lifecycle field —
 * do not. On 2026-08-15 every BLOCKED task on the orchestrating board was
 * promoted to PLANNING inside a two-minute window, and that transition CLEARED
 * each task's recorded `blockedReason`. Two of those tasks named an explicit
 * human authority gate as a hard dependency (a GA activation record requiring
 * GO_ACTIVATE, a legacy quiesce drill requiring GO_QUIESCE); neither GO had ever
 * been issued. A gate stored like a status would have been cleared by that same
 * bulk update. A gate carried on the work's own durable identity, and re-checked
 * against that identity on every read, would not have been.
 *
 * A STORED GRANT IS NEVER TRUSTED. `checkHumanAuthority` re-validates the
 * principal, the moment and the binding every time. An agent that can write the
 * record therefore gains nothing by writing one: it cannot name itself a human,
 * and it cannot move a human's grant from the work it was given for onto work it
 * was not.
 *
 * Refusals carry a stable code from a closed frozen vocabulary AND name the
 * layer that answered. The planning aggregate's existing `illegal(state, kind)`
 * is a generic refusal carrying only the command kind, which is why this module
 * publishes its own vocabulary rather than reusing it.
 */
import type { PrincipalKind } from "../identity/identity-session.js";

/**
 * One closed vocabulary for the whole approval decision, gate and policy alike:
 * a consumer receives one refusal and needs one registry to interpret it. The
 * `layer` says which of the two answered.
 */
export const APPROVAL_AUTHORITY_CODES = Object.freeze([
  "APPROVAL_HUMAN_AUTHORITY_REQUIRED",
  "APPROVAL_AUTHORITY_BINDING_MISMATCH",
  "APPROVAL_PRINCIPAL_MISSING",
  "APPROVAL_PRINCIPAL_UNNAMED",
  "APPROVAL_PRINCIPAL_NOT_HUMAN",
  "APPROVAL_GRANT_MOMENT_INVALID",
  "APPROVAL_POLICY_DELAY_INVALID",
  "APPROVAL_HUMAN_REVIEW_REQUIRED",
] as const);
export type ApprovalAuthorityCode = (typeof APPROVAL_AUTHORITY_CODES)[number];

export const APPROVAL_AUTHORITY_LAYERS = Object.freeze([
  "HUMAN_AUTHORITY_GATE",
  "APPROVAL_POLICY",
] as const);
export type ApprovalAuthorityLayer = (typeof APPROVAL_AUTHORITY_LAYERS)[number];

export interface ApprovalAuthorityRefusal {
  readonly ok: false;
  readonly code: ApprovalAuthorityCode;
  readonly layer: ApprovalAuthorityLayer;
}

export function refuseApprovalAuthority(
  code: ApprovalAuthorityCode,
  layer: ApprovalAuthorityLayer,
): ApprovalAuthorityRefusal {
  return Object.freeze({ code, layer, ok: false as const });
}

/**
 * The durable record of a satisfied gate. It names WHO gave the authority and
 * WHEN, and it re-states the gate and the work it was given for, so it cannot be
 * read as authority over anything else.
 */
export interface HumanAuthorityGrant {
  readonly gateId: string;
  readonly workRef: string;
  readonly principalId: string;
  readonly principalKind: PrincipalKind;
  readonly grantedAtEpochMs: number;
}

/** Attached to the unit of work. `grant: null` is an unsatisfied gate. */
export interface HumanAuthorityGate {
  readonly gateId: string;
  readonly workRef: string;
  readonly grant: HumanAuthorityGrant | null;
}

export type HumanAuthorityCheck =
  | { readonly ok: true; readonly grant: HumanAuthorityGrant }
  | ApprovalAuthorityRefusal;

export type HumanAuthorityGrantResult =
  | { readonly ok: true; readonly gate: HumanAuthorityGate }
  | ApprovalAuthorityRefusal;

type NamedHumanResult =
  | { readonly ok: true; readonly principalId: string }
  | ApprovalAuthorityRefusal;

const GATE_LAYER = "HUMAN_AUTHORITY_GATE";

/**
 * A NAMED HUMAN, checked in a fixed order so both entry points below refuse an
 * identical defect with an identical code. `unknown` because the daemon, the
 * control room and the orchestrator each hand this a value off the wire.
 */
function namedHuman(principal: unknown): NamedHumanResult {
  if (typeof principal !== "object" || principal === null) {
    return refuseApprovalAuthority("APPROVAL_PRINCIPAL_MISSING", GATE_LAYER);
  }
  const presented = principal as { readonly kind?: unknown; readonly principalId?: unknown };
  const identifier = presented.principalId;
  const principalId = typeof identifier === "string" ? identifier.trim() : "";
  if (principalId.length === 0) {
    return refuseApprovalAuthority("APPROVAL_PRINCIPAL_UNNAMED", GATE_LAYER);
  }
  if (presented.kind !== "HUMAN") {
    return refuseApprovalAuthority("APPROVAL_PRINCIPAL_NOT_HUMAN", GATE_LAYER);
  }
  return { ok: true as const, principalId };
}

/** A moment, not a duration: a safe non-negative integer epoch in milliseconds. */
function validMoment(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A reference has to NAME something before comparing it means anything. Without
 * this, the cheapest forgery available to an agent that can write the record is
 * to name nothing on both sides: `undefined === undefined` compares equal, so a
 * grant bound to no work at all would read as bound to THIS work.
 */
function namedRef(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function boundToWork(gate: HumanAuthorityGate, grant: HumanAuthorityGrant): boolean {
  return namedRef(gate.gateId) && namedRef(gate.workRef)
    && grant.gateId === gate.gateId && grant.workRef === gate.workRef;
}

/**
 * Mints the durable grant that satisfies one gate. The presented gate is read,
 * never mutated: the caller receives a new gate carrying the new grant and
 * decides how to persist it.
 */
export function grantHumanAuthority(
  gate: HumanAuthorityGate,
  principal: unknown,
  grantedAtEpochMs: unknown,
): HumanAuthorityGrantResult {
  const named = namedHuman(principal);
  if (!named.ok) return named;
  if (!validMoment(grantedAtEpochMs)) {
    return refuseApprovalAuthority("APPROVAL_GRANT_MOMENT_INVALID", GATE_LAYER);
  }
  if (!namedRef(gate.gateId) || !namedRef(gate.workRef)) {
    return refuseApprovalAuthority("APPROVAL_AUTHORITY_BINDING_MISMATCH", GATE_LAYER);
  }
  const grant = Object.freeze({
    gateId: gate.gateId, grantedAtEpochMs, principalId: named.principalId,
    principalKind: "HUMAN" as const, workRef: gate.workRef,
  });
  const granted = Object.freeze({ gateId: gate.gateId, grant, workRef: gate.workRef });
  return Object.freeze({ gate: granted, ok: true as const });
}

/**
 * Re-derives the gate's verdict from the stored grant on every read. The binding
 * check is what stops a real human grant from being carried onto work it was
 * never given for.
 */
export function checkHumanAuthority(gate: HumanAuthorityGate): HumanAuthorityCheck {
  const grant = gate.grant;
  if (grant === null || grant === undefined) {
    return refuseApprovalAuthority("APPROVAL_HUMAN_AUTHORITY_REQUIRED", GATE_LAYER);
  }
  const named = namedHuman({ kind: grant.principalKind, principalId: grant.principalId });
  if (!named.ok) return named;
  if (!validMoment(grant.grantedAtEpochMs)) {
    return refuseApprovalAuthority("APPROVAL_GRANT_MOMENT_INVALID", GATE_LAYER);
  }
  if (!boundToWork(gate, grant)) {
    return refuseApprovalAuthority("APPROVAL_AUTHORITY_BINDING_MISMATCH", GATE_LAYER);
  }
  return Object.freeze({ grant, ok: true as const });
}
