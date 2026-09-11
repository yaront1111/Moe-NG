import type { SqliteEventStore } from "@moe/store";
import { readMigrationReceipt } from "../repository/migrations/migration-receipt.js";
import type { MigrationReceipt } from "../repository/migrations/migration-receipt.js";
import { readDeployLedger } from "./deploy-ledger.js";
import type { DeployPorts, DeployRunResult } from "./deploy-ports.js";
import { DEPLOY_DOCKER_UNAVAILABLE, DEPLOY_ENGINE_STAMP } from "./deploy-receipt-contracts.js";
import type { DeployReceiptV1 } from "./deploy-receipt-contracts.js";

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
 * So the dump that restores the target's schema is the FIRST POST-TARGET DEPLOY THAT MIGRATED,
 * never the target's own `backupRef` (a schema older than the image being rolled to) and never
 * the environment's CURRENT deploy unless current happens to BE that first successor. Keying on
 * current is the defect this module exists to close: rolling A ─▶ B ─▶ C back to A would select
 * C's dump, which holds schema B, and pair it with A's image.
 *
 * THE JOIN IS DURABLE AND NEVER A FILENAME. `deploy-command.ts:267` passes a deploy's
 * `decisionId` as the migration's `requestId`, so a deploy receipt's `decisionId` is the
 * deterministic key `readMigrationReceipt` looks its dump up under. No hash scan, no
 * newest-file heuristic, no value taken from a request payload.
 *
 * IT REFUSES, IT NEVER SUBSTITUTES. Every gap — unknown target, unreadable migration record, a
 * migration that recorded no dump, no successor that migrated at all — answers with its own
 * stable code and leaves the database exactly as it was.
 */

/** Every code the dump selection can answer with. All four are already keys of
 *  `ROLLBACK_RESTORE_DETAILS`, so the caller mints the prose and this module mints no new
 *  vocabulary. Returned bare rather than as a built refusal so that the detail table stays in
 *  one file and this module never depends on the one that consumes it. */
export type RollbackDumpSelectionCode =
  | "DEPLOY_ROLLBACK_RESTORE_BACKUP_ABSENT"
  | "DEPLOY_ROLLBACK_RESTORE_DEPLOY_UNKNOWN"
  | "DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNKNOWN"
  | "DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNVERIFIED";

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
 * WHICH DEPLOY'S DUMP RESTORES THE TARGET'S SCHEMA, from the durable ledger alone.
 *
 * `toReceiptRef` is the ALREADY-ADMITTED target receipt id. It is matched against the
 * environment's own receipts rather than trusted: a receipt that belongs to another environment,
 * or to no deploy at all, is not a target this environment can be returned to.
 */
export function selectRollbackDumpDecision(
  store: SqliteEventStore, projectId: string, environment: string, toReceiptRef: string,
): RollbackDumpSelection {
  const state = readDeployLedger(store, projectId).get(environment);
  if (state === undefined) return deployUnknown;
  const index = state.receipts.findIndex(receipt => receipt.receiptId === toReceiptRef);
  const target = index === -1 ? undefined : state.receipts[index];
  if (target === undefined) return deployUnknown;
  // FORWARD FROM THE TARGET, stopping at the FIRST successor that recorded a migration. The
  // ledger is uncollapsed and keeps rollback receipts and refused deploys, and neither records a
  // migration — so successors with no receipt are SKIPPED rather than treated as the answer.
  for (const successor of state.receipts.slice(index + 1)) {
    let receipt: MigrationReceipt | null;
    try {
      receipt = readMigrationReceipt(store, projectId, successor.decisionId);
    } catch {
      // Swallowed deliberately: `readMigrationReceipt` throws `MIGRATION_RECEIPT_INVALID@…`, and
      // a relayed message is a surface built out of a value just read.
      return Object.freeze({ code: "DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNVERIFIED", ok: false as const, target });
    }
    if (receipt === null) continue;
    // NEVER SKIP PAST A NULL `backupRef` TO A LATER DUMP. The schema moved here with no record of
    // the state before it; a later dump is a LATER state and restoring it would destroy strictly
    // more than the rollback asked for. The honest answer is that the backup is absent.
    if (receipt.backupRef === null) {
      return Object.freeze({ code: "DEPLOY_ROLLBACK_RESTORE_BACKUP_ABSENT", ok: false as const, target });
    }
    return Object.freeze({ dumpDecisionId: successor.decisionId, ok: true as const, target });
  }
  // Nothing has moved the schema since the target deployed, so no dump identifies its state --
  // including the case where the target IS the environment's current deploy.
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
