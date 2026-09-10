import type { SqliteEventStore } from "@moe/store";
import { backupFileHash } from "../backups/backup-ports.js";
import type { BackupPorts } from "../backups/backup-ports.js";
import type { EnvironmentCredentialSource } from "../environment/environment-projection.js";
import { readMigrationReceipt } from "../repository/migrations/migration-receipt.js";
import type { MigrationReceipt } from "../repository/migrations/migration-receipt.js";
import { readCurrentDeployReceipt } from "./deploy-ledger.js";
import { resolveDeployMigrationContext } from "./deploy-migration-context.js";

/**
 * WHICH DATABASE, AND WHICH DUMP — the two questions a rollback's schema restore has to answer
 * before it may touch anything, and nothing else.
 *
 * WHICH DATABASE is `resolveDeployMigrationContext`'s answer, COMPOSED and never re-derived. That
 * module's own header says it exists to be "RESOLVED ONCE AND REUSED BY THE REVERT" and warns that
 * reverting a DIFFERENT database than the migration applied is the worst outcome the slice can
 * produce. It reads the value through `readEnvironmentDelivery` — never `process.env`, never a
 * URL from the request payload — and it mints its refusals from a fixed table keyed by code, so
 * no detail can be built out of the value it just read. This module keeps that discipline: its own
 * table below is fixed prose per code, with no template and no interpolation.
 *
 * WHICH DUMP is the CURRENT deploy's PRE-MIGRATION dump, and this is the one decision in the file
 * that must not be re-litigated at a keyboard. `migrateWithBackup` dumps BEFORE it applies, so a
 * receipt's `backupRef` is the schema as it stood BEFORE that receipt's own migration:
 *
 *     prior ──L──▶ kept ──M──▶ current
 *                             └─ current.backupRef = the schema BEFORE M = what `kept` ran against
 *              └─ kept.backupRef = the schema BEFORE L — one step too far
 *
 * Restoring the KEPT receipt's own `backupRef` would discard the schema the kept deploy itself
 * applied. The dump is reached by the DURABLE JOIN and never by a filename, a hash, a newest-file
 * scan or an arbitrary request id: `deploy-command.ts:267` passes the deploy's `decisionId` as the
 * migration's `requestId`, so the current deploy receipt's `decisionId` is the deterministic key
 * `readMigrationReceipt` looks the dump up under.
 *
 * IT REFUSES, IT NEVER SUBSTITUTES. No current deploy receipt, no migration receipt for that
 * decision, an unreadable one, a null `backupRef`, or an artifact whose bytes disagree with what
 * the receipt recorded each answer with their own stable code and the layer that answered, and
 * each leave the database exactly as it was.
 */

/** The layer that answers for every refusal minted HERE. Forwarded refusals keep their own: the
 *  environment slice's SCOPE/KEY codes and the resolver's DAEMON_DEPLOY_ENGINE ones are facts
 *  about those layers, and restamping either would report a layer that did not refuse. */
export const ROLLBACK_RESTORE_STAMP = "DAEMON_COMMAND_SEAM" as const;

/**
 * FIXED PROSE PER CODE — no template, no interpolation, the same discipline
 * `DEPLOY_MIGRATION_CONTEXT_DETAILS` keeps and for the same reason: a detail assembled from the
 * caller's input, or from a value just read, is how a connection string reaches a durable surface.
 */
export const ROLLBACK_RESTORE_DETAILS = Object.freeze({
  DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE:
    "no database restoration port is bound to the selected deployment environment",
  DEPLOY_ROLLBACK_RESTORE_DEPLOY_UNKNOWN:
    "the environment has no current deploy receipt, so there is no schema state to restore",
  DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNKNOWN:
    "the current deploy recorded no migration, so no pre-migration dump is identified",
  DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNVERIFIED:
    "the current deploy's migration record could not be verified",
  DEPLOY_ROLLBACK_RESTORE_BACKUP_ABSENT:
    "the current deploy's migration recorded no backup to restore",
  DEPLOY_ROLLBACK_RESTORE_BACKUP_UNVERIFIED:
    "the recorded backup is absent or does not match the bytes its receipt recorded",
  DEPLOY_ROLLBACK_RESTORE_FAILED:
    "applying the recorded backup to the bound destination failed",
} as const);

export type RollbackRestoreCode = keyof typeof ROLLBACK_RESTORE_DETAILS;

export interface RollbackRestoreRefusal {
  readonly code: string;
  readonly detail: string;
  readonly layer: string;
  readonly ok: false;
}

