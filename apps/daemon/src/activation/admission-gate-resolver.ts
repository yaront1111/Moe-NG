/**
 * THE DURABLE ADMISSION GATE of the authenticated `effect.activate` route.
 *
 * WHAT MOVED, and it is the LAST caller-supplied budget input on this route. Until this module
 * existed the stage read `payload.budget.gate` and checked exactly one thing about it — that the
 * witness field the node's own durable policy names was PRESENT (`checkGateWitness`, retired in
 * the same commit as this file). Presence is not authenticity: a caller could assert
 * `{allowance: {decisionRef: "anything", outcome: "ALLOW"}}` and no durable record was ever
 * consulted. Here the witness is BUILT FROM durable records, so the forgery is unrepresentable
 * rather than merely refused, and `payload.budget.gate` is not read on this route at all.
 *
 * THE TWO SOURCES, keyed by the node's own `admissionGatePolicy`
 * (`node-authority-contract.ts:54` promised exactly this resolution and nothing performed it):
 *   POLICY_ALLOWANCE -> the LATEST `PolicyEvaluated` on `policyAggregateId(projectId)`, whose
 *     payload is `{decision, policyRef}` (`bootstrap-policy-services.ts:84-88`). That aggregate
 *     is PROJECT-scoped and carries no admission or node binding, because `policy.validate` IS
 *     the policy decision and `AdmissionPolicyAllowance` has no field to bind one to. The
 *     project-scoped reading is therefore the contract's own shape, recorded at plan time and
 *     flagged for governor ratification rather than smuggled in.
 *   HUMAN_APPROVAL -> the goal's single `GoalExecutionEnabled`, `eventPayload.approval`
 *     (`approval-activation.ts:72-82`), which is a full core-validated approval record whose
 *     `approvalRef` / `decision` / `validity` map one-for-one onto `AdmissionHumanApproval`.
 *
 * THE BOUNDARY THIS MODULE DOES NOT CROSS (task rail 1). It answers WHICH durable record
 * witnesses this node. Whether that witness ALLOWS is `checkGate`'s call in `@moe/scheduler`
 * (`budget-reservation.ts:151-157`) and a second opinion here could disagree with it. So the
 * approval's `decision` and `validity` are forwarded VERBATIM and are deliberately NOT filtered
 * the way `readApprovedNodeScope` filters them: filtering would make
 * `BUDGET_RESERVATION_APPROVAL_NOT_CURRENT` unreachable and would be this module deciding
 * admission. It filters only on RESOLUTION questions — which event, and whether the approval
 * names this node.
 *
 * THE VOCABULARIES ARE PROVEN BY THE COMPILER, not mirrored. `POLICY_OUTCOMES` (`@moe/core`,
 * the vocabulary the WRITER emits) narrows the decision, and `RUNTIME_LIFECYCLES.APPROVAL_*`
 * (`@moe/contracts`) narrow the approval's two enums. Each narrowed value is then ASSIGNED into
 * the scheduler's own field type, so `tsc` proves the mapping and a drift in either list reddens
 * the typecheck instead of silently resolving a witness the producer would refuse. That is why
 * no list is restated here; `budget-reservation.ts:40-42` has to mirror by value only because
 * the scheduler cannot depend on `@moe/contracts`.
 *
 * SEQUENCING: this module lands before task-b8b69e74 (fence link 4), after which `payload.budget`
 * does not exist at all and this resolver is the ONLY source of an `AdmissionGate` on the route.
 */

import { RUNTIME_LIFECYCLES, decodeBoundedJsonBytes } from "@moe/contracts";
import { POLICY_OUTCOMES } from "@moe/core";

import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";

import type { JsonObject, JsonValue } from "@moe/contracts";
import type { AdmissionGate, AdmissionHumanApproval } from "@moe/scheduler";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

