import type { DatabaseSync } from "node:sqlite";

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

/**
 * Handed to a {@link CommitApply} while the command transaction is still open.
 * The summary carries no positions; select them by `command_id` when needed.
 */
export interface CommitApplyContext {
  readonly database: DatabaseSync;
  readonly summary: CommitResult;
}

/**
 * Caller-supplied work durable with the event append or not at all. It must be
 * synchronous and must not end the transaction it is handed.
 */
export type CommitApply = (context: CommitApplyContext) => void;

function describeApplyFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    return "the commit apply threw a value that cannot be described";
  }
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  return typeof (value as { then?: unknown }).then === "function";
}

/** Runs a synchronous caller projection inside an already-open commit transaction. */
export function applyCommitWithinTransaction(
  database: DatabaseSync,
  apply: CommitApply,
  stored: StoredCommitResult,
): void {
  let returned: unknown;
  try {
    returned = apply({
      database,
      summary: toCommitResult(stored, "COMMITTED"),
    });
  } catch (error) {
    throw new DurableStoreError("PROJECTION_APPLY_FAILED", describeApplyFailure(error), {
      cause: error,
    });
  }
  if (isThenable(returned)) {
    throw new DurableStoreError(
      "PROJECTION_APPLY_FAILED",
      "the commit apply must be synchronous; this transaction cannot await a thenable",
    );
  }
}

/** Internal command transaction layer behind the public event-ledger facade. */
export class EventTransactionStore extends EventRecoveryStore {
  public commit(rawInput: CommitInput): CommitResult {
    return this.runCommandTransaction(rawInput, null);
  }

  /**
   * Commits the append and `apply` as one transaction. A throwing `apply`
   * rolls the whole append back as PROJECTION_APPLY_FAILED; a replayed
   * command never reaches it.
   */
  public commitWithApply(rawInput: CommitInput, apply: CommitApply): CommitResult {
    return this.runCommandTransaction(rawInput, apply);
  }

  private runCommandTransaction(
    rawInput: CommitInput,
    apply: CommitApply | null,
  ): CommitResult {
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
      () => this.resolveCommand(input, requestSha256, apply),
      (outcome) => toCommitResult(outcome.stored, outcome.disposition),
    );
  }

  private resolveCommand(
    input: SnapshotCommitInput,
    requestSha256: string,
    apply: CommitApply | null,
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
    const stored = this.writeCommitEffects(input, requestSha256, previousVersion);
    if (apply !== null) {
      applyCommitWithinTransaction(this.database, apply, stored);
    }
    return { disposition: "COMMITTED", stored };
  }
}