/** `dump` is a FILE PATH and never a connection value, so it is safe on a durable surface. */
export interface RollbackRestoreApplied {
  readonly dump: string;
  readonly ok: true;
}

export type RollbackRestoreResult = RollbackRestoreApplied | RollbackRestoreRefusal;

/**
 * THE ANSWER TO BOTH QUESTIONS, CARRIED BUT NOT YET SPENT, so a caller may put durable fences
 * between the reading and the applying. `databaseUrl` IS THE CREDENTIAL: it exists here only to be
 * handed straight to the port, and must never be persisted, logged, or copied into an event, a
 * decision's result bytes or a refusal detail. `dump` is a path and is the only half of the pair
 * that may reach a durable surface.
 */
export interface RollbackRestoreResolved {
  readonly databaseUrl: string;
  readonly dump: string;
  readonly ok: true;
}

/**
 * HOST-SCOPED, forwarded from the composition root and never read from the request. `credential`
 * ABSENT means this daemon has no environment store at all, which is the plainest form of "no
 * destination is bound" there is — the same wiring condition `deploy-command.ts:260` uses to
 * decide whether a real migration is composable.
 */
export interface RollbackRestoreConfig {
  readonly credential: EnvironmentCredentialSource | undefined;
  readonly now: () => string;
  readonly projectId: string;
  readonly projectRoot: string | undefined;
  readonly store: SqliteEventStore;
  readonly workspace: string | undefined;
}

function refuse(code: RollbackRestoreCode): RollbackRestoreRefusal {
  return Object.freeze({ code, detail: ROLLBACK_RESTORE_DETAILS[code], layer: ROLLBACK_RESTORE_STAMP, ok: false as const });
}

/** `<absolute path>.sql@sha256:<64 hex>`, the exact form `migration-service.ts:64` writes and
 *  `migration-receipt.ts:69` validates. Split on the LAST marker so a path may contain anything. */
function splitBackupRef(ref: string): { readonly path: string; readonly sha256: string } | null {
  const marker = ref.lastIndexOf("@sha256:");
  if (marker <= 0) return null;
  const path = ref.slice(0, marker);
  const sha256 = ref.slice(marker + "@sha256:".length);
  return /^[a-f0-9]{64}$/u.test(sha256) ? { path, sha256 } : null;
}

/**
 * The destination for an admitted environment, or the refusal that stands in its place.
 *
 * The resolver's OWN `DEPLOY_MIGRATION_DATABASE_UNSET` — "the environment carries no database
 * variable" — IS the unbound-destination case by definition, so it answers under this seam's
 * `DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE`, which is the code and layer the unbound
 * environment has always refused with and which existing asserters pin. Its workspace codes and
 * every `ENV_*` refusal forwarded from `readEnvironmentDelivery` pass through UNCHANGED, code and
 * layer both, because those layers really did answer.
 */
function destination(
  config: RollbackRestoreConfig, environment: string, requestId: string, sha: string,
): { readonly databaseUrl: string; readonly ok: true } | RollbackRestoreRefusal {
  const credential = config.credential;
  if (credential === undefined) return refuse("DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE");
  const resolved = resolveDeployMigrationContext({
    credential, now: config.now, projectId: config.projectId,
    projectRoot: config.projectRoot, store: config.store, workspace: config.workspace,
  }, { environment, requestId, sha });
  if (resolved.ok) return { databaseUrl: resolved.input.databaseUrl, ok: true as const };
  if (resolved.code === "DEPLOY_MIGRATION_DATABASE_UNSET") {
    return refuse("DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE");
  }
  return Object.freeze({ code: resolved.code, detail: resolved.detail, layer: resolved.layer, ok: false as const });
}

