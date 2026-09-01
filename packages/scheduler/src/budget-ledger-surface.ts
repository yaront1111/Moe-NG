/**
 * The conserved-budget half of the package root: the hierarchical account ledger and the
 * settlement/reconciliation closure, curated the way the execution surface curates its own
 * families.
 *
 * This module adds NO behaviour. Every specifier below names a symbol its module already
 * exports; nothing under `src/budget/` changes because of this file. It exists so a durable
 * consumer — the daemon budget ledger — can reach a conserved transition from the bare
 * `@moe/scheduler` specifier instead of deep-importing a private module or, worse, copying the
 * arithmetic. `execution-surface.ts` forwards this module wholesale, so the reviewed namespace
 * stays one reviewed set.
 *
 * Named specifiers only, never `export *` from a budget module: the curation IS the specifier
 * list, and a star re-export would publish tomorrow's module-level addition unreviewed.
 */

/**
 * The account ledger, design 601-613. The five transitions are the whole conserved surface:
 * units only ever move between accounts, and every mutation carries the compare-and-swap
 * version the store fences on.
 *
 * `deriveSubtreeTotals` is published on purpose. It is the only roll-up over root-plus-
 * descendants, and it is deliberately derived rather than stored so it cannot drift from the
 * direct buckets. A consumer that could not reach it would re-implement the aggregation, which
 * is exactly the copied arithmetic this surface exists to prevent. `MAX_BUDGET_VERSION` is the
 * shared version ceiling every transition fences on — the same reason the graph bounds are
 * published — so a consumer can refuse a doomed command before issuing it rather than
 * rediscovering the constant. `replayBudgetLedger` folds a recorded entry stream through the
 * SAME transition core as live application, so a durable rebuild cannot diverge from it.
 *
 * WITHHELD from the contract module beside these: `validateBudgetAccount`,
 * `validateReserveDeclaration` and `MAX_BUDGET_METERS` are the contract-validator seam. They
 * gate caller-shaped input, not a ledger transition, and a consumer holding one could accept a
 * record the transitions themselves refuse.
 */
export {
  BUDGET_ACCOUNT_ISSUE_CODES,
  MAX_BUDGET_VERSION,
  allocateToChild,
  closeBudgetAccount,
  deriveSubtreeTotals,
  openBudgetRoot,
  returnToParent,
} from "./budget/budget-account.js";
export { replayBudgetLedger } from "./budget/budget-account-replay.js";

/**
 * Settlement and reconciliation, design 660-664 and recovery matrix 1039. The four transitions
 * are the only exits from a hold: settle a reservation on measured evidence, reconcile a
 * quarantined hold against a late receipt or a never-started proof, write one off under human
 * acknowledgement, or close a fully drained view.
 *
 * `deriveSettlementId` travels with them because settlement identity is length-prefixed over
 * the reservation id, and `readSettlement` re-derives it to refuse a forgery. A consumer that
 * had to reconstruct that string by hand would be copying the identity arithmetic and would
 * mint records the module rejects. The three closed vocabularies are published for the same
 * reason as the measurement ones: a consumer classifying a refusal, a settlement state or a
 * line disposition must read the roster rather than hard-code a literal that can drift.
 *
 * WITHHELD: `projectBudgetFact` stays unpublished. Budget-POLICY projection is a different
 * seam from budget conservation, and publishing it here would let a consumer treat a projected
 * fact as settlement authority.
 */
export {
  BUDGET_SETTLEMENT_ISSUE_CODES,
  LINE_DISPOSITIONS,
  SETTLEMENT_STATES,
  closeSettledView,
  conservativeSettle,
  deriveSettlementId,
  reconcileSettlement,
  settleReservation,
} from "./budget/budget-settlement.js";

/**
 * The account-ledger type closure. Both arms of `BudgetLedgerResult` are named, because a
 * consumer that can call a transition but cannot type its refusal has to widen to `unknown`
 * and loses the closed issue-code union that makes failing closed checkable.
 */
export type {
  BudgetAccountIssue,
  BudgetAccountIssueCode,
  BudgetAuthorization,
  BudgetCloseCommand,
  BudgetLedgerEntry,
  BudgetLedgerEntryKind,
  BudgetLedgerResult,
  BudgetLedgerState,
  BudgetMeterAmount,
  BudgetMovementCommand,
} from "./budget/budget-account.js";

/**
 * Closure, not decoration: `BudgetLedgerState.accounts` is `readonly BudgetAccountRecord[]`, so
 * without this a consumer can name the state the transitions return but cannot type a single
 * account inside it. Its own fields close over `BudgetAccountState` and `BudgetMeterBuckets`,
 * which the execution surface already publishes from the same contract module.
 */
export type { BudgetAccountRecord } from "./budget/budget-contract.js";

/**
 * The settlement type closure. The four command shapes and the two evidence shapes travel with
 * the transitions that read them — a consumer holding the verb but not its command cannot call
 * it from the bare specifier alone. `SettlementLine` and `BudgetOverrun` are the fields a
 * consumer reads back off a `SettlementRecord`, so they close the record rather than extend it.
 */
export type {
  BudgetOverrun,
  BudgetSettlementIssue,
  BudgetSettlementIssueCode,
  BudgetSettlementResult,
  CloseCommand,
  ConservativeCommand,
  LineDisposition,
  ReconcileEvidence,
  SettleCommand,
  SettleEvidence,
  SettlementCommand,
  SettlementLine,
  SettlementRecord,
  SettlementState,
} from "./budget/budget-settlement.js";

/**
 * THE PROVIDER-RUN WIRE IDENTITY. The runner ENCODES every measurement's `providerRunRef` through
 * `encodeProviderRunRef`; the settlement reducer DECODES the attempt segment back out to correlate
 * a reading against a reservation. Published because the producer lives in another package.
 */
export { decodeProviderRunRefAttempt, encodeProviderRunRef } from "./budget/budget-run-ref.js";
export type { ProviderRunIdentity } from "./budget/budget-run-ref.js";
