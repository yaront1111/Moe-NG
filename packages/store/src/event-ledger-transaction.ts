import {
  CommandIdConflictError,
  DurableStoreError,
  ExpectedVersionConflictError,
} from "./store-contracts.js";
import type { CommitInput, CommitResult } from "./store-contracts.js";
import { identifyCommandRequest } from "./store-digests.js";
import {
  assertExternalCommitIdentifiers,
  snapshotCommitInput,
} from "./store-input.js";
import type {
  SnapshotCommitInput,
  StoredCommitResult,
} from "./store-internals.js";
import { toCommitResult } from "./store-rows.js";
import { EventRecoveryStore } from "./event-ledger-recovery.js";

interface TransactionOutcome {
  readonly disposition: CommitResult["disposition"];
  readonly stored: StoredCommitResult;
}

/** Internal command transaction layer behind the public event-ledger facade. */
export class EventTransactionStore extends EventRecoveryStore {
  public commit(rawInput: CommitInput): CommitResult {
    this.requireOpen();
    if (this.projectId === null || !this.writeProjectAsserted) {
      throw new DurableStoreError(
        "PROJECT_SCOPE_REQUIRED",
        "durable command effects require an explicitly project-asserted store handle",
      );
    }
    const input = snapshotCommitInput(rawInput);
    assertExternalCommitIdentifiers(input);
    const requestSha256 = identifyCommandRequest(input);
    return this.withCommandTransaction(
      () => this.resolveCommand(input, requestSha256),
      (outcome) => toCommitResult(outcome.stored, outcome.disposition),
    );
  }

  private resolveCommand(
    input: SnapshotCommitInput,
    requestSha256: string,
  ): TransactionOutcome {
    this.assertDurableProjectBinding();
    const receipt = this.loadReceipt(input.commandId);
    if (receipt !== null) {
      if (receipt.requestSha256 !== requestSha256) {
        throw new CommandIdConflictError(input.commandId);
      }
      if (receipt.aggregateId !== input.aggregateId) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          `command receipt ${JSON.stringify(input.commandId)} does not match its key`,
        );
      }
      return { disposition: "REPLAYED", stored: receipt };
    }

    const previousVersion = this.assertAggregateTail(input.aggregateId);
    if (previousVersion !== input.expectedVersion) {
      throw new ExpectedVersionConflictError(
        input.aggregateId,
        input.expectedVersion,
        previousVersion,
      );
    }
    return {
      disposition: "COMMITTED",
      stored: this.writeCommitEffects(input, requestSha256, previousVersion),
    };
  }
}
