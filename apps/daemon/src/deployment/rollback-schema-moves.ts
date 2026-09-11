import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";
import { MIGRATION_RECEIPT_COMMAND_KIND, MIGRATION_RECEIPT_PRINCIPAL, decodeMigrationReceiptBytes, readMigrationReceipt }
  from "../repository/migrations/migration-receipt.js";

/**
 * THE ENVIRONMENT'S SCHEMA HISTORY, IN THE ORDER THE SCHEMA ACTUALLY MOVED.
 *
 * `rollback-preflight.ts` used to reconstruct this from the DEPLOY LEDGER alone, and that was
 * structurally blind in two directions at once:
 *
 *   1. A `deployment.migrate_down` records its migration receipt under its OWN request id and
 *      writes NO deploy receipt, so a revert could never appear among a target's successors. The
 *      walk stepped straight over it: A ─▶ B(migrates) ─▶ migrate_down(reverts B) ─▶ D(migrates)
 *      and a restoring rollback to B selected D's dump, which holds the schema A ran against.
 *   2. A receipt is a REPORT, and its ledger position is the REPORT's position, not the effect's.
 *      A restoring rollback writes its marker the moment the dump lands and only then runs health
 *      polling and the proxy flip, so an ordinary deploy can commit its whole receipt inside that
 *      window — the rollback guard fences rollbacks, not deploys. Deploy receipts then read
 *      [C, D, R], the marker is never reached, and a rollback to C selects D's post-restore dump.
 *
 * THE FIX FOR BOTH IS THE SAME: stop asking the deploy ledger what moved the schema, and read the
 * DECISION LEDGER — which carries deploys, migration receipts and restore markers in one total
 * order — keyed on the position each record COMMITTED at.
 *
 * ORDER COMES FROM `decision_position`, NEVER FROM `decidedAt`. `readCommandDecisionsAfter` pages
 * by the stored position (`packages/store/src/decision-read-model.ts`), which is monotonic in
 * commit order, so the pages arrive in the order the effects landed and this module never sorts.
 * `decidedAt` is a wall clock: every rollback fixture in this directory runs a constant clock, so
 * sorting by it ties on every record and falls back to whatever the scan produced, and production
 * can tie inside a millisecond or step backwards across a clock adjustment.
 *
 * WHAT COUNTS AS A MOVE, and the distinction that matters is whether a DUMP was taken:
 *   - a migration receipt carrying a `backupRef` is a SNAPSHOT of the schema as it stood before
 *     that receipt's own effect, whatever happened afterwards — for a REVERTED receipt that is
 *     the state before THE REVERT, which is exactly what a rollback to the deploy before the
 *     revert wants;
 *   - a migration receipt with no `backupRef` moved the schema with no record of what came
 *     before, and a later dump is a LATER state that would destroy more than the rollback asked
 *     for, so it refuses rather than being skipped;
 *   - a restore marker replaced the schema with an older dump and kept NO copy of what it
 *     overwrote, so it refuses too;
 *   - a decision that will not decode is a move this module cannot read, and reading an unreadable
 *     record as "nothing happened" is the unsafe direction, so it refuses as well.
 *
 * COST, stated rather than discovered by a reviewer: one full walk of the project's decision
 * ledger, plus one keyed read per migration receipt to verify it through the production reader.
 * That is acceptable because a restoring rollback is rare. Do not put this on a hot read, and do
 * not cache it across commands — a cached history is a history that can be stale in the one
 * direction that destroys a database.
 */

/**
 * THE RESTORE MARKER'S DECISION PRINCIPAL. `rollback-command.ts` WRITES the marker under it, on
 * the rollback's own command id and only once a restore has really been applied; this module
 * READS it to learn that a rollback moved the schema. It lives HERE, in the leaf both of them can
 * reach, and `rollback-preflight.ts` re-exports it so the command's existing import is unchanged.
 */
export const ROLLBACK_RESTORE_PRINCIPAL = "daemon:rollback-restore" as const;

/** One page of the decision ledger, sized as `deploy-ledger.ts` sizes its own walk. */
const LEDGER_PAGE_SIZE = 200;