/**
 * This module's OWN faults, and only two.
 *
 * ABSENT covers absent, ambiguous and unreadable alike — `readApprovedNodeScope`'s own
 * documented rule, and for the same reason: each is a state in which the durable witness is
 * UNKNOWN, and an unknown witness confers nothing. A third `UNREADABLE` member would be a dead
 * arm, because no production writer can commit a record that decodes to the wrong shape.
 *
 * SCOPE_MISMATCH stays SEPARATE from ABSENT: an approval that exists but names other nodes is
 * the opposite durable state from no approval at all, and collapsing them would let one approval
 * admit every node in the goal — the forged-witness class this module closes.
 */
export const ADMISSION_GATE_RESOLVER_CODES = Object.freeze([
  "ADMISSION_GATE_SCOPE_MISMATCH",
  "ADMISSION_GATE_WITNESS_ABSENT",
] as const);

export type AdmissionGateResolverCode = (typeof ADMISSION_GATE_RESOLVER_CODES)[number];

/**
 * MODULE-PRIVATE on purpose. The layer travels on every refusal this module returns, so no
 * caller needs the constant, and a runtime export named `*_LAYER` at column 0 is the
 * boundary-roster surface this repo keeps closed.
 */
const ADMISSION_GATE_LAYER = "DAEMON_ADMISSION_GATE";

export interface AdmissionGateResolverInput {
  /** The goal whose single `GoalExecutionEnabled` carries the human approval record. */
  readonly goalRef: string;
  /** The node the activation admits, checked against the approval's `approvedNodeScope`. */
  readonly nodeKey: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
  /** The node's OWN durable policy, already mapped to its witness field by the derivation. */
  readonly witnessField: keyof AdmissionGate;
}

export interface AdmissionGateRefused {
  readonly code: AdmissionGateResolverCode;
  readonly layer: typeof ADMISSION_GATE_LAYER;
  readonly ok: false;
}

export type ResolveAdmissionGateResult =
  | { readonly gate: AdmissionGate; readonly ok: true }
  | AdmissionGateRefused;

const refuse = (code: AdmissionGateResolverCode): AdmissionGateRefused =>
  Object.freeze({ code, layer: ADMISSION_GATE_LAYER, ok: false as const });

const objectValue = (value: JsonValue | undefined): JsonObject | null =>
  value === null || value === undefined || typeof value !== "object" || Array.isArray(value)
    ? null
    : value as JsonObject;

