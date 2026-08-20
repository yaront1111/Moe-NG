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

import { allocateToChild, openBudgetRoot, returnToParent } from "@moe/scheduler";
import type {
  BudgetAuthorization,
  BudgetLedgerResult,
  BudgetLedgerState,
  BudgetMeterAmount,
  BudgetMovementCommand,
} from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { readCurrentBudgetLedger } from "./budget-current-projection.js";
import { readBudgetBinding } from "./budget-durable-binding.js";
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

export function budgetRecordOf(fields: Omit<BudgetLedgerRecord, "recordVersion">): BudgetLedgerRecord {
  return { recordVersion: BUDGET_LEDGER_RECORD_VERSION, ...fields };
}

/**
 * Root authorization.
 *
 * The amounts are the operator's declared budget and are the ONLY thing the request contributes;
 * the account it opens, the owner it is bound to and the graph revision it is issued against are
 * all read from durable records here.
 */
export function authorizeBudgetRoot(
  store: SqliteEventStore, input: BudgetAuthorizeInput, commit: BudgetCommitPort = store,
): BudgetWriteResult {
  const inadmissible = admitBudgetInput(input, BUDGET_AUTHORIZE_INPUT_KEYS, BUDGET_AMOUNTS_SHAPE);
  if (inadmissible !== null) return inadmissible;
  // SCOPE BEFORE IDENTITY. The decision key carries a projectId and the store refuses a lookup
  // outside the project it was opened for, so a foreign request must be named as foreign here
  // rather than surfacing as an unavailable store one call later.
  const bound = readBudgetBinding(store, input.projectId, input.goalRef);
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
      requestDigest, reservations: [], sequence: 0, settlements: [],
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
 */
function heldAccount(current: BudgetCurrentProjection, ids: readonly string[]): boolean {
  return current.views.some((view) => ids.includes(view.accountId));
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
  if (heldAccount(current, [parentAccountId, input.childAccountId])) {
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
  return commitBudgetTransition(commit, input.context, input.projectId, {
    aggregateId: current.aggregateId,
    expectedVersion: current.headVersion,
    record: budgetRecordOf({
      accounts: moved.state.accounts,
      appended: moved.state.entries.slice(current.entries.length),
      authorization: current.authorization, binding, requestDigest,
      reservations: current.reservations, sequence: current.headVersion,
      settlements: current.settlements, transition, views: current.views,
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
