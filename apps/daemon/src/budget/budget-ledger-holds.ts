/**
 * Reservation, activation, settlement and reconciliation over the durable ledger.
 *
 * SAME THREE RULES AS THE MOVEMENT WRITERS: an exact request record carrying identity and intent
 * only, bindings and prior position read from durable records, and the `@moe/scheduler` reducer's
 * own successor committed verbatim.
 *
 * THE AVAILABLE VIEW IS DERIVED HERE, NEVER ACCEPTED. `reserveForAdmission` and its siblings take
 * a `BudgetAvailableView` as an input, and that view IS the account's spending authority — so a
 * request that could hand one in would be minting balance. It is built from this ledger's own
 * durable state: the committed hold view when one exists, otherwise the account record the
 * account reducer produced.
 *
 * RECEIPTS ARE NORMALIZED SERVER-SIDE. `normalizeUsageMeasurement` is the measurement authority;
 * accepting an already-normalized record would let a caller assert a coverage the authority would
 * have refused, which is the same failure in a different costume.
 */

import {
  activateReservation,
  normalizeUsageMeasurement,
  reconcileSettlement,
  reserveForAdmission,
  settleReservation,
} from "@moe/scheduler";
import type {
  BudgetAvailableView, BudgetReservationResult, BudgetSettlementResult, NormalizedMeasurement,
  ReservationRecord, SettlementRecord,
} from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { readBudgetBinding } from "./budget-durable-binding.js";
import { readCurrentBudgetLedger } from "./budget-current-projection.js";
import type { BudgetCurrentProjection } from "./budget-current-projection.js";
import {
  admitBudgetInput, answerBudgetReplay, budgetDecisionKey, budgetRequestDigest,
  commitBudgetTransition,
} from "./budget-ledger-commit.js";
import type { BudgetCommitPort } from "./budget-ledger-commit.js";
import { budgetLedgerRefusal } from "./budget-ledger-contracts.js";
import type { BudgetLedgerRefusal, BudgetTransition } from "./budget-ledger-contracts.js";
import {
  BUDGET_ACTIVATE_INPUT_KEYS, BUDGET_AMOUNTS_SHAPE, BUDGET_NO_LIST_SHAPE, BUDGET_RECONCILE_INPUT_KEYS,
  BUDGET_RECONCILE_SHAPE, BUDGET_RESERVE_INPUT_KEYS, BUDGET_SETTLE_INPUT_KEYS, BUDGET_SETTLE_SHAPE,
} from "./budget-ledger-requests.js";
import type {
  BudgetActivateInput,
  BudgetIdentityInput,
  BudgetInputShape,
  BudgetReconcileInput,
  BudgetReserveInput,
  BudgetSettleInput,
  BudgetWriteResult,
} from "./budget-ledger-requests.js";
import { budgetRecordOf } from "./budget-ledger.js";

const TARGET_ABSENT = (): BudgetLedgerRefusal =>
  budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_TARGET_ABSENT");

const forwardReservation = (result: Extract<BudgetReservationResult, { ok: false }>): BudgetLedgerRefusal =>
  budgetLedgerRefusal(
    "REFUSED", "BUDGET_LEDGER_TRANSITION_REFUSED", result.issues[0]?.code ?? null, "BUDGET_RESERVATION",
  );

const forwardSettlement = (result: Extract<BudgetSettlementResult, { ok: false }>): BudgetLedgerRefusal =>
  budgetLedgerRefusal(
    "REFUSED", "BUDGET_LEDGER_TRANSITION_REFUSED", result.issues[0]?.code ?? null, "BUDGET_SETTLEMENT",
  );

/** The account's spending authority, taken from the durable hold view or the account record. */
function viewOf(current: BudgetCurrentProjection, accountId: string): BudgetAvailableView | null {
  const held = current.views.find((view) => view.accountId === accountId);
  if (held !== undefined) return held;
  const account = current.accounts.find((entry) => entry.accountId === accountId);
  if (account === undefined) return null;
  return { accountId, meters: account.meters, state: account.state, version: account.version };
}

