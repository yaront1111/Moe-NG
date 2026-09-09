import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RepositoryExecutionIdentity } from "./repository-execution-contracts.js";
import { resolveRepositoryExecutionIdentity } from "./repository-execution-identity.js";
import { recoveryDigest } from "./repository-recovery-facts.js";
import { recoveryRefusal } from "./repository-recovery-contracts.js";
import type { RepositoryRecoveryResult } from "./repository-recovery-contracts.js";
/** Read the receipt committed atomically with release, even when another logical owner is now held. */
export function readRepositoryRecoveryReplay(identity: RepositoryExecutionIdentity, input: { readonly projectId: string;
  readonly principalId: string; readonly commandId: string; readonly requestSha256: string; readonly ownerDigest: string;
  readonly expectedRevision: number }): RepositoryRecoveryResult<{ released: boolean }> {
  let database: DatabaseSync | null = null;
  try {
    const resolved = resolveRepositoryExecutionIdentity(identity.root);
    if (!resolved.ok || JSON.stringify(resolved.identity) !== JSON.stringify(identity)) return recoveryRefusal("REPOSITORY_RECOVERY_IDENTITY_UNKNOWN");
    const path = join(identity.gitDirectory, "moe-repository-execution.sqlite");
    if (!existsSync(path)) return recoveryRefusal("REPOSITORY_RECOVERY_RECEIPT_UNKNOWN");
    database = new DatabaseSync(path); database.exec("PRAGMA busy_timeout=1000"); database.exec("BEGIN");
    if (database.prepare("PRAGMA user_version").get()?.["user_version"] !== 1
      || database.prepare("SELECT identity_json FROM binding WHERE singleton=1").get()?.["identity_json"] !== JSON.stringify(identity)) {
      return recoveryRefusal("REPOSITORY_RECOVERY_RECEIPT_UNKNOWN");
    }
    if (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recovery_decisions'").get() === undefined) return { ok: true, released: false };
    const row = database.prepare("SELECT request_json,result_json FROM recovery_decisions WHERE decision_key=?")
      .get(recoveryDigest([input.projectId, input.principalId, input.commandId]));
    if (row === undefined) return { ok: true, released: false };
    if (typeof row["request_json"] !== "string" || typeof row["result_json"] !== "string") return recoveryRefusal("REPOSITORY_RECOVERY_RECEIPT_UNKNOWN");
    const request = JSON.parse(row["request_json"]) as Record<string, unknown>;
    if (request["owner"] !== input.ownerDigest || request["requestSha256"] !== input.requestSha256
      || request["expectedRevision"] !== input.expectedRevision || row["result_json"] !== '{"released":true}') {
      return recoveryRefusal("REPOSITORY_RECOVERY_APPROVAL_CONFLICT");
    }
    return { ok: true, released: true };
  } catch { return recoveryRefusal("REPOSITORY_RECOVERY_RECEIPT_UNKNOWN"); }
  finally { if (database !== null) { try { database.exec("ROLLBACK"); } finally { database.close(); } } }
}
