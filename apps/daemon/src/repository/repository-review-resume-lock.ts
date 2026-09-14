import { lstatSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SqliteEventStore } from "@moe/store";
import { recoveryRefusal } from "./repository-recovery-contracts.js";
import type { RepositoryRecoveryResult } from "./repository-recovery-contracts.js";

/** The real project writer lock fences daemon writes while the reservation CAS commits. */
export function withReviewResumeStoreLock<T>(input: { readonly storeId: string; readonly store: SqliteEventStore;
  readonly dataVersion: number; readonly horizon: bigint }, commit: () => RepositoryRecoveryResult<T>): RepositoryRecoveryResult<T> {
  let database: DatabaseSync | null = null;
  try {
    const stat = lstatSync(input.storeId);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync.native(input.storeId) !== input.storeId) {
      return recoveryRefusal("REPOSITORY_REVIEW_STORE_INVALID");
    }
    database = new DatabaseSync(input.storeId);
    database.exec("PRAGMA busy_timeout=0"); database.exec("BEGIN IMMEDIATE");
    if (input.store.readCommandDecisionCacheVersion() !== input.dataVersion || input.store.readEventHorizon() !== input.horizon) {
      return recoveryRefusal("REPOSITORY_REVIEW_EVIDENCE_CHANGED");
    }
    return commit();
  } catch { return recoveryRefusal("REPOSITORY_REVIEW_STORE_BUSY"); }
  finally { if (database !== null) { try { database.exec("ROLLBACK"); } finally { database.close(); } } }
}