const replaceView = (
  current: BudgetCurrentProjection, view: BudgetAvailableView,
): readonly BudgetAvailableView[] =>
  [...current.views.filter((entry) => entry.accountId !== view.accountId), view];

const replaceReservation = (
  current: BudgetCurrentProjection, record: ReservationRecord,
): readonly ReservationRecord[] =>
  [...current.reservations.filter((entry) => entry.reservationId !== record.reservationId), record];

const replaceSettlement = (
  current: BudgetCurrentProjection, record: SettlementRecord,
): readonly SettlementRecord[] =>
  [...current.settlements.filter((entry) => entry.settlementId !== record.settlementId), record];

/** Threads each observation through the measurement authority, preserving ITS code and layer. */
function normalizeAll(observations: readonly unknown[]): readonly NormalizedMeasurement[] | BudgetLedgerRefusal {
  const accepted: NormalizedMeasurement[] = [];
  let prior: NormalizedMeasurement | null = null;
  for (const raw of observations) {
    const result = normalizeUsageMeasurement(raw, prior);
    if (!result.ok) {
      return budgetLedgerRefusal(
        "REFUSED", "BUDGET_LEDGER_TRANSITION_REFUSED", result.issues[0]?.code ?? null, "BUDGET_MEASUREMENT",
      );
    }
    accepted.push(result.record);
    prior = result.record;
  }
  return accepted;
}

interface Opened {
  readonly current: BudgetCurrentProjection;
  readonly requestDigest: string;
}

/** The preamble every hold writer shares: admit, answer a replay, then read the durable ledger. */
function open(
  store: SqliteEventStore, input: BudgetIdentityInput, keys: readonly string[], shapes: BudgetInputShape,
): Opened | BudgetWriteResult {
  const inadmissible = admitBudgetInput(input, keys, shapes);
  if (inadmissible !== null) return inadmissible;
  // Scope before identity: see the note in budget-ledger.ts.
  const scoped = readBudgetBinding(store, input.projectId, input.goalRef);
  if (!scoped.ok) return scoped;
  const requestDigest = budgetRequestDigest(input);
  const replay = answerBudgetReplay(store, budgetDecisionKey(input.context, input.projectId), requestDigest);
  if (replay !== null) return replay;
  const current = readCurrentBudgetLedger(store, input.projectId, input.goalRef);
  if (!current.ok) return current;
  return { current, requestDigest };
}

const isOpened = (value: Opened | BudgetWriteResult): value is Opened => !("ok" in value);

/** The durable record a hold transition names, together with the account view it moves against. */
function locate<T extends { readonly accountId: string }>(
  current: BudgetCurrentProjection, record: T | undefined,
): { readonly record: T; readonly view: BudgetAvailableView } | null {
  if (record === undefined) return null;
  const view = viewOf(current, record.accountId);
  return view === null ? null : { record, view };
}

interface Successor {
  readonly reservations?: readonly ReservationRecord[];
  readonly settlements?: readonly SettlementRecord[];
  readonly views: readonly BudgetAvailableView[];
}

function commitHold(
  commit: BudgetCommitPort, input: BudgetIdentityInput, opened: Opened,
  transition: BudgetTransition, successor: Successor,
): BudgetWriteResult {
  const { current, requestDigest } = opened;
  return commitBudgetTransition(commit, input.context, input.projectId, {
    aggregateId: current.aggregateId,
    expectedVersion: current.headVersion,
    record: budgetRecordOf({
      accounts: current.accounts, appended: [], authorization: current.authorization,
      binding: current.binding, requestDigest,
      reservations: successor.reservations ?? current.reservations,
      sequence: current.headVersion,
      settlements: successor.settlements ?? current.settlements,
      transition, views: successor.views,
    }),
  });
}

