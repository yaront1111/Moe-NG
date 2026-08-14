import { DurableStoreError } from "./store-contracts.js";
import {
  decodeRecoveryBinding,
  encodeRecoveryBinding,
} from "./recovery-install-codec.js";
import {
  INSERT_BINDING_SQL,
  RecoveryInstallStore,
  SELECT_BINDING_SQL,
  isUniqueConstraintViolation,
  rowMatchesBinding,
} from "./recovery-install.js";
import {
  RECOVERY_BINDING_ROW_DIVERGED,
  RECOVERY_INSTALL_INCARNATION_CONFLICT,
  RECOVERY_INSTALL_SCOPE_REQUIRED,
  RECOVERY_INSTALL_TRANSACTION_LAYER,
} from "./recovery-install-contracts.js";
import type { RecoveryBindingEncoded } from "./recovery-install-contracts.js";
import {
  RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT,
  RECOVERY_INITIAL_INSTALL_PENDING_PRESENT,
  RECOVERY_INITIAL_INSTALL_SLOT_UNSUPPORTED,
} from "./recovery-initial-install-contracts.js";
import type { RecoveryInitialInstallResult } from "./recovery-initial-install-contracts.js";
import { requireRowString } from "./store-rows.js";

/**
 * The five tables below are the AUTHORITATIVE history of this store: business
 * decisions, their receipts, the events they produced and the outbox rows those
 * events emitted, plus the aggregate heads that index them. Any one of them
 * being non-empty means the store has already served a real workload, and
 * genesis identity — which claims to be the FIRST binding this store ever had —
 * can no longer honestly be minted here.
 *
 * Deliberately excluded:
 *  - projections, inbox_receipts, event_subscriptions, cursor_generations are
 *    DERIVED. They can be dropped and rebuilt from the authoritative tables, so
 *    a row there is not independent evidence of history.
 *  - store_metadata and store_project_binding always carry bootstrap rows on a
 *    brand new database. Counting them would make every store non-pristine and
 *    the guard would refuse unconditionally, which is the same as no guard.
 *
 * command_decisions is scoped `WHERE project_id = ?` because a decision is
 * project-owned; the remaining four carry no project column, and their contents
 * belong to this store's single bound project by construction. All five legs
 * are read even though foreign keys are forced ON at open (so receipts are
 * implied by decisions/events/outbox in a consistent database): a foreign
 * writer with foreign_keys off can leave an orphan, and a pristine claim that
 * relies on the constraint holding is a claim about the constraint, not the
 * data.
 */
const HISTORY_PRESENT_SQL = `
  SELECT (
    EXISTS (SELECT 1 FROM command_decisions WHERE project_id = ?)
    OR EXISTS (SELECT 1 FROM command_receipts)
    OR EXISTS (SELECT 1 FROM domain_events)
    OR EXISTS (SELECT 1 FROM aggregate_heads)
    OR EXISTS (SELECT 1 FROM outbox_messages)
  ) AS present
`;

/**
 * The genesis install: one BEGIN IMMEDIATE that both PROVES the store pristine
 * and writes the binding. There is no read-then-write window and no
 * caller-asserted pristine flag — every guard reads the same write lock the
 * INSERT holds, so two concurrent handles that both observed an absent slot
 * cannot both commit. It never DELETEs and never replaces: an already-bound
 * store yields CURRENT (the existing winner) instead.
 */
export class RecoveryInitialInstallStore extends RecoveryInstallStore {
  public installInitialRecoveryBinding(input: unknown): RecoveryInitialInstallResult {
    this.requireOpen();
    // Scope is asked BEFORE the codec, matching the replacement installer, so a
    // caller who may not write cannot probe whether their record was well formed.
    // The narrowed id is threaded downward rather than re-read from `this`: bound
    // as NULL, `WHERE project_id = ?` matches no row and the decisions leg would
    // go silently vacuous instead of failing.
    const projectId = this.projectId;
    if (projectId === null || !this.writeProjectAsserted) {
      return RECOVERY_INSTALL_SCOPE_REQUIRED;
    }
    const encoded = encodeRecoveryBinding(input);
    if (!encoded.ok) return encoded;
    // Genesis mints the live identity, never a staged successor.
    if (encoded.binding.slot !== "ACTIVE") return RECOVERY_INITIAL_INSTALL_SLOT_UNSUPPORTED;
    return this.runInitialInstallTransaction(encoded, projectId);
  }

  private runInitialInstallTransaction(
    encoded: RecoveryBindingEncoded,
    projectId: string,
  ): RecoveryInitialInstallResult {
    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw this.normalizeOperationalError(error, "begin genesis recovery install transaction");
    }
    let commitAttempted = false;
    try {
      this.assertDurableProjectBinding();
      const blocked = this.readPristineBlocker(projectId);
      if (blocked !== null) {
        // A refusal is not a fault: release the lock cleanly and report it.
        this.database.exec("ROLLBACK");
        return blocked;
      }
      this.insertBindingUnderLock(encoded);
      commitAttempted = true;
      this.database.exec("COMMIT");
      return Object.freeze({
        binding: encoded.binding,
        bindingDigest: encoded.digest,
        ok: true as const,
        outcome: "INSTALLED" as const,
      });
    } catch (error) {
      const unprovable = this.releaseInstallTransaction(error, commitAttempted);
      if (unprovable !== null) throw unprovable;
      if (isUniqueConstraintViolation(error)) return RECOVERY_INSTALL_INCARNATION_CONFLICT;
      if (error instanceof DurableStoreError) throw error;
      throw this.normalizeOperationalError(error, "commit genesis recovery install");
    }
  }

  /** Null means pristine and unbound; anything else is the caller's answer. */
  private readPristineBlocker(projectId: string): RecoveryInitialInstallResult | null {
    if (this.database.prepare(SELECT_BINDING_SQL).get("PENDING") !== undefined) {
      return RECOVERY_INITIAL_INSTALL_PENDING_PRESENT;
    }
    const history = this.database.prepare(HISTORY_PRESENT_SQL).get(projectId);
    if (Number((history as Record<string, unknown>)["present"]) !== 0) {
      return RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT;
    }
    const active = this.database.prepare(SELECT_BINDING_SQL).get("ACTIVE");
    if (active === undefined) return null;
    return this.currentWinner(active);
  }

  /**
   * The DECODED bytes are the authority. An incumbent whose bytes cannot be
   * read, or whose indexed columns disagree with them, is refused whole — never
   * reconciled and never overwritten, because an unreadable row is exactly the
   * case where "just install over it" would destroy the only evidence.
   */
  private currentWinner(row: Record<string, unknown>): RecoveryInitialInstallResult {
    const bindingDigest = requireRowString(row, "binding_digest");
    const decoded = decodeRecoveryBinding(row["binding_bytes"], bindingDigest);
    if (!decoded.ok) return decoded;
    if (!rowMatchesBinding(row, "ACTIVE", decoded.binding)) return RECOVERY_BINDING_ROW_DIVERGED;
    return Object.freeze({
      authority: "NONE" as const,
      binding: decoded.binding,
      bindingDigest,
      code: "RECOVERY_INITIAL_INSTALL_ALREADY_BOUND" as const,
      layer: RECOVERY_INSTALL_TRANSACTION_LAYER,
      ok: true as const,
      outcome: "CURRENT" as const,
    });
  }

  /** INSERT alone: no DELETE, no INSERT OR REPLACE, no UPSERT. */
  private insertBindingUnderLock(encoded: RecoveryBindingEncoded): void {
    const { binding } = encoded;
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
}