/**
 * WHAT THE WALK MUST ANSWER when this record is the FIRST move after the rollback's target.
 * `SNAPSHOT` is the only one that yields a dump; every other value is a refusal code the caller
 * returns verbatim, so a code renamed here without the caller's union changing is a type error
 * there rather than a silent behaviour change.
 */
export type SchemaMoveVerdict =
  | "DEPLOY_ROLLBACK_RESTORE_BACKUP_ABSENT"
  | "DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNVERIFIED"
  | "DEPLOY_ROLLBACK_RESTORE_SCHEMA_OVERWRITTEN"
  | "SNAPSHOT";

export interface SchemaMove {
  /** The stored `decision_position` this record committed at — the ONLY ordering key. */
  readonly position: bigint;
  readonly verdict: SchemaMoveVerdict;
  /**
   * THE MIGRATION RECEIPT'S REQUEST ID, which is what `readMigrationReceipt` is keyed by — so for
   * a `SNAPSHOT` it is also the key the dump resolves under. Null for a restore marker and for a
   * record whose bytes would not decode, neither of which names a receipt.
   *
   * It is carried on EVERY migration-derived move, not only on snapshots, because the caller has
   * to recognise the ROLLBACK TARGET'S OWN migration whatever verdict it carries: that receipt's
   * dump is the schema as it stood BEFORE the target migrated, one deployment too far back, and
   * selecting it would restore an older schema under the target's image.
   */
  readonly requestId: string | null;
}

export interface SchemaMoveScope {
  /** The environment whose history is being read. */
  readonly environment: string;
  /**
   * WHICH ENVIRONMENT A ROLLBACK COMMAND BELONGS TO, or null when the store cannot say.
   *
   * A restore marker's key is `{commandId, ROLLBACK_RESTORE_PRINCIPAL, projectId}` and carries no
   * environment at all, so it can only be placed through the rollback's own deploy receipt. The
   * caller supplies that lookup because the deploy ledger is the authority on which environment a
   * receipt belongs to, and re-deriving that here would be a second, drifting copy of it.
   *
   * A `null` answer — a rollback that applied its restore and then died before its receipt landed
   * — is treated as a move in THIS environment. Reading an applied restore as nothing-happened is
   * the direction that pairs an old image with a newer schema.
   */
  readonly environmentOfRollback: (commandId: string) => string | null;
}

const move = (position: bigint, verdict: SchemaMoveVerdict, requestId: string | null): SchemaMove =>
  Object.freeze({ position, requestId, verdict });

/**
 * A MIGRATION RECEIPT DECISION, CLASSIFIED — or null when it moved nothing in this environment.
 *
 * The decision's bytes are decoded only to learn WHICH receipt this is; the receipt itself is
 * then read back through `readMigrationReceipt`, the production reader, so the identity rules
 * (kind, disposition, aggregate id, receipt id derivation) are enforced in ONE place and this
 * module cannot drift into a second, laxer copy of them.
 */
