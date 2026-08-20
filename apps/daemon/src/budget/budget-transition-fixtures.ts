/**
 * Transition-level fixtures shared by the three budget suites.
 *
 * Split from `budget-ledger-fixtures.ts`, which seeds the DURABLE WORLD — project, goal, graph.
 * This module seeds LEDGER STATE, and it does so only by calling the production writers, so a
 * suite that starts from `seedActivatedHold` is starting from a position the shipped code
 * actually produced rather than from one a helper asserted into existence.
 *
 * The request builders here are deliberately the same objects the writers admit: a suite that
 * built its own would drift away from the exact-key admission it is supposed to be exercising.
 */

import type { AdmissionAmount, AdmissionGate, BudgetMeterAmount } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { readCurrentBudgetLedger } from "./budget-current-projection.js";
import type { BudgetCurrentProjection } from "./budget-current-projection.js";
import { deriveBudgetAggregateId } from "./budget-ledger-contracts.js";
import type { BudgetCommitContext, BudgetWriteResult } from "./budget-ledger-requests.js";
import { activateBudgetReservation, reserveBudgetForAdmission } from "./budget-ledger-holds.js";
import { allocateBudgetToChild, authorizeBudgetRoot } from "./budget-ledger.js";
import { BUDGET_ACCOUNT_REF, GOAL_ID, PROJECT_ID, seedDurableBindings } from "./budget-ledger-fixtures.js";

export const AGGREGATE = deriveBudgetAggregateId(PROJECT_ID, BUDGET_ACCOUNT_REF);
export const CHILD = "child-account-a";
export const CHILD_OWNER = "graph-node:dev-a";
export const ADMISSION = "admission-1";
export const ATTEMPT = "attempt-1";

export const AUTHORIZED: readonly BudgetMeterAmount[] = [
  { meter: "tokens", amount: 1_000 },
  { meter: "seconds", amount: 600 },
];

export const GATE: AdmissionGate = {
  allowance: { decisionRef: "policy-decision-1", outcome: "ALLOW" },
  approval: null,
};

/** Every protected purpose plus EXECUTION: `checkLines` refuses anything short of the whole set. */
export const HOLD: readonly AdmissionAmount[] = [
  { purpose: "EXECUTION", meter: "tokens", quantity: 20 },
  { purpose: "VERIFICATION", meter: "tokens", quantity: 20 },
  { purpose: "INDEPENDENT_REVIEW", meter: "tokens", quantity: 20 },
  { purpose: "FINAL_ACCEPTANCE", meter: "tokens", quantity: 20 },
  { purpose: "CONTINGENCY", meter: "tokens", quantity: 20 },
];

export const context = (commandId: string): BudgetCommitContext => ({
  commandId,
  correlationId: "corr-budget",
  decidedAt: "2026-08-19T00:00:00.000Z",
  principalId: "principal-1",
});

const digest64 = (seed: string): string => seed.repeat(64).slice(0, 64);

/** One raw usage envelope, exactly the shape `normalizeUsageMeasurement` admits. */
export function observation(overrides: Record<string, unknown> = {}): unknown {
  return {
    measurement: {
      coverage: "COMPLETE", meter: "tokens",
      observedInterval: { endRef: "interval-end-1", startRef: "interval-start-1" },
      providerRunRef: ATTEMPT, quantity: 60, rawReceiptDigest: digest64("ab"), sequence: 0,
      source: "PROVIDER_REPORTED_COMPLETE", sourceParserVersion: 1, ...overrides,
    },
    pricebookBinding: null,
    truncated: false,
  };
}

/** A receipt that measures NOTHING — what drives a hold into QUARANTINED and reads as UNKNOWN. */
export const unknownObservation = (sequence = 0): unknown =>
  observation({ coverage: "UNKNOWN", quantity: null, sequence, source: "UNKNOWN" });

export const authorizeInput = (commandId = "cmd-authorize") => ({
  amounts: AUTHORIZED,
  context: context(commandId),
  goalRef: GOAL_ID,
  projectId: PROJECT_ID,
});

export const movementInput = (commandId: string, amounts: readonly BudgetMeterAmount[]) => ({
  amounts,
  childAccountId: CHILD,
  childOwnerRef: CHILD_OWNER,
  context: context(commandId),
  goalRef: GOAL_ID,
  projectId: PROJECT_ID,
});

export const reserveInput = (commandId: string, gate: AdmissionGate = GATE) => ({
  accountId: CHILD,
  admissionRef: ADMISSION,
  amounts: HOLD,
  context: context(commandId),
  gate,
  goalRef: GOAL_ID,
  projectId: PROJECT_ID,
});

export function accepted(result: BudgetWriteResult): Extract<BudgetWriteResult, { ok: true }> {
  if (!result.ok) throw new Error(`unexpected refusal ${result.code} / ${String(result.sourceCode)}`);
  return result;
}

export function refused(result: BudgetWriteResult): Extract<BudgetWriteResult, { ok: false }> {
  if (result.ok) throw new Error(`unexpected acceptance ${result.disposition}`);
  return result;
}

export function currentLedger(store: SqliteEventStore): BudgetCurrentProjection {
  const read = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
  if (!read.ok) throw new Error(`projection refused ${read.code}`);
  return read;
}

/** Root authorization plus one funded child, through the production writers only. */
export function seedFundedChild(store: SqliteEventStore): void {
  seedDurableBindings(store);
  accepted(authorizeBudgetRoot(store, authorizeInput()));
  accepted(allocateBudgetToChild(store, movementInput("cmd-allocate", [{ meter: "tokens", amount: 400 }])));
}

/** The whole happy path up to and including one ACTIVATED hold on the child account. */
export function seedActivatedHold(store: SqliteEventStore): void {
  seedFundedChild(store);
  accepted(reserveBudgetForAdmission(store, reserveInput("cmd-reserve")));
  const [reservation] = currentLedger(store).reservations;
  if (reservation === undefined) throw new Error("no durable reservation");
  accepted(activateBudgetReservation(store, {
    attemptRef: ATTEMPT, context: context("cmd-activate"), goalRef: GOAL_ID,
    projectId: PROJECT_ID, reservationId: reservation.reservationId,
  }));
}
