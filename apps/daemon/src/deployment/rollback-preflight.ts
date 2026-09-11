import type { SqliteEventStore } from "@moe/store";
import { readDeployLedger } from "./deploy-ledger.js";
import type { EnvironmentDeployState } from "./deploy-ledger.js";
import type { DeployPorts, DeployRunResult } from "./deploy-ports.js";
import { DEPLOY_DOCKER_UNAVAILABLE, DEPLOY_ENGINE_PRINCIPAL_ID, DEPLOY_ENGINE_STAMP }
  from "./deploy-receipt-contracts.js";
import type { DeployReceiptV1 } from "./deploy-receipt-contracts.js";
import { readEnvironmentSchemaMoves } from "./rollback-schema-moves.js";
import type { SchemaMove } from "./rollback-schema-moves.js";

/**
 * THE TWO QUESTIONS A ROLLBACK ANSWERS BEFORE IT RESERVES ANYTHING: which deploy's dump restores
 * the schema the TARGET image expects, and is this host usable at all. Both are pure reads — no
 * durable write, no container, no database — so a refusal from here has cost nothing.
 *
 * WHICH DUMP, and this is the decision that must not be re-litigated at a keyboard.
 * `migrateWithBackup` dumps BEFORE it applies, so a receipt's `backupRef` is the schema as it
 * stood BEFORE that receipt's OWN migration:
 *
 *     target ──M──▶ next ──N──▶ current
 *              │           └─ current.backupRef = the schema before N = what `next` ran against
 *              └─ next.backupRef = the schema before M = WHAT THE TARGET RAN AGAINST ◀── this one
 *        └─ target.backupRef = the schema before the deploy BEFORE the target — one step too far
 *
 * So the dump that restores the target's schema belongs to the FIRST SCHEMA MOVE AFTER THE TARGET,
 * never to the target itself (a schema older than the image being rolled to) and never to the
 * environment's CURRENT deploy unless current happens to BE that first move. Keying on current is
 * the defect this module exists to close: rolling A ─▶ B ─▶ C back to A would select C's dump,
 * which holds schema B, and pair it with A's image.
 *
 * THREE THINGS MOVE A SCHEMA, AND ONLY ONE OF THEM DUMPS FIRST. A deploy that MIGRATED and a
 * `deployment.migrate_down` that REVERTED each took a dump before touching anything, so that
 * receipt's `backupRef` IS the answer — for the revert it is the state before THE REVERT, which is
 * precisely the schema the deploy it undid was running on. A ROLLBACK THAT RESTORED replaced the
 * schema with an older dump and kept NO copy of the one it overwrote, so when it is the first move
 * after the target no dump of the target's schema exists anywhere and every later dump is a
 * snapshot taken after the overwrite; the only honest answer there is a refusal. What moves nothing
 * never enters the view: a deploy refused before it migrated records no migration receipt, and a
 * rollback that restored nothing writes no marker. The walk therefore stops at the FIRST move after
 * the target; a restore further on is history it never reaches, so a migration before it still wins.
 *
 * THE JOIN IS DURABLE AND NEVER A FILENAME. `deploy-command.ts:267` passes a deploy's
 * `decisionId` as the migration's `requestId`, so a deploy receipt's `decisionId` is the
 * deterministic key `readMigrationReceipt` looks its dump up under. A rollback's receipt carries
 * its COMMAND id as `decisionId`, which is the key its restore marker is written under. No hash
 * scan, no newest-file heuristic, no value taken from a request payload.
 *
 * IT REFUSES, IT NEVER SUBSTITUTES. Every gap — unknown target, unreadable migration record, a
 * migration that recorded no dump, a restore that overwrote the target's schema, nothing moved
 * since the target at all — answers with its own stable code and leaves the database as it was.
 *
 * WHAT THE WALK READS, AND WHY IT IS NO LONGER THE DEPLOY LEDGER. It used to iterate the
 * environment's deploy receipts and ask each one for a migration, which left it blind to any move
 * that writes no deploy receipt and bound its ORDER to the order receipts landed in rather than the
 * order the schema moved in. `rollback-schema-moves.ts` holds both fixes and the whole rationale;
 * this file only decides which move is FIRST after the target. Still invisible to it: a restore
 * applied by a rollback admitted before the marker existed carries no marker to find.
 */

/** Re-exported from the leaf that now owns it, so `rollback-command.ts`'s import is unchanged and
 *  writer and reader still name ONE constant. It moved because the schema-move view has to read
 *  markers too, and this module imports that view — the reverse import would close a cycle. */
export { ROLLBACK_RESTORE_PRINCIPAL } from "./rollback-schema-moves.js";

/** Every code the dump selection can answer with. Each is a key of `ROLLBACK_RESTORE_DETAILS` —
 *  the caller's `refuse` takes only those keys, so a code missing from that table is a type
 *  error there — and the caller mints the prose. Returned bare rather than as a built refusal so
 *  that the detail table stays in one file and this module never depends on the one that
 *  consumes it. */
