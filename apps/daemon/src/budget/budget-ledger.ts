/**
 * Server-issued root authorization and hierarchical account movements.
 *
 * THREE THINGS EVERY WRITER HERE DOES, AND NOTHING ELSE:
 *   1. admits an EXACT request record carrying identity and command intent only — no view, no
 *      bucket, no coverage, no account/graph/owner authority (task rail 1);
 *   2. reads its bindings and its prior position from DURABLE records, so the account ref comes
 *      off `GoalCreated` and the revision and epoch off the current active graph;
 *   3. delegates to the `@moe/scheduler` reducer and commits THAT reducer's own successor.
 *
 * NO ARITHMETIC HAPPENS IN THIS FILE. A locally computed successor would be a second
 * implementation of conservation, free to disagree with the reducer that governs — and the one
 * disagreement nobody can correct afterwards, because it is already durable.
 *
 * A REDUCER REFUSAL IS FORWARDED, NEVER RESTAMPED: its code travels as `sourceCode` under
 * `BUDGET_ACCOUNT`, and the wrapper code only says that a transition was declined.
 */

import { allocateToChild, closeSettledView, openBudgetRoot, returnToParent } from "@moe/scheduler";
import type {
  BudgetAuthorization,
  BudgetAvailableView,
  BudgetLedgerResult,
  BudgetLedgerState,
  BudgetMeterAmount,
  BudgetMovementCommand,
  BudgetSettlementResult,
  SettlementRecord,
} from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { readCurrentBudgetLedger } from "./budget-current-projection.js";
import { readBudgetBinding } from "./budget-durable-binding.js";
import type { BudgetBindingPort } from "./budget-durable-binding.js";
import type { BudgetCurrentProjection } from "./budget-current-projection.js";
import {
  admitBudgetInput,
  answerBudgetReplay,
  budgetDecisionKey,
  budgetRequestDigest,
  commitBudgetTransition,
} from "./budget-ledger-commit.js";
import type { BudgetCommitPort } from "./budget-ledger-commit.js";
import {
  BUDGET_LEDGER_RECORD_VERSION,
  budgetLedgerRefusal,
  deriveBudgetAggregateId,
} from "./budget-ledger-contracts.js";
import type {
  BudgetDurableBinding,
  BudgetLedgerRecord,
  BudgetLedgerRefusal,
  BudgetTransition,
} from "./budget-ledger-contracts.js";
import {
  BUDGET_AMOUNTS_SHAPE,
  BUDGET_AUTHORIZE_INPUT_KEYS,
  BUDGET_MOVEMENT_INPUT_KEYS,
} from "./budget-ledger-requests.js";
import type {
  BudgetAuthorizeInput,
  BudgetMovementInput,
  BudgetWriteResult,
} from "./budget-ledger-requests.js";

/** Wraps an account-reducer refusal, preserving the code and the layer that produced it. */
export function forwardAccountRefusal(result: Extract<BudgetLedgerResult, { ok: false }>): BudgetLedgerRefusal {
  return budgetLedgerRefusal(
    "REFUSED", "BUDGET_LEDGER_TRANSITION_REFUSED", result.issues[0]?.code ?? null, "BUDGET_ACCOUNT",
  );
}

/** Same forwarding for the settlement reducer, which is what judges a hold view's close. */
const forwardSettlementRefusal = (result: Extract<BudgetSettlementResult, { ok: false }>): BudgetLedgerRefusal =>
  budgetLedgerRefusal(
    "REFUSED", "BUDGET_LEDGER_TRANSITION_REFUSED", result.issues[0]?.code ?? null, "BUDGET_SETTLEMENT",
  );

export function budgetRecordOf(fields: Omit<BudgetLedgerRecord, "recordVersion">): BudgetLedgerRecord {
  return { recordVersion: BUDGET_LEDGER_RECORD_VERSION, ...fields };
}

/**
 * Root authorization.
 *
 * The amounts are the operator's declared budget and are the ONLY thing the request contributes;
 * the account it opens, the owner it is bound to and the graph revision it is issued against are
 * all read from durable records here.
 *
 * `readBinding` DEFAULTS TO THE STRICT READER and every existing caller gets it, so nothing
 * about this path moves. It is a parameter for one reason: the strict reader answers off the
 * CURRENT ACTIVE graph, and the one moment a project needs its root — approval, before any graph
 * is active — is precisely the moment that read must refuse. The genesis derivation therefore
 * has to be reachable from INSIDE this function, which owns the once-only guard below; passing
 * it around the writer would mean reimplementing that guard, and a second implementation of
 * "only once, ever" is the last thing this ledger should have. What may be injected is a READ,
 * never a decision: the amounts, the replay, the guard and the reducer all still run here.
 */