/** The current deploy's pre-migration dump, verified against the bytes its receipt recorded. */
async function dumpToRestore(
  config: RollbackRestoreConfig, decisionId: string,
): Promise<{ readonly ok: true; readonly path: string } | RollbackRestoreRefusal> {
  let receipt: MigrationReceipt | null;
  try {
    receipt = readMigrationReceipt(config.store, config.projectId, decisionId);
  } catch {
    // Swallowed deliberately: `readMigrationReceipt` throws `MIGRATION_RECEIPT_INVALID@…`, and a
    // relayed message is a surface this module refuses to build out of anything it just read.
    return refuse("DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNVERIFIED");
  }
  if (receipt === null) return refuse("DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNKNOWN");
  if (receipt.backupRef === null) return refuse("DEPLOY_ROLLBACK_RESTORE_BACKUP_ABSENT");
  const split = splitBackupRef(receipt.backupRef);
  if (split === null) return refuse("DEPLOY_ROLLBACK_RESTORE_BACKUP_UNVERIFIED");
  let measured: string;
  try {
    measured = await backupFileHash(split.path);
  } catch {
    // An absent, empty or unreadable artifact is indistinguishable from a mismatched one at the
    // only point that matters: neither may be applied to a live database.
    return refuse("DEPLOY_ROLLBACK_RESTORE_BACKUP_UNVERIFIED");
  }
  if (measured !== split.sha256) return refuse("DEPLOY_ROLLBACK_RESTORE_BACKUP_UNVERIFIED");
  return { ok: true as const, path: split.path };
}

/**
 * THE READ HALF, and it moves nothing. Every refusal this module can mint about EVIDENCE — no
 * destination, no deploy, no migration, no verifiable artifact — is answered here, with the
 * database still untouched and no port in reach: this function does not take one.
 *
 * That is the whole reason the halves are separate. The caller admits a command between them, so
 * it needs a point where "can this restore be resolved at all?" is answered without having spent
 * the answer. A refusal from here has cost nothing and reserved nothing.
 */
export async function resolveRollbackRestore(
  config: RollbackRestoreConfig, environment: string,
): Promise<RollbackRestoreResolved | RollbackRestoreRefusal> {
  const current = readCurrentDeployReceipt(config.store, config.projectId, environment);
  // BOUNDNESS ANSWERS FIRST. An unwired daemon has no destination for ANY environment, which is a
  // fact about the wiring and not about this deployment's history — reporting a missing receipt
  // there would name the wrong cause and would change the code an unbound environment refuses with.
  if (config.credential === undefined) return refuse("DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE");
  if (current === null) return refuse("DEPLOY_ROLLBACK_RESTORE_DEPLOY_UNKNOWN");
  const bound = destination(config, environment, current.decisionId, current.sha);
  if (!bound.ok) return bound;
  const dump = await dumpToRestore(config, current.decisionId);
  if (!dump.ok) return dump;
  return Object.freeze({ databaseUrl: bound.databaseUrl, dump: dump.path, ok: true as const });
}

/**
 * THE EFFECT HALF, and it is the only code in this slice that moves a byte of anyone's data.
 *
 * ONE ATTEMPT PER ADMITTED COMMAND. `restoreDatabaseInto` is called exactly once here and a throw
 * is a refusal, never a retry. A refused apply is NOT durable: `backup-ports.ts` runs psql under
 * `--single-transaction` with `ON_ERROR_STOP=1`, so a failure rolls the reset and the dump back
 * together and leaves the schema as it stood. A FRESH command may therefore resolve and apply
 * again — a new decision with its own admission, not a retry of this one.
 *
 * What must never be re-run is a SUCCEEDED apply, durable and uncertain after a crash. That rule
 * is enforced where the certainty lives, in the command's `intent === null` fence: this function
 * cannot tell a first call from a second one.
 */
export async function applyResolvedRestore(
  resolved: RollbackRestoreResolved, ports: Pick<BackupPorts, "restoreDatabaseInto">,
): Promise<RollbackRestoreResult> {
  try {
    await ports.restoreDatabaseInto(resolved.databaseUrl, resolved.dump);
  } catch {
    // The port already collapses its own errors to `BACKUP_FAILED`; this catch is the second
    // fence, so nothing a pg client wrote can reach the refusal that leaves this module.
    return refuse("DEPLOY_ROLLBACK_RESTORE_FAILED");
  }
  // `databaseUrl` is deliberately dropped here: what leaves this module is the path alone.
  return Object.freeze({ dump: resolved.dump, ok: true as const });
}

/**
 * Resolves the destination and the dump, then applies ONE to the OTHER — in that order, so every
 * refusal above happens while the database is still untouched. KEPT AS THE COMPOSITION for callers
 * with no admission to interleave, and for the arms that exercise both halves through one entry.
 */
export async function applyRollbackRestore(
  config: RollbackRestoreConfig, environment: string, ports: Pick<BackupPorts, "restoreDatabaseInto">,
): Promise<RollbackRestoreResult> {
  const resolved = await resolveRollbackRestore(config, environment);
  if (!resolved.ok) return resolved;
  return applyResolvedRestore(resolved, ports);
}