const nonEmptyRef = (value: JsonValue | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

const oneOf = <T extends string>(
  value: JsonValue | undefined, values: readonly T[],
): value is T => typeof value === "string" && (values as readonly string[]).includes(value);

/** The event's payload as an object, or null. An undecodable record witnesses nothing. */
function payloadOf(event: StoredEvent): JsonObject | null {
  const decoded = decodeBoundedJsonBytes(event.payload);
  return decoded.ok ? objectValue(decoded.value) : null;
}

/**
 * Events selected BY TYPE, never by index.
 *
 * Both aggregates read here carry more than one event type — the policy stream also holds
 * `PolicyInstalled`, and the goal stream holds the goal's own lifecycle events — so an
 * index-based pick would silently resolve the wrong record the moment a sibling type lands.
 */
function eventsOfType(
  store: SqliteEventStore, aggregateId: string, eventType: string,
): readonly StoredEvent[] {
  try {
    return store.readEvents(aggregateId).filter((event) =>
      event.aggregateId === aggregateId && event.eventType === eventType);
  } catch {
    return [];
  }
}

/**
 * The policy allowance, from the LATEST `PolicyEvaluated`.
 *
 * LATEST rather than exactly-one, and that is the durable truth rather than a convenience: the
 * policy aggregate is append-only and a project may validate its policy repeatedly, so the
 * newest decision is the one standing. An exactly-one rule would refuse every project that
 * re-evaluated, and a first-match rule would admit on a decision the project has superseded.
 */
function resolveAllowance(
  store: SqliteEventStore, projectId: string,
): ResolveAdmissionGateResult {
  const events = eventsOfType(store, policyAggregateId(projectId), "PolicyEvaluated");
  const latest = events[events.length - 1];
  if (latest === undefined) return refuse("ADMISSION_GATE_WITNESS_ABSENT");
  const payload = payloadOf(latest);
  if (payload === null) return refuse("ADMISSION_GATE_WITNESS_ABSENT");
  const decisionRef = payload["policyRef"];
  const outcome = payload["decision"];
  // Narrowed against the WRITER's vocabulary; the assignment below is what proves it is also
  // the scheduler's. A decision outside it means the record is not a policy decision at all.
  if (!nonEmptyRef(decisionRef) || !oneOf(outcome, POLICY_OUTCOMES)) {
    return refuse("ADMISSION_GATE_WITNESS_ABSENT");
  }
  return Object.freeze({
    gate: Object.freeze({
      allowance: Object.freeze({ decisionRef, outcome }),
      // A POLICY_ALLOWANCE node builds NO human approval, even on a goal that holds one: the
      // witness kind is decided by the node's durable policy, never by what happens to exist.
      approval: null,
    }),
    ok: true as const,
  });
}

/** The approval record's three admission fields, or null when the event does not carry one. */
function admissionApproval(approval: JsonObject): AdmissionHumanApproval | null {
  const approvalRef = approval["approvalRef"];
  const decision = approval["decision"];
  const validity = approval["validity"];
  if (!nonEmptyRef(approvalRef)
    || !oneOf(decision, RUNTIME_LIFECYCLES.APPROVAL_DECISION)
    || !oneOf(validity, RUNTIME_LIFECYCLES.APPROVAL_VALIDITY)) return null;
  // Forwarded VERBATIM: whether APPROVE/CURRENT admits is `checkGate`'s question, not this one.
  return Object.freeze({ approvalRef, decision, validity });
}

/**
 * The human approval, from the goal's EXACTLY-ONE `GoalExecutionEnabled`.
 *
 * Exactly-one rather than latest, mirroring `readApprovedNodeScope`
 * (`goal-close-prerequisite.ts:85-97`): a goal's execution is enabled once, so two such events
 * are a durable ambiguity about WHICH approval governs, and an ambiguous witness is unknown.
 */
function resolveApproval(
  store: SqliteEventStore, goalRef: string, nodeKey: string,
): ResolveAdmissionGateResult {
  const events = eventsOfType(store, goalRef, "GoalExecutionEnabled");
  if (events.length !== 1) return refuse("ADMISSION_GATE_WITNESS_ABSENT");
  const payload = payloadOf(events[0] as StoredEvent);
  // Read BY KEY, never by an exact-key fence over the whole payload: sibling rows add their own
  // keys to this event and a whole-payload fence would refuse a record it should read.
  const approval = payload === null ? null : objectValue(payload["approval"]);
  if (approval === null) return refuse("ADMISSION_GATE_WITNESS_ABSENT");
  const witness = admissionApproval(approval);
  if (witness === null) return refuse("ADMISSION_GATE_WITNESS_ABSENT");
  const scope = approval["approvedNodeScope"];
  if (!Array.isArray(scope) || !scope.every(nonEmptyRef)) {
    return refuse("ADMISSION_GATE_WITNESS_ABSENT");
  }
  // A RESOLUTION question — which durable record applies to THIS node — not gate arithmetic.
  if (!scope.includes(nodeKey)) return refuse("ADMISSION_GATE_SCOPE_MISMATCH");
  return Object.freeze({
    gate: Object.freeze({ allowance: null, approval: witness }),
    ok: true as const,
  });
}

/**
 * The `AdmissionGate` this node's durable policy owes, or this module's own refusal.
 *
 * NOTHING HERE READS REQUEST BYTES. The input carries no payload and no request, so the caller's
 * gate is not merely ignored — it is unreachable from this module by construction.
 */
export function resolveAdmissionGate(
  input: AdmissionGateResolverInput,
): ResolveAdmissionGateResult {
  const { goalRef, nodeKey, projectId, store, witnessField } = input;
  return witnessField === "allowance"
    ? resolveAllowance(store, projectId)
    : resolveApproval(store, goalRef, nodeKey);
}
