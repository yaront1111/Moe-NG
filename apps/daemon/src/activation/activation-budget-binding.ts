/**
 * (J2) The activation ingress's RESERVED -> ACTIVATED budget bind: the money half of (J).
 *
 * WHY THIS IS A SECOND DECISION AND NOT A LEG OF THE ACTIVATION, three independent reasons —
 * the first is the only one the pre-existing comments named, and a single-cause explanation is
 * how the gap this module closes survived a QA-approved row (task-03049148):
 *   1. `decision-ledger-legs.ts` fences a duplicate aggregateId ACROSS LEGS of one decision, and
 *      the unit-MOVING `reserveForAdmission` already spends the budget aggregate's single slot.
 *      The fence is per DECISION, though, so a separate decision may target it freely.
 *   2. ORDERING. The attempt ref does not exist when the budget leg's bytes are frozen:
 *      `durableBudgetStage` seals the leg, and `activation.value.commit.attempt.attemptId` is
 *      minted seven lines later. There is nothing to bind at leg-capture time.
 *   3. `captureBudgetLeg` destructures `const [only] = captured` — a SECOND captured commit is
 *      silently dropped, not refused — and every hold writer folds from the DURABLE head via
 *      `open()` -> `readCurrentBudgetLedger`, so before the activation decision commits there is
 *      no reservation to locate and the writer would answer TARGET_ABSENT.
 *
 * THE SUFFIXED COMMAND ID IS MANDATORY, NOT STYLISTIC. `budgetDecisionKey` is
 * `{commandId, principalId, projectId}` — the commandId is the whole discriminator — and the
 * activation route has ALREADY burned `request.commandId` under commandKind "activation.commit".
 * `answerBudgetReplay` refuses BUDGET_LEDGER_IDEMPOTENCY_CONFLICT when a prior decision under the
 * same key carries a foreign commandKind, so reusing the activation's own id would make this
 * transition permanently unreachable. The suffix gives the binding its own identity under this
 * ledger's own kind, and replay then resolves normally. The shape has four production
 * precedents: `attempt-resource-authority.ts` (`${commandId}:RESOURCES:${version}`),
 * `foundation-launch-authority.ts`, `attempt-release-store.ts` and `foundation-attempt-store.ts`.
 *
 * A BIND REFUSAL IS NOT AN ACTIVATION REFUSAL — the same rule as the resource bind, for the same
 * reason: the activation is already durable when this runs, so answering "refused" would be a
 * false claim about a committed decision. IT IS ALSO NOT SILENT. The failure is durably
 * observable and fail-closed in the direction that costs nothing: no `:BUDGET_ACTIVATE` decision
 * exists, the reservation stays RESERVED with `attemptRef: null`, and `settleReservation` then
 * refuses BUDGET_SETTLEMENT_NOT_ACTIVATED rather than settling money against an unbound hold.
 * A missed bind therefore blocks settlement; it never permits a wrong one.
 *
 * COMPOSITION ONLY. `activateBudgetReservation` owns the write and `activateReservation` owns the
 * transition; this module re-implements neither, and it touches no scheduler arithmetic.
 */

import type { SqliteEventStore } from "@moe/store";

import { activateBudgetReservation } from "../budget/budget-ledger-holds.js";
import type { ActivationIngressRequest } from "./activation-ingress-contracts.js";

/**
 * Appended to BOTH the commandId and the correlationId of the binding's own decision.
 *
 * Right-parsable: the activation's ids never end in this literal, so the parent identity is
 * recoverable by stripping one fixed suffix rather than by splitting on a separator that could
 * appear inside a caller-supplied id.
 */
export const ACTIVATION_BUDGET_BINDING_SUFFIX = ":BUDGET_ACTIVATE";

/**
 * MODULE-PRIVATE, and only the refusal TYPE is exported. This module forwards the ledger's own
 * layer for every verdict the ledger reached; this layer names the one refusal it authors
 * itself — a store fault thrown out of the read preamble, which is nobody else's decision.
 */
const BINDING_LAYER = "DAEMON_ACTIVATION_BUDGET_BINDING";

export interface ActivationBudgetBindingInput {
  /** The attempt's OWN id, read from the committed activation — never re-derived from payload. */
  readonly attemptRef: string;
  readonly goalRef: string;
  readonly request: ActivationIngressRequest;
  readonly reservationId: string;
  readonly store: SqliteEventStore;
}

export interface ActivationBudgetBindingBound {
  readonly disposition: "COMMITTED" | "REPLAYED";
  readonly ok: true;
}

export interface ActivationBudgetBindingRefused {
  readonly code: string;
  readonly layer: string;
  readonly ok: false;
}

export type ActivationBudgetBindingResult =
  | ActivationBudgetBindingBound
  | ActivationBudgetBindingRefused;

/**
 * Binds the attempt to the hold its own activation minted.
 *
 * EVERY VERDICT THE LEDGER REACHED IS FORWARDED UNRESTAMPED, code and layer both. Restamping one
 * would claim this module decided something it only relayed, and would hide which layer — the
 * ledger, the projection or the scheduler's reservation — actually answered. The ONE exception is
 * a thrown store fault, which is not a verdict at all: it is caught below and answered in this
 * module's own vocabulary, because attributing it to the ledger would be the same lie inverted.
 */
export function bindActivationBudget(
  input: ActivationBudgetBindingInput,
): ActivationBudgetBindingResult {
  const { attemptRef, goalRef, request, reservationId, store } = input;
  let result;
  try {
    result = activateBudgetReservation(store, {
      attemptRef,
      context: {
        commandId: `${request.commandId}${ACTIVATION_BUDGET_BINDING_SUFFIX}`,
        correlationId: `${request.correlationId}${ACTIVATION_BUDGET_BINDING_SUFFIX}`,
        decidedAt: request.decidedAt,
        principalId: request.principalId,
      },
      goalRef,
      projectId: request.projectId,
      reservationId,
    });
  } catch {
    // A THROW MUST NOT ESCAPE A COMMITTED ACTIVATION. The write path folds store faults into
    // refusals itself, but its READ preamble does not: `readBudgetBinding` and
    // `readCurrentBudgetLedger` call `store.readEvents` uncaught. Letting that propagate would
    // surface a durably COMMITTED activation to the caller as a thrown error, and — because
    // this bind runs first — would also skip the resource bind that used to always run.
    // Restamped rather than forwarded, because a throw is not the ledger's own verdict.
    return { code: "ACTIVATION_BUDGET_BINDING_STORE_THREW", layer: BINDING_LAYER, ok: false };
  }
  if (!result.ok) return { code: result.code, layer: result.layer, ok: false };
  return { disposition: result.disposition, ok: true };
}
