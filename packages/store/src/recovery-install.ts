import { DurableStoreError } from "./store-contracts.js";
import { DecisionTransactionStore } from "./decision-ledger-transaction.js";
import {
  decodeRecoveryBinding,
  encodeRecoveryBinding,
  isRecoveryBindingSlot,
} from "./recovery-install-codec.js";
import {
  RECOVERY_BINDING_FIELD_INVALID,
  RECOVERY_BINDING_ROW_DIVERGED,
  RECOVERY_INSTALL_INCARNATION_CONFLICT,
  RECOVERY_INSTALL_SCOPE_REQUIRED,
} from "./recovery-install-contracts.js";
import type {
  RecoveryBindingEncoded,
  RecoveryBindingReadResult,
  RecoveryBindingRecord,
  RecoveryBindingSlot,
  RecoveryInstallResult,
} from "./recovery-install-contracts.js";
import { requireRowString } from "./store-rows.js";

const SELECT_BINDING_SQL = `
  SELECT slot, incarnation_ref, key_epoch_ref, binding_codec_version, binding_digest, binding_bytes
  FROM recovery_bindings
  WHERE slot = ?
`;
const DELETE_BINDING_SQL = "DELETE FROM recovery_bindings WHERE slot = ?";
const INSERT_BINDING_SQL = `
  INSERT INTO recovery_bindings (
    slot,
    incarnation_ref,
    key_epoch_ref,
    binding_codec_version,
    binding_digest,
    binding_bytes,
    installed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`;

/** SQLITE_CONSTRAINT_UNIQUE and SQLITE_CONSTRAINT_PRIMARYKEY, measured on node:sqlite. */
const UNIQUE_CONSTRAINT_CODES = Object.freeze([2067, 1555]);

function isUniqueConstraintViolation(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const errcode: unknown = (error as Record<string, unknown>)["errcode"];
  return typeof errcode === "number" && UNIQUE_CONSTRAINT_CODES.includes(errcode);
}

interface InstallAttempt {
  commitAttempted: boolean;
}

function rowMatchesBinding(
  row: Record<string, unknown>,
  querySlot: RecoveryBindingSlot,
  binding: RecoveryBindingRecord,
): boolean {
  return (
    binding.slot === querySlot &&
    requireRowString(row, "slot") === binding.slot &&
    requireRowString(row, "incarnation_ref") === binding.incarnationRef &&
    requireRowString(row, "key_epoch_ref") === binding.keyEpochRef &&
    requireRowString(row, "binding_codec_version") === binding.bindingCodecVersion
  );
}

/**
 * The atomic recovery-install transaction. One BEGIN IMMEDIATE covers clearing
 * the slot and writing its replacement, so an install that fails part-way
 * leaves the PRIOR binding intact rather than an empty or mixed slot. It sits
 * in the ledger class chain rather than beside it because SqliteEventStore
 * keeps its database handle private, and @moe/store must never reach upward for
 * one.
 */
export class RecoveryInstallStore extends DecisionTransactionStore {
  public installRecoveryBinding(input: unknown): RecoveryInstallResult {
    this.requireOpen();
    // Scope is asked BEFORE the codec, so a caller who may not write cannot use
    // refusal codes to learn whether their record was well formed.
    if (this.projectId === null || !this.writeProjectAsserted) {
      return RECOVERY_INSTALL_SCOPE_REQUIRED;
    }
    const encoded = encodeRecoveryBinding(input);
    if (!encoded.ok) return encoded;
    return this.runInstallTransaction(encoded);
  }

  /**
   * Reading is deliberately NOT project-scoped. Only public bytes are ever
   * anchored — the recovery private key dies with its process by design — so an
   * inspection handle may read a slot it may not write.
   */
  public readRecoveryBinding(slot: unknown): RecoveryBindingReadResult {
    this.requireOpen();
    if (!isRecoveryBindingSlot(slot)) return RECOVERY_BINDING_FIELD_INVALID;
    return this.readOperation<RecoveryBindingReadResult>("read recovery binding", () => {
      const row = this.database.prepare(SELECT_BINDING_SQL).get(slot);
      if (row === undefined) {
        return Object.freeze({ ok: true as const, outcome: "ABSENT" as const, slot });
      }
      const bindingDigest = requireRowString(row, "binding_digest");
      const decoded = decodeRecoveryBinding(row["binding_bytes"], bindingDigest);
      if (!decoded.ok) return decoded;
      // The decoded bytes are the authority; every column that duplicates them
      // is only an index into them, and a row whose index disagrees with its
      // own content is refused rather than reconciled toward either side.
      if (!rowMatchesBinding(row, slot, decoded.binding)) return RECOVERY_BINDING_ROW_DIVERGED;
      return Object.freeze({
        binding: decoded.binding,
        bindingDigest,
        ok: true as const,
        outcome: "FOUND" as const,
      });
    });
  }

  private runInstallTransaction(encoded: RecoveryBindingEncoded): RecoveryInstallResult {
    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw this.normalizeOperationalError(error, "begin recovery install transaction");
    }
    const attempt: InstallAttempt = { commitAttempted: false };
    try {
      this.assertDurableProjectBinding();
      this.writeBindingUnderLock(encoded);
      attempt.commitAttempted = true;
      this.database.exec("COMMIT");
      return Object.freeze({
        binding: encoded.binding,
        bindingDigest: encoded.digest,
        ok: true as const,
        outcome: "INSTALLED" as const,
      });
    } catch (error) {
      const unprovable = this.releaseInstallTransaction(error, attempt.commitAttempted);
      if (unprovable !== null) throw unprovable;
      if (isUniqueConstraintViolation(error)) return RECOVERY_INSTALL_INCARNATION_CONFLICT;
      if (error instanceof DurableStoreError) throw error;
      throw this.normalizeOperationalError(error, "commit recovery install");
    }
  }

  private writeBindingUnderLock(encoded: RecoveryBindingEncoded): void {
    const { binding } = encoded;
    this.database.prepare(DELETE_BINDING_SQL).run(binding.slot);
    this.database
      .prepare(INSERT_BINDING_SQL)
      .run(
        binding.slot,
        binding.incarnationRef,
        binding.keyEpochRef,
        binding.bindingCodecVersion,
        encoded.digest,
        encoded.bytes,
        binding.installedAt,
      );
  }

  /**
   * Returns a fault when the transaction's outcome cannot be proven, and null
   * when it was cleanly rolled back. A rollback that itself fails, or a commit
   * that ended the transaction before it threw, leaves durable state UNKNOWN —
   * which quarantines the handle rather than reporting a benign refusal.
   */
  private releaseInstallTransaction(
    error: unknown,
    commitAttempted: boolean,
  ): DurableStoreError | null {
    const transactionEndedAfterCommitAttempt = commitAttempted && !this.database.isTransaction;
    let rollbackError: unknown;
    if (this.database.isTransaction) {
      try {
        this.database.exec("ROLLBACK");
      } catch (caughtRollbackError) {
        rollbackError = caughtRollbackError;
      }
    }
    if (!transactionEndedAfterCommitAttempt && rollbackError === undefined) {
      return null;
    }
    const causes = rollbackError === undefined ? [error] : [error, rollbackError];
    this.poison();
    return new DurableStoreError(
      "OUTCOME_UNKNOWN",
      "the recovery binding install could not be proven; reopen and read the slot back",
      { cause: new AggregateError(causes) },
    );
  }
}