export function authorizeBudgetRoot(
  store: SqliteEventStore, input: BudgetAuthorizeInput, commit: BudgetCommitPort = store,
  readBinding: BudgetBindingPort = readBudgetBinding,
): BudgetWriteResult {
  const inadmissible = admitBudgetInput(input, BUDGET_AUTHORIZE_INPUT_KEYS, BUDGET_AMOUNTS_SHAPE);
  if (inadmissible !== null) return inadmissible;
  // SCOPE BEFORE IDENTITY. The decision key carries a projectId and the store refuses a lookup
  // outside the project it was opened for, so a foreign request must be named as foreign here
  // rather than surfacing as an unavailable store one call later.
  const bound = readBinding(store, input.projectId, input.goalRef);
  if (!bound.ok) return bound;
  const binding = bound.binding;
  const requestDigest = budgetRequestDigest(input);
  const replay = answerBudgetReplay(store, budgetDecisionKey(input.context, input.projectId), requestDigest);
  if (replay !== null) return replay;
  const aggregateId = deriveBudgetAggregateId(input.projectId, binding.budgetAccountRef);
  if (store.readEvents(aggregateId).length > 0) {
    return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_ALREADY_AUTHORIZED");
  }
  const authorization: BudgetAuthorization = {
    amounts: input.amounts, graphRevisionRef: binding.graphRevisionRef,
    ownerRef: binding.ownerRef, rootAccountId: binding.budgetAccountRef,
  };
  const opened = openBudgetRoot(authorization);
  if (!opened.ok) return forwardAccountRefusal(opened);
  return commitBudgetTransition(commit, input.context, input.projectId, {
    aggregateId,
    expectedVersion: 0,
    record: budgetRecordOf({
      accounts: opened.state.accounts, appended: opened.state.entries, authorization, binding,
      requestDigest, reservations: [], sequence: 0, settledMeters: [], settlements: [],
      transition: "ROOT_AUTHORIZED", views: [],
    }),
  });
}

const versionOf = (current: BudgetCurrentProjection, accountId: string): number | null =>
  current.accounts.find((account) => account.accountId === accountId)?.version ?? null;

/**
 * A movement may not touch an account that still holds units.
 *
 * The account ledger and the available view are TWO representations of the same units, kept by
 * two reducers that do not know about each other: a reservation moves available into reserved on
 * the view while the account record is untouched. Applying a movement to the account record while
 * a view holds units would let one unit be both allocated away and reserved, so this fails closed
 * instead. Re-opening it needs a scheduler-side reducer that composes both — never arithmetic
 * here.
 *
 * ONE composed exit exists: a RETURN that liquidates a FULLY SETTLED hold view drains through
 * `settledDrainOf` below, pairing the account reducer's movement with the settlement reducer's
 * own CLOSE. Everything else — a live hold, quarantined units, a CLOSED view — stays refused,
 * because the CLOSED view is precisely the durable record that this account's stale balance may
 * never move again.
 */
function heldAccount(current: BudgetCurrentProjection, ids: readonly string[]): boolean {
  return current.views.some((view) => ids.includes(view.accountId));
}

interface SettledDrain {
  /** Every settlement bound to the drained account; `closeSettledView` judges them itself. */
  readonly settlements: readonly SettlementRecord[];
  readonly view: BudgetAvailableView;
}

/**
 * The one movement a held account still admits: returning EXACTLY the refundable units of a
 * fully settled hold view to a parent whose own balance authority is its account record.
 *
 * THE VIEW IS THE BALANCE AUTHORITY. The account fold never learns committed spend — a
 * settlement moves units between buckets of one account without a movement entry — so the
 * child's account record still carries its whole allocation as available. Sizing the return off
 * that record would refund consumed units; sizing it off anything but the view's exact per-meter
 * `available` would leave the two books permanently disagreeing. The request must therefore name
 * the view's refundable position meter for meter, and nothing else drains.
 *
 * Null means "not drainable" and the ordinary ACCOUNT_HELD refusal stands: a live or quarantined
 * hold, a CLOSED or OVERDRAWN view (design 664: neither moves again), a parent whose own hold
 * view would hide the credited units from every reader, or amounts that disagree with the view.
 */
function settledDrainOf(
  current: BudgetCurrentProjection, parentAccountId: string, childAccountId: string,
  amounts: readonly BudgetMeterAmount[],
): SettledDrain | null {
  if (current.views.some((view) => view.accountId === parentAccountId)) return null;
  const view = current.views.find((entry) => entry.accountId === childAccountId);
  if (view === undefined || view.state !== "OPEN") return null;
  if (view.meters.some((meter) => meter.reserved > 0 || meter.quarantined > 0)) return null;
  const refundable = view.meters.filter((meter) => meter.available > 0);
  if (refundable.length === 0 || amounts.length !== refundable.length) return null;
  if (!refundable.every((meter) =>
    amounts.some((entry) => entry.meter === meter.meter && entry.amount === meter.available))) {
    return null;
  }
  return {
    settlements: current.settlements.filter((entry) => entry.accountId === childAccountId),
    view,
  };
}