export type RollbackDumpSelectionCode =
  | "DEPLOY_ROLLBACK_RESTORE_BACKUP_ABSENT"
  | "DEPLOY_ROLLBACK_RESTORE_DEPLOY_UNKNOWN"
  | "DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNKNOWN"
  | "DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNVERIFIED"
  | "DEPLOY_ROLLBACK_RESTORE_SCHEMA_OVERWRITTEN";

/**
 * `target` IS PRESENT ON EVERY ANSWER THAT HAS ONE, evidence refusals included, and that is what
 * lets the caller keep its PHASE ORDER: find the deploy, resolve the destination, only then judge
 * the dump evidence. A shape that withheld the target until the walk succeeded would force the
 * destination behind the walk, and an environment whose name the store does not have would then
 * be answered by THIS module's code instead of the environment slice's own — a layer that never
 * refused, reported as though it had.
 *
 * `target: null` therefore occurs for exactly one code: the deploy is unknown, so there is no
 * destination to resolve either.
 */
export type RollbackDumpSelection =
  | Readonly<{ code: "DEPLOY_ROLLBACK_RESTORE_DEPLOY_UNKNOWN"; ok: false; target: null }>
  | Readonly<{ code: RollbackDumpSelectionCode; ok: false; target: DeployReceiptV1 }>
  /** `dumpDecisionId` keys the MIGRATION receipt holding the dump; `target` is the deploy the
   *  operator asked to return to, and carries the `decisionId` and `sha` the DESTINATION must be
   *  resolved against — the image and the schema then name the same deployment. */
  | Readonly<{ dumpDecisionId: string; ok: true; target: DeployReceiptV1 }>;

const deployUnknown = Object.freeze({
  code: "DEPLOY_ROLLBACK_RESTORE_DEPLOY_UNKNOWN", ok: false as const, target: null,
} as const);

/**
 * WHICH ENVIRONMENT EACH DEPLOY DECISION BELONGS TO. A restore marker's key carries no environment,
 * so it can only be placed through the rollback's own deploy receipt — and the deploy ledger, not
 * this module, is the authority on which environment a receipt belongs to.
 *
 * BUILT ONCE PER SELECTION rather than searched per marker: the view asks about every marker in the
 * project, and scanning every environment's receipts for each of them is quadratic on exactly the
 * ledgers where a rollback matters most. A missing key means the store cannot say — a rollback that
 * applied its restore and then died before its receipt landed.
 */
function deployEnvironments(
  ledger: ReadonlyMap<string, EnvironmentDeployState>,
): ReadonlyMap<string, string> {
  const byDecision = new Map<string, string>();
  // FIRST WINS, so a decision id reused across environments cannot flip with iteration order.
  for (const [environment, state] of ledger) {
    for (const receipt of state.receipts) {
      if (!byDecision.has(receipt.decisionId)) byDecision.set(receipt.decisionId, environment);
    }
  }
  return byDecision;
}

/**
 * WHERE THE TARGET SITS IN THE DECISION LEDGER — the position every move is judged "after".
 *
 * IT IS THE TARGET'S OWN MIGRATION when it has one, and only its deploy receipt otherwise. The
 * schema the target ran against is established by the target's OWN migration, not by the receipt
 * that reports the deployment afterwards, and `deploy-service.ts:310` runs the migration well
 * before `record(...)` commits the receipt at :335. Anchoring on the receipt would leave the
 * target's own migration sitting BEFORE the anchor in production and AFTER it in any history
 * assembled receipt-first, so the same code would answer differently depending on write order —
 * and the wrong answer there is the target's own `backupRef`, the schema as it stood BEFORE the
 * target migrated, which is one deployment too far back.
 */
function anchorPosition(
  store: SqliteEventStore, projectId: string, target: DeployReceiptV1, moves: readonly SchemaMove[],
): bigint | null {
  const own = moves.find(entry => entry.requestId === target.decisionId);
  if (own !== undefined) return own.position;
  // `deploy-ledger.ts:242` keys every deploy receipt decision under the receipt id, so the target's
  // position is ONE keyed read. Re-deriving `readDeployLedger`'s filter here would be a second,
  // drifting copy of it.
  return store.getCommandDecision({
    commandId: target.receiptId, principalId: DEPLOY_ENGINE_PRINCIPAL_ID, projectId,
  })?.decisionPosition ?? null;
}

/**
 * WHICH DEPLOY'S DUMP RESTORES THE TARGET'S SCHEMA, from the durable ledger alone.
 *
 * `toReceiptRef` is the ALREADY-ADMITTED target receipt id. It is matched against the
 * environment's own receipts rather than trusted: a receipt that belongs to another environment,
 * or to no deploy at all, is not a target this environment can be returned to.
 */
