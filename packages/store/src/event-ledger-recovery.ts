import { DurableStoreError } from "./store-contracts.js";
import { EventAppendStore } from "./event-ledger-append.js";

/** Internal transaction recovery layer for event-ledger command effects. */
export class EventRecoveryStore extends EventAppendStore {
  protected withCommandTransaction<LockedResult, Result>(
    callback: () => LockedResult,
    afterCommit: (result: LockedResult) => Result,
  ): Result {
    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw this.normalizeOperationalError(error, "begin command transaction");
    }

    let commitAttempted = false;
    try {
      const result = callback();
      commitAttempted = true;
      this.database.exec("COMMIT");
      return afterCommit(result);
    } catch (error) {
      const transactionEndedAfterCommitAttempt =
        commitAttempted && !this.database.isTransaction;
      let rollbackError: unknown;
      if (this.database.isTransaction) {
        try {
          this.database.exec("ROLLBACK");
        } catch (caughtRollbackError) {
          rollbackError = caughtRollbackError;
        }
      }
      if (transactionEndedAfterCommitAttempt || rollbackError !== undefined) {
        const causes = rollbackError === undefined ? [error] : [error, rollbackError];
        this.poison();
        throw new DurableStoreError(
          "OUTCOME_UNKNOWN",
          "the command outcome could not be proven; reopen and reconcile its receipt",
          { cause: new AggregateError(causes) },
        );
      }
      if (error instanceof DurableStoreError) {
        throw error;
      }
      throw this.normalizeOperationalError(error, "commit command effects");
    }
  }
}
