/**
 * Request and result shapes for the durable budget writers.
 *
 * SPLIT FROM `budget-ledger-contracts.ts` when that module crossed the per-file target: refusal
 * vocabulary and request admission are separable, and the admission rosters are the half worth
 * reading on their own — they are what task rail 1 is enforced by.
 *
 * EVERY WRITER ADMITS AN EXACT RECORD. The roster below each input is not documentation: the
 * writers compare `Object.keys` against it, so a key that is not on a roster cannot reach a
 * reducer, and `BUDGET_CALLER_AUTHORITY_KEYS` is the sweep that proves the two never overlap.
 */

import type { AdmissionAmount, AdmissionGate, BudgetMeterAmount } from "@moe/scheduler";

import type { BudgetLedgerRecord, BudgetRefusal } from "./budget-ledger-contracts.js";

export interface BudgetCommitContext {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly principalId: string;
}

export const BUDGET_COMMIT_CONTEXT_KEYS = Object.freeze([
  "commandId", "correlationId", "decidedAt", "principalId",
] as const);

/**
 * Keys a request may NEVER carry.
 *
 * Task rail 1: root authorization is server-bound, so no caller hands in a `BudgetAvailableView`,
 * a bucket, a coverage verdict, or the account/graph/owner identity a transition is bound to.
 * Every entry here is a field of a shape the scheduler or this module owns, and the writers'
 * exact-key admission refuses all of them; the roster exists so a SWEEP can prove that rather
 * than one hand-picked example.
 */
export const BUDGET_CALLER_AUTHORITY_KEYS = Object.freeze([
  "accounts", "authorization", "available", "binding", "budgetAccountRef", "buckets",
  "committed", "coverage", "entries", "graphEpoch", "graphRevisionRef", "meters", "ownerRef",
  "quarantined", "refundable", "reservations", "reserved", "settlements", "state", "version",
  "view", "views",
] as const);

/**
 * Request fields whose SHAPE a writer must pin before delegating.
 *
 * NOT a second validator. Exact-key admission checks key NAMES only, so a declared list field
 * arriving as `undefined`, `null` or a string reached a reducer — or this module's own
 * `normalizeAll` — as a non-iterable and CRASHED it. A crash is not a refusal: it carries no
 * stable code and no layer. Only the array-ness is pinned here; what is IN the array (meters,
 * amounts, receipt content) stays the reducer's and the measurement authority's to judge, so
 * their codes still travel as `sourceCode`/`sourceLayer`.
 *
 * `settle` requires observations; `reconcile` admits a null one, because a never-started proof
 * settles a hold with nothing measured. That difference is why the rosters are per writer.
 */
export type BudgetInputShape = Readonly<Record<string, "ARRAY" | "ARRAY_OR_NULL">>;

export const BUDGET_AMOUNTS_SHAPE: BudgetInputShape = Object.freeze({ amounts: "ARRAY" });
export const BUDGET_SETTLE_SHAPE: BudgetInputShape = Object.freeze({ observations: "ARRAY" });
export const BUDGET_RECONCILE_SHAPE: BudgetInputShape = Object.freeze({ observations: "ARRAY_OR_NULL" });
export const BUDGET_NO_LIST_SHAPE: BudgetInputShape = Object.freeze({});

export const BUDGET_AUTHORIZE_INPUT_KEYS = Object.freeze([
  "amounts", "context", "goalRef", "projectId",
] as const);

export const BUDGET_MOVEMENT_INPUT_KEYS = Object.freeze([
  "amounts", "childAccountId", "childOwnerRef", "context", "goalRef", "projectId",
] as const);

export const BUDGET_RESERVE_INPUT_KEYS = Object.freeze([
  "accountId", "admissionRef", "amounts", "context", "gate", "goalRef", "projectId",
] as const);

export const BUDGET_ACTIVATE_INPUT_KEYS = Object.freeze([
  "attemptRef", "context", "goalRef", "projectId", "reservationId",
] as const);

export const BUDGET_SETTLE_INPUT_KEYS = Object.freeze([
  "context", "goalRef", "observations", "projectId", "reservationId",
] as const);

export const BUDGET_RECONCILE_INPUT_KEYS = Object.freeze([
  "context", "goalRef", "neverStartedProofRef", "observations", "projectId", "reservationId",
] as const);

export interface BudgetIdentityInput {
  readonly context: BudgetCommitContext;
  readonly goalRef: string;
  readonly projectId: string;
}

export interface BudgetAuthorizeInput extends BudgetIdentityInput {
  readonly amounts: readonly BudgetMeterAmount[];
}

export interface BudgetMovementInput extends BudgetIdentityInput {
  readonly amounts: readonly BudgetMeterAmount[];
  readonly childAccountId: string;
  readonly childOwnerRef: string;
}

export interface BudgetReserveInput extends BudgetIdentityInput {
  readonly accountId: string;
  readonly admissionRef: string;
  readonly amounts: readonly AdmissionAmount[];
  readonly gate: AdmissionGate;
}

export interface BudgetActivateInput extends BudgetIdentityInput {
  readonly attemptRef: string;
  readonly reservationId: string;
}

export interface BudgetSettleInput extends BudgetIdentityInput {
  readonly observations: readonly unknown[];
  readonly reservationId: string;
}

export interface BudgetReconcileInput extends BudgetIdentityInput {
  readonly neverStartedProofRef: string | null;
  readonly observations: readonly unknown[] | null;
  readonly reservationId: string;
}

/**
 * On COMMITTED, `record` and `digest` describe the bytes this call just wrote. On REPLAYED they
 * are the bytes ALREADY IN THE STORE, resolved from the original decision rather than from a
 * freshly derived successor — answering a replay with a recomputation would hand back authority
 * for a transition nobody committed.
 */
export type BudgetWriteResult =
  | {
      readonly ok: true;
      readonly aggregateId: string;
      readonly digest: string;
      readonly disposition: "COMMITTED" | "REPLAYED";
      readonly record: BudgetLedgerRecord;
    }
  | BudgetRefusal;