export function reserveBudgetForAdmission(
  store: SqliteEventStore, input: BudgetReserveInput, commit: BudgetCommitPort = store,
): BudgetWriteResult {
  const opened = open(store, input, BUDGET_RESERVE_INPUT_KEYS, BUDGET_AMOUNTS_SHAPE);
  if (!isOpened(opened)) return opened;
  const view = viewOf(opened.current, input.accountId);
  if (view === null) return TARGET_ABSENT();
  const reserved = reserveForAdmission(
    view, { admissionRef: input.admissionRef, amounts: input.amounts, expectedVersion: view.version }, input.gate,
  );
  if (!reserved.ok) return forwardReservation(reserved);
  return commitHold(commit, input, opened, "RESERVED", {
    reservations: replaceReservation(opened.current, reserved.reservation),
    views: replaceView(opened.current, reserved.view),
  });
}

export function activateBudgetReservation(
  store: SqliteEventStore, input: BudgetActivateInput, commit: BudgetCommitPort = store,
): BudgetWriteResult {
  const opened = open(store, input, BUDGET_ACTIVATE_INPUT_KEYS, BUDGET_NO_LIST_SHAPE);
  if (!isOpened(opened)) return opened;
  const held = locate(opened.current,
    opened.current.reservations.find((entry) => entry.reservationId === input.reservationId));
  if (held === null) return TARGET_ABSENT();
  const activated = activateReservation(held.view, held.record,
    { attemptRef: input.attemptRef, expectedVersion: held.record.version });
  if (!activated.ok) return forwardReservation(activated);
  return commitHold(commit, input, opened, "ACTIVATED", {
    reservations: replaceReservation(opened.current, activated.reservation),
    views: replaceView(opened.current, activated.view),
  });
}

export function settleBudgetReservation(
  store: SqliteEventStore, input: BudgetSettleInput, commit: BudgetCommitPort = store,
): BudgetWriteResult {
  const opened = open(store, input, BUDGET_SETTLE_INPUT_KEYS, BUDGET_SETTLE_SHAPE);
  if (!isOpened(opened)) return opened;
  const held = locate(opened.current,
    opened.current.reservations.find((entry) => entry.reservationId === input.reservationId));
  if (held === null) return TARGET_ABSENT();
  const measurements = normalizeAll(input.observations);
  if (!Array.isArray(measurements)) return measurements as BudgetLedgerRefusal;
  const prior = opened.current.settlements.find((entry) => entry.reservationId === input.reservationId) ?? null;
  const settled = settleReservation(held.view, held.record, { measurements }, {
    expectedReservationVersion: held.record.version, expectedViewVersion: held.view.version, prior,
  });
  if (!settled.ok) return forwardSettlement(settled);
  if (settled.settlement === null) return TARGET_ABSENT();
  return commitHold(commit, input, opened, "SETTLED", {
    settlements: replaceSettlement(opened.current, settled.settlement),
    views: replaceView(opened.current, settled.view),
  });
}

export function reconcileBudgetSettlement(
  store: SqliteEventStore, input: BudgetReconcileInput, commit: BudgetCommitPort = store,
): BudgetWriteResult {
  const opened = open(store, input, BUDGET_RECONCILE_INPUT_KEYS, BUDGET_RECONCILE_SHAPE);
  if (!isOpened(opened)) return opened;
  const held = locate(opened.current,
    opened.current.settlements.find((entry) => entry.reservationId === input.reservationId));
  if (held === null) return TARGET_ABSENT();
  const measurements = input.observations === null ? null : normalizeAll(input.observations);
  if (measurements !== null && !Array.isArray(measurements)) return measurements as BudgetLedgerRefusal;
  const reconciled = reconcileSettlement(held.view, held.record,
    {
      measurements: measurements as readonly NormalizedMeasurement[] | null,
      neverStartedProofRef: input.neverStartedProofRef,
    },
    { expectedSettlementVersion: held.record.version, expectedViewVersion: held.view.version });
  if (!reconciled.ok) return forwardSettlement(reconciled);
  if (reconciled.settlement === null) return TARGET_ABSENT();
  return commitHold(commit, input, opened, "RECONCILED", {
    settlements: replaceSettlement(opened.current, reconciled.settlement),
    views: replaceView(opened.current, reconciled.view),
  });
}