export function selectRollbackDumpDecision(
  store: SqliteEventStore, projectId: string, environment: string, toReceiptRef: string,
): RollbackDumpSelection {
  const ledger = readDeployLedger(store, projectId);
  const state = ledger.get(environment);
  if (state === undefined) return deployUnknown;
  const target = state.receipts.find(receipt => receipt.receiptId === toReceiptRef);
  if (target === undefined) return deployUnknown;
  const environments = deployEnvironments(ledger);
  const moves = readEnvironmentSchemaMoves(store, projectId, {
    environment, environmentOfRollback: commandId => environments.get(commandId) ?? null,
  });
  const anchor = anchorPosition(store, projectId, target, moves);
  // A receipt the ledger reported but whose decision cannot be located is not a deployment this
  // environment can be returned to — the same answer a receipt from another environment gets.
  if (anchor === null) return deployUnknown;
  // FORWARD FROM THE TARGET, stopping at the FIRST record that MOVED THE SCHEMA. What moves
  // NOTHING never enters the view at all: a refused-before-migrating deploy records no migration
  // receipt, and a `restoreDatabase:false` rollback writes no marker.
  for (const move of moves) {
    if (move.position <= anchor) continue;
    if (move.verdict !== "SNAPSHOT") {
      // EVERY OTHER VERDICT IS A DUMP-LESS MOVE, AND IT REFUSES RATHER THAN BEING SKIPPED. The
      // schema moved here with no readable record of the state before it, so a later dump is a
      // LATER state and restoring it would destroy strictly more than the rollback asked for.
      // The code is the view's, returned verbatim: BACKUP_ABSENT for a migration that recorded no
      // dump, SCHEMA_OVERWRITTEN for a rollback that applied a restore and kept no copy of what it
      // replaced, MIGRATION_UNVERIFIED for a record that will not decode.
      return Object.freeze({ code: move.verdict, ok: false as const, target });
    }
    // A snapshot with no request id cannot be resolved to a dump, so it is evidence this walk
    // cannot verify rather than a dump it may substitute something else for.
    if (move.requestId === null) {
      return Object.freeze({ code: "DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNVERIFIED", ok: false as const, target });
    }
    return Object.freeze({ dumpDecisionId: move.requestId, ok: true as const, target });
  }
  // Nothing has moved the schema since the target deployed — no migration, no revert, no restore —
  // so no dump identifies its state, including the case where the target IS the current deploy.
  return Object.freeze({ code: "DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNKNOWN", ok: false as const, target });
}

export interface RollbackHostRefusal {
  readonly code: string;
  readonly detail: string;
  readonly layer: string;
  readonly ok: false;
}

export type RollbackHostProbe = Readonly<{ ok: true }> | RollbackHostRefusal;

/**
 * FIXED PROSE, NEVER DOCKER'S STDERR. `deploy-service.ts:267` may relay `lastStderrLine` because
 * its refusal passes through the receipt's declassification; this one is minted BEFORE any
 * receipt exists, so an external process's output must not reach it.
 */
const DOCKER_UNAVAILABLE_DETAIL = "the deployment host's docker daemon did not answer a version probe";

const refuseHost = (): RollbackHostRefusal => Object.freeze({
  code: DEPLOY_DOCKER_UNAVAILABLE, detail: DOCKER_UNAVAILABLE_DETAIL,
  layer: DEPLOY_ENGINE_STAMP, ok: false as const,
});

/**
 * IS THIS HOST USABLE AT ALL, answered READ-ONLY and before the restore is resolved.
 *
 * `docker version` starts nothing, writes nothing and reserves nothing; it is the same probe
 * `deploy-service.ts:265-267` runs, refusing the same `DEPLOY_DOCKER_UNAVAILABLE` at the same
 * `DAEMON_DEPLOY_ENGINE` layer, so an operator's vocabulary is unchanged by where it answered.
 * Running it FIRST is the point: a dump applied against a host that cannot then start the target
 * image leaves the database reverted underneath the still-running current application.
 *
 * A NULL TARGET IS A SKIP, NOT A REFUSAL, and that is deliberate. Whether an environment has a
 * bound target is the deploy engine's own fact, refused with its own code once the engine runs;
 * pre-empting it here would answer for a layer that had not been consulted. The residual is
 * stated rather than hidden: an environment whose target binding is absent still resolves and
 * applies its dump before the engine refuses. Closing that is a different change from this one.
 */
export async function probeRollbackHost(
  ports: Pick<DeployPorts, "docker" | "ssh" | "target">, environment: string,
): Promise<RollbackHostProbe> {
  const target = ports.target(environment);
  if (target === null) return Object.freeze({ ok: true as const });
  const args = ["version", "--format", "{{.Server.Version}}"];
  let result: DeployRunResult;
  try {
    result = target.sshTarget === null
      ? await ports.docker(args)
      : await ports.ssh([target.sshTarget, "docker", ...args]);
  } catch {
    // A throwing runner is an unreachable host, which is the same answer as a refusing one.
    return refuseHost();
  }
  // ssh's own 255 means the TRANSPORT failed, so it says nothing about docker's exit status --
  // collapsed to null exactly as `deploy-service.ts:187` collapses it, and null is not zero.
  const code = target.sshTarget !== null && result.code === 255 ? null : result.code;
  return code === 0 ? Object.freeze({ ok: true as const }) : refuseHost();
}
