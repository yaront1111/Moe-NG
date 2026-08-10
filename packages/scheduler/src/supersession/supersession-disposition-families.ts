/**
 * The attempt, effect and budget family producers, plus the producer table the
 * orchestrator iterates. The resource family lives in
 * `./supersession-resource-disposition.ts` so neither source passes the epic's
 * 250-line bar.
 *
 * Each producer returns EITHER a complete disposition for its kind OR a refusal
 * naming an existing `@moe/contracts` code and the refusing layer. There is no
 * third arm: a fact that cannot be classified is UNKNOWN and refuses, and it is
 * never upgraded into a safe carry.
 *
 * The attempt vocabulary is `RUNTIME_LIFECYCLES.ATTEMPT` from `@moe/contracts`
 * and no state is added to it. Budget runs through `activateReservation` /
 * `cancelReservation` and reports `SETTLEMENT_STATES` rather than re-deciding
 * settlement; neither authority is reimplemented here.
 */
import { RUNTIME_LIFECYCLES } from "@moe/contracts";

import { exactRecord, oneOf } from "../authority/authority-kernel.js";
import {
  activateReservation, cancelReservation,
  type BudgetAvailableView, type ReservationRecord,
} from "../budget/budget-reservation.js";
import { SETTLEMENT_STATES } from "../budget/budget-settlement.js";
import {
  classOfKind, disposeFamily, refuseFamily,
  type FamilyOutcome, type SupersessionDispositionFamily, type SupersessionKindClass,
  type SupersessionNodeFacts,
} from "./supersession-disposition-contract.js";
import { resourceDisposition } from "./supersession-resource-disposition.js";

const ATTEMPT_LIFECYCLES = RUNTIME_LIFECYCLES.ATTEMPT;
const BUDGET_KEYS = [
  "expectedVersion", "neverStartedProofRef", "reservation", "settlementState",
  "successorAttemptRef", "view",
] as const;

export function attemptDisposition(node: SupersessionNodeFacts): FamilyOutcome {
  const klass = classOfKind(node.kind);
  if (klass === null) return refuseFamily("PLANNING_DISPOSITION_UNKNOWN", "ATTEMPT");
  const lifecycle = node.attemptLifecycle;
  if (!oneOf(lifecycle, ATTEMPT_LIFECYCLES)) return refuseFamily("INPUT_INVALID", "ATTEMPT");
  if (lifecycle === "UNKNOWN") return refuseFamily("PLANNING_DISPOSITION_UNKNOWN", "ATTEMPT");
  if (klass === "ADD") {
    return lifecycle === "CREATED" ? disposeFamily(node, "ATTEMPT", "ATTEMPT_ABSENT", klass)
      : refuseFamily("SUPERSESSION_CONSEQUENCE_CHANGED", "ATTEMPT");
  }
  if (klass === "CARRY") {
    return lifecycle === "SUCCEEDED" ? disposeFamily(node, "ATTEMPT", "ATTEMPT_CARRIED", klass)
      : refuseFamily("SUPERSESSION_CONSEQUENCE_CHANGED", "ATTEMPT");
  }
  return disposeFamily(node, "ATTEMPT",
    klass === "REMOVE" ? "ATTEMPT_CANCELLED" : "ATTEMPT_SUPERSEDED", klass);
}

export function effectDisposition(node: SupersessionNodeFacts): FamilyOutcome {
  const klass = classOfKind(node.kind);
  if (klass === null) return refuseFamily("PLANNING_DISPOSITION_UNKNOWN", "EFFECT");
  if (typeof node.effectsTerminal !== "boolean") {
    return refuseFamily("PLANNING_DISPOSITION_UNKNOWN", "EFFECT");
  }
  if (klass === "ADD") return disposeFamily(node, "EFFECT", "EFFECT_ABSENT", klass);
  // An effect still in flight cannot be carried, replayed or quarantined safely.
  if (!node.effectsTerminal) return refuseFamily("SUPERSESSION_CONSEQUENCE_CHANGED", "EFFECT");
  const outcome = klass === "CARRY" ? "EFFECT_CARRIED"
    : klass === "REMOVE" ? "EFFECT_QUARANTINED" : "EFFECT_REPLAYED";
  return disposeFamily(node, "EFFECT", outcome, klass);
}

/**
 * Settlement authority belongs to `budget-settlement`, so a predecessor that
 * already settled is REPORTED here, never re-decided. `null` means "not settled"
 * and hands the node to the reservation path; QUARANTINED is an unmeasured
 * liability and refuses rather than being discarded by a supersession.
 */
function settlementOutcome(
  node: SupersessionNodeFacts,
  state: unknown,
  klass: SupersessionKindClass,
): FamilyOutcome | null {
  if (state === null) return null;
  if (!oneOf(state, SETTLEMENT_STATES)) return refuseFamily("INPUT_INVALID", "BUDGET");
  if (klass !== "REMOVE") return refuseFamily("SUPERSESSION_CONSEQUENCE_CHANGED", "BUDGET");
  if (state === "QUARANTINED") return refuseFamily("PLANNING_DISPOSITION_UNKNOWN", "BUDGET");
  return disposeFamily(node, "BUDGET", `BUDGET_${state}`, klass);
}

export function budgetDisposition(node: SupersessionNodeFacts): FamilyOutcome {
  const klass = classOfKind(node.kind);
  if (klass === null) return refuseFamily("PLANNING_DISPOSITION_UNKNOWN", "BUDGET");
  if (klass === "ADD") {
    return node.budget === null ? disposeFamily(node, "BUDGET", "BUDGET_UNRESERVED", klass)
      : refuseFamily("SUPERSESSION_CONSEQUENCE_CHANGED", "BUDGET");
  }
  const facts = exactRecord(node.budget, BUDGET_KEYS);
  if (facts === null) return refuseFamily("INPUT_INVALID", "BUDGET");
  const settled = settlementOutcome(node, facts["settlementState"], klass);
  if (settled !== null) return settled;
  const view = facts["view"] as BudgetAvailableView;
  const reservation = facts["reservation"] as ReservationRecord;
  const expectedVersion = facts["expectedVersion"] as number;
  const result = klass === "REMOVE"
    ? cancelReservation(view, reservation, {
      expectedVersion, neverStartedProofRef: facts["neverStartedProofRef"] as string | null,
    })
    : activateReservation(view, reservation, {
      expectedVersion, attemptRef: facts["successorAttemptRef"] as string,
    });
  if (!result.ok) {
    return refuseFamily(result.issues[0]?.code === "BUDGET_RESERVATION_MALFORMED"
      ? "INPUT_INVALID" : "SUPERSESSION_CONSEQUENCE_CHANGED", "BUDGET");
  }
  return disposeFamily(node, "BUDGET", `BUDGET_${result.reservation.state}`, klass);
}

/** Declared once, in family order, so the orchestrator cannot silently skip one. */
export const FAMILY_PRODUCERS: Readonly<
  Record<SupersessionDispositionFamily, (node: SupersessionNodeFacts) => FamilyOutcome>
> = Object.freeze({
  ATTEMPT: attemptDisposition, EFFECT: effectDisposition,
  RESOURCE: resourceDisposition, BUDGET: budgetDisposition,
});