/**
 * The CLOSED successor of the drained view, minted by the settlement reducer.
 *
 * Zeroing `available` is not a second balance computation: the drain admitted EXACTLY the view's
 * available as the movement's amounts, so an emptied bucket is the definition of that movement
 * having happened, and the version bump mirrors the reducer's own rule that every unit-moving
 * operation advances the view. `closeSettledView` then re-judges the whole shape itself — any
 * unit still standing in any bucket, or a settlement still QUARANTINED, refuses with its own
 * code, which travels forwarded rather than restamped.
 */
function closeDrainedView(drain: SettledDrain): BudgetSettlementResult {
  const drained: BudgetAvailableView = {
    accountId: drain.view.accountId,
    meters: drain.view.meters.map((meter) => ({ ...meter, available: 0 })),
    state: drain.view.state,
    version: drain.view.version + 1,
  };
  return closeSettledView(drained, drain.settlements, { expectedVersion: drained.version });
}

function applyMovement(
  store: SqliteEventStore, input: BudgetMovementInput, commit: BudgetCommitPort,
  transition: Extract<BudgetTransition, "ALLOCATED" | "RETURNED">,
  reduce: (state: BudgetLedgerState, command: BudgetMovementCommand) => BudgetLedgerResult,
): BudgetWriteResult {
  const inadmissible = admitBudgetInput(input, BUDGET_MOVEMENT_INPUT_KEYS, BUDGET_AMOUNTS_SHAPE);
  if (inadmissible !== null) return inadmissible;
  const scoped = readBudgetBinding(store, input.projectId, input.goalRef);
  if (!scoped.ok) return scoped;
  const requestDigest = budgetRequestDigest(input);
  const replay = answerBudgetReplay(store, budgetDecisionKey(input.context, input.projectId), requestDigest);
  if (replay !== null) return replay;
  const current = readCurrentBudgetLedger(store, input.projectId, input.goalRef);
  if (!current.ok) return current;
  const binding: BudgetDurableBinding = current.binding;
  const parentAccountId = binding.budgetAccountRef;
  const held = heldAccount(current, [parentAccountId, input.childAccountId]);
  const drain = held && transition === "RETURNED"
    ? settledDrainOf(current, parentAccountId, input.childAccountId, input.amounts)
    : null;
  if (held && drain === null) {
    return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_ACCOUNT_HELD");
  }
  const expectedParentVersion = versionOf(current, parentAccountId);
  if (expectedParentVersion === null) return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_TARGET_ABSENT");
  const prior = {
    accounts: current.accounts, authorized: current.authorization.amounts as readonly BudgetMeterAmount[],
    entries: current.entries, overrun: [], rootAccountId: parentAccountId,
  };
  const moved = reduce(prior, {
    amounts: input.amounts, childAccountId: input.childAccountId, childOwnerRef: input.childOwnerRef,
    expectedChildVersion: versionOf(current, input.childAccountId), expectedParentVersion,
    parentAccountId,
  });
  if (!moved.ok) return forwardAccountRefusal(moved);
  const closed = drain === null ? null : closeDrainedView(drain);
  if (closed !== null && !closed.ok) return forwardSettlementRefusal(closed);
  // The CLOSED successor REPLACES the drained view rather than vanishing: it is what keeps the
  // roll-up reading committed spend the account fold never learned, and what keeps this account
  // barred from ever moving its stale record again.
  const views = closed === null
    ? current.views
    : [...current.views.filter((entry) => entry.accountId !== closed.view.accountId), closed.view];
  return commitBudgetTransition(commit, input.context, input.projectId, {
    aggregateId: current.aggregateId,
    expectedVersion: current.headVersion,
    record: budgetRecordOf({
      accounts: moved.state.accounts,
      appended: moved.state.entries.slice(current.entries.length),
      authorization: current.authorization, binding, requestDigest,
      reservations: current.reservations, sequence: current.headVersion,
      settledMeters: current.settledMeters,
      settlements: current.settlements, transition, views,
    }),
  });
}

export function allocateBudgetToChild(
  store: SqliteEventStore, input: BudgetMovementInput, commit: BudgetCommitPort = store,
): BudgetWriteResult {
  return applyMovement(store, input, commit, "ALLOCATED", allocateToChild);
}

export function returnBudgetToParent(
  store: SqliteEventStore, input: BudgetMovementInput, commit: BudgetCommitPort = store,
): BudgetWriteResult {
  return applyMovement(store, input, commit, "RETURNED", returnToParent);
}