function classifyMigration(
  store: SqliteEventStore, projectId: string, environment: string, decision: CommandDecisionRecord,
): SchemaMove | null {
  const decoded = decodeMigrationReceiptBytes(decision.resultBytes);
  // UNREADABLE AND THEREFORE UNPLACEABLE: bytes that will not decode carry no environment, so this
  // record cannot be shown to belong elsewhere. It refuses in every environment of this project.
  if (!decoded.ok) return move(decision.decisionPosition, "DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNVERIFIED", null);
  let receipt;
  try {
    receipt = readMigrationReceipt(store, projectId, decoded.receipt.requestId);
  } catch {
    // Swallowed deliberately: `readMigrationReceipt` throws `MIGRATION_RECEIPT_INVALID@…`, and a
    // relayed message is a surface built out of a value just read. The CODE says what happened.
    // The request id survives: the bytes decoded, so the caller can still tell whether this
    // unverifiable record is the target's OWN migration rather than a successor's.
    return move(decision.decisionPosition, "DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNVERIFIED",
      decoded.receipt.requestId);
  }
  // A decision whose bytes decode but which the reader does not recognise under this request id is
  // not a receipt this daemon wrote. It records no schema move.
  if (receipt === null || receipt.environment !== environment) return null;
  // A DUMP IS A DUMP whatever the outcome that carried it: `migrateWithBackup` and the revert
  // service both take theirs BEFORE they touch the schema, and a REFUSED receipt that still holds
  // a `backupRef` — the revert that committed and then failed its post-revert check — snapshotted
  // a real state. Walking past it to a later dump is the data-loss direction.
  if (receipt.backupRef !== null) return move(decision.decisionPosition, "SNAPSHOT", receipt.requestId);
  // NO DUMP, AND THIS IS THE ONE PLACE THE DELIVERED RULE IS DELIBERATELY WIDER THAN THE PLAN.
  //
  // `decodeMigrationReceiptBytes` admits a null `backupRef` ONLY on a REFUSED receipt
  // (`migration-receipt.ts:88` rejects an APPLIED or REVERTED one that carries none), so the
  // "APPLIED or REVERTED with no backupRef" case the plan asks to refuse is unreachable, and its
  // companion instruction — SKIP a REFUSED receipt with no backupRef — would make
  // DEPLOY_ROLLBACK_RESTORE_BACKUP_ABSENT unreachable from this walk altogether. That code is a
  // rule the parent row's QA required to survive, and `rollback-restore.test.ts` arm (c) pins it
  // green today on exactly this shape. Refusing here is also the fail-closed direction: walking on
  // reaches a LATER dump, which is a LATER state, and restoring it destroys strictly more than the
  // rollback asked for.
  //
  // KNOWN AND DISCLOSED COST: a migration that refused BEFORE taking its dump left the schema
  // standing, so refusing on it is a FALSE refusal for a rollback that could have been served by a
  // later deploy's dump. It costs an operator a refusal; the other direction costs them a database.
  return move(decision.decisionPosition, "DEPLOY_ROLLBACK_RESTORE_BACKUP_ABSENT", receipt.requestId);
}

/**
 * EVERY SCHEMA MOVE IN ONE ENVIRONMENT, oldest first, from ONE walk of the decision ledger.
 *
 * The list is returned whole rather than filtered to a target's successors so that the caller — a
 * single loop over positions greater than the target's — is the only place that knows what
 * "after" means. Positions are opaque here: this module never compares one to another.
 */
export function readEnvironmentSchemaMoves(
  store: SqliteEventStore, projectId: string, scope: SchemaMoveScope,
): readonly SchemaMove[] {
  const moves: SchemaMove[] = [];
  // One row per migration REQUEST: a replayed decision must not double the history, the same
  // reason `readDeployLedger` keeps a `seen` set over receipt ids.
  const seen = new Set<string>();
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, LEDGER_PAGE_SIZE);
    for (const decision of page.items) {
      if (decision.key.projectId !== projectId) continue;
      if (decision.key.principalId === ROLLBACK_RESTORE_PRINCIPAL) {
        // EXISTENCE IS THE WHOLE TEST, exactly as the marker check it replaces: nothing about the
        // record is filtered, not even its disposition, because a marker that exists at all means
        // a dump was handed to the restore port.
        const of = scope.environmentOfRollback(decision.key.commandId);
        if (of === null || of === scope.environment) {
          moves.push(move(decision.decisionPosition, "DEPLOY_ROLLBACK_RESTORE_SCHEMA_OVERWRITTEN", null));
        }
        continue;
      }
      if (decision.key.principalId !== MIGRATION_RECEIPT_PRINCIPAL
        || decision.commandKind !== MIGRATION_RECEIPT_COMMAND_KIND) continue;
      if (seen.has(decision.key.commandId)) continue;
      seen.add(decision.key.commandId);
      const classified = classifyMigration(store, projectId, scope.environment, decision);
      if (classified !== null) moves.push(classified);
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  // NOT SORTED, AND THAT IS THE POINT. The pages arrive in ascending `decision_position`, which is
  // commit order; a sort here would need a key, and the only other key available is the wall clock
  // this module exists to stop trusting.
  return Object.freeze(moves);
}
