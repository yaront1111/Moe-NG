import { DurableStoreError, IdempotencyConflictError } from "./store-contracts.js";
import type {
  CommandDecisionKey,
  CommandDecisionResponse,
} from "./store-contracts.js";
import { toCommandDecisionResponse } from "./store-rows.js";
import { DecisionReadModelStore } from "./decision-read-model.js";

/**
 * Locked reconciliation of a decision that a concurrent writer may have already
 * durably decided. Internal to the decision ledger; never exported from the
 * package root.
 */
export class DecisionReplayStore extends DecisionReadModelStore {
  protected reconcileHistoricalDecision(
    key: CommandDecisionKey,
    requestSha256: string,
    missingDecisionError: unknown,
  ): CommandDecisionResponse {
    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw this.normalizeOperationalError(error, "begin replay reconciliation transaction");
    }
    try {
      this.assertDurableProjectBinding();
      const historical = this.loadCommandDecisionByKey(key);
      if (historical !== null && historical.requestSha256 !== requestSha256) {
        throw new IdempotencyConflictError(key);
      }
      this.database.exec("ROLLBACK");
      if (historical !== null) {
        return toCommandDecisionResponse(historical, "REPLAYED");
      }
      throw missingDecisionError;
    } catch (error) {
      if (this.database.isTransaction) {
        try {
          this.database.exec("ROLLBACK");
        } catch (rollbackError) {
          this.poison();
          throw new DurableStoreError(
            "STORE_UNAVAILABLE",
            "replay reconciliation could not release its read lock",
            { cause: new AggregateError([error, rollbackError]) },
          );
        }
      }
      if (error instanceof DurableStoreError) {
        throw error;
      }
      throw this.normalizeOperationalError(error, "reconcile command replay");
    }
  }
}
