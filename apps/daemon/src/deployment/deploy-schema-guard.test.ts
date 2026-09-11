import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it } from "vitest";
import { backupFileHash } from "../backups/backup-ports.js";
import { closeStores, driveThrough, openStore, PROJECT_ID }
  from "../bootstrap/bootstrap-test-fixtures.js";
import { setEnvironmentVariable } from "../environment/environment-store.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import type { CommandHandlerInput } from "../http/http-contract.js";
import { CONTROLLED_PROFILE_VERSION }
  from "../repository/controlled-profile/controlled-profile-generator.js";
import { deploymentInfrastructureFiles }
  from "../repository/deployment/deployment-infrastructure-templates.js";
import { MIGRATION_RECEIPT_VERSION, migrationReceiptId, recordMigrationReceipt }
  from "../repository/migrations/migration-receipt.js";
import type { MigrationReceipt } from "../repository/migrations/migration-receipt.js";
import { createDeployCommandHandler } from "./deploy-command.js";
import { readDeployReceipt, recordDeployReceipt } from "./deploy-ledger.js";
import { DEPLOY_MIGRATION_DATABASE_VARIABLE } from "./deploy-migration-context.js";
import { createDockerDouble } from "./deploy-ports.js";
import type { DeployMigrationResult, DeployPorts } from "./deploy-ports.js";
import { deployReceiptId } from "./deploy-receipt-contracts.js";
import { DEPLOY_SCHEMA_INTENT_PRINCIPAL } from "./deploy-schema-guard.js";
import { candidateContainerName } from "./deploy-service.js";
import { environmentSchemaGuardId } from "./environment-schema-guard.js";
import { createMigrateDownCommandHandler } from "./migrate-down-command.js";
import { createRollbackCommandHandler } from "./rollback-command.js";

/**
 * `deployment.deploy` ON THE SHARED PER-ENVIRONMENT SCHEMA GUARD — the third command's cross arms.
 *
 * `environment-schema-guard.test.ts` proves the rollback and the revert exclude each other. This
 * file proves the deploy is in the same fence: that it TAKES the shared stream around its migration,
 * that it GIVES it back with its terminal, that a deploy holding it refuses a restoring rollback,
 * that a revert holding it refuses a deploy BEFORE the migration port is called, and that a deploy
 * interrupted between the two can still finish and free the environment.
 *
 * EVERY ARM DRIVES REAL HANDLERS. Nothing asserts on a derivation, a leaf function or a hand-built
 * stream id: the holder is a real command admitted through its real admission commit, and the
 * contender is a real command dispatched at the same environment. The only fixture intervention is a
 * store proxy that throws from ONE command kind's TERMINAL commit, which leaves the environment held
 * exactly as a crashed command leaves it — both intents, and the guard reservations inside them,
 * commit for real.
 *
 * THE VACUOUS GREEN THIS FILE IS BUILT TO AVOID: an arm that asserted only "the second command
 * refused" would stay green if the deploy were pointed back at the PROJECT stream, because a
 * rollback can refuse for a dozen reasons that have nothing to do with this fence. So every arm
 * asserts the CODE, the LAYER that minted it, and the EFFECT PORT'S CALL COUNT — "refused" and
 * "refused without touching the database" are different claims and only the second is the subject
 * here — and each arm anchors on the holder's parity read back through `environmentSchemaGuardId`
 * before it asserts any refusal.
 *
 * ONE ENVIRONMENT NAME THROUGHOUT, for the reason the sibling file records: two commands fenced
 * against two DIFFERENT environments do not exclude each other before the fix or after it.
 *
 * TEARDOWN: every temp root is removed in the module-level `afterEach`, which also runs on a
 * throwing path, and store handles are released by `closeStores` (epic rail 4). No container, no
 * port and no child process is created by any arm.
 */

const ENVIRONMENT = "production";
const OPERATOR = "operator";
const TARGET_SHA = "a".repeat(40), TARGET_DIGEST = `sha256:${"b".repeat(64)}`;
const TARGET_DECISION = "target-deploy";
const CURRENT_SHA = "d".repeat(40), CURRENT_DECISION = "current-deploy";
const NEXT_SHA = "f".repeat(40);
const BATCH = ["1700000000002_current.js"] as const;
/** Credential-shaped ON PURPOSE, so a leak onto any durable surface would be findable. */
const DATABASE_URL = "postgres://app:gu4rd-s3cr3t@db.internal:5432/app";
const CREDENTIAL = "deploy-schema-guard-credential";
const AT = "2026-09-06T01:00:00.000Z";
const clock = (): string => AT;
const DEPLOY_ID = "guard-deploy", BUSY_DEPLOY_ID = "guard-deploy-busy";
const BUILD_FAILED_ID = "guard-deploy-build-failed";
const ROLLBACK_ID = "guard-rollback", MIGRATE_DOWN_ID = "guard-migrate-down";
const roots: string[] = [];

afterEach(closeStores);
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) continue;
    try { rmSync(root, { force: true, recursive: true }); }
    catch { /* a held handle on Windows must not mask a test failure */ }
  }
});

type Legs = SqliteEventStore["commitExpectedVersionDecisionLegs"];

/**
 * ONE STORE, ONE ENVIRONMENT, THREE REAL HANDLERS.
 *
 * The deploy history is the shape a restoring rollback needs to get PAST its restore resolution and
 * reach the guard: a TARGET deploy to return to, a LATER deploy whose migration recorded a
 * verifiable dump, and a bound destination. Without all three the rollback refuses
 * DEPLOY_ROLLBACK_RESTORE_* BEFORE it reads the guard, and the exclusion arm would be green for a
 * refusal that has nothing to do with this row.
 *
 * THE SEEDING DEPLOY COMPOSES NO `migrate` PORT, deliberately, so it takes no reservation of its own
 * and records no migration receipt — the arms' guard parity starts at 0 and the dump walk's anchor
 * stays on the seeded migration.
 */
async function deployGuardWorld() {
  const durable = openStore();
  driveThrough(durable, "goal.close");
  let stalledKind: string | null = null;
  const store = new Proxy(durable, { get(target, property) {
    if (property === "commitExpectedVersionDecisionLegs") {
      return (input: Parameters<Legs>[0]) => {
        // THE TERMINAL ONLY. Every intent commits under an `internal.*` kind, so the reservation the
        // arms depend on is never the thing being stalled.
        if (stalledKind !== null && input.commandKind === stalledKind) {
          throw new Error(`fixture stalled the ${stalledKind} terminal`);
        }
        return target.commitExpectedVersionDecisionLegs(input);
      };
    }
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });

  const docker = createDockerDouble({
    proxyConfig: deploymentInfrastructureFiles(CONTROLLED_PROFILE_VERSION, []).get("docker/Caddyfile") ?? "",
    running: { app: "HEALTHY" }, imageDigest: TARGET_DIGEST,
    health: Object.fromEntries([
      [candidateContainerName(ENVIRONMENT, TARGET_SHA, TARGET_DECISION), ["HEALTHY"]],
      ...[DEPLOY_ID, BUSY_DEPLOY_ID, BUILD_FAILED_ID]
        .map(id => [candidateContainerName(ENVIRONMENT, NEXT_SHA, id), ["HEALTHY"]] as const),
      [candidateContainerName(ENVIRONMENT, TARGET_SHA, ROLLBACK_ID), ["HEALTHY"]],
    ]) });
  const basePorts = { build: docker.build, docker: docker.docker, ssh: docker.ssh,
    transfer: docker.transfer, target: () => ({ network: "product", sshTarget: null, url: null }),
    releaseDecision: () => null };
  const principal = { capabilities: ["goal.write"], principalId: OPERATOR, projectId: PROJECT_ID };
  const envelope = (commandId: string, commandKind: string, payload: Readonly<Record<string, unknown>>) =>
    ({ commandId, commandKind, correlationId: `corr-${commandId}`,
      // READ at send time, never pinned: a literal starts refusing CONFLICT as the fixture grows,
      // and a CONFLICT refusal would answer ahead of the guard.
      expectedVersion: store.getAggregateVersion(PROJECT_ID), payload,
      requestDigest: "c".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: "deploy-schema-guard-credential", targetAggregateId: PROJECT_ID });

  const deployOptions = (ports: DeployPorts, buildContext = "/workspace/product") =>
    ({ operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store, buildContext, clock,
      healthBudgetMs: 10, pollMs: 1, sleep: async (): Promise<void> => {}, ports });

  // A REAL `deployment.deploy` rather than a planted receipt: `COMMAND_PREREQUISITES` names
  // `deployment.deploy` for `deployment.migrate_down`, and a receipt is not a decision.
  await createDeployCommandHandler(deployOptions(basePorts))({ principal,
    envelope: envelope(TARGET_DECISION, "deployment.deploy",
      { environment: ENVIRONMENT, sha: TARGET_SHA }) } as CommandHandlerInput);
  const target = readDeployReceipt(store, PROJECT_ID, deployReceiptId(PROJECT_ID, ENVIRONMENT, TARGET_DECISION));
  if (!target.ok) throw new Error(target.code);
  // A LATER deploy, so the dump walk has a successor to find. Written straight to the ledger: it
  // needs no bootstrap decision, and a second real deploy would take a docker path nothing needs.
  expect(recordDeployReceipt(store, { projectId: PROJECT_ID, environment: ENVIRONMENT,
    sha: CURRENT_SHA, imageDigest: `sha256:${"e".repeat(64)}`, decisionId: CURRENT_DECISION,
    decidedAt: AT, refusal: null, releaseDecision: null, url: null })).toMatchObject({ ok: true });

  const root = mkdtempSync(join(tmpdir(), "moe-deploy-schema-guard-"));
  roots.push(root);
  const dump = join(root, "pre-migration.sql");
  writeFileSync(dump, "-- the schema the target deploy ran against\nCREATE TABLE kept();\n");
  const source: MigrationReceipt = { applied: [...BATCH], backupRef: `${dump}@sha256:${await backupFileHash(dump)}`,
    decidedAt: AT, environment: ENVIRONMENT, outcome: "APPLIED", projectId: PROJECT_ID,
    receiptId: migrationReceiptId(PROJECT_ID, CURRENT_DECISION), refusal: null,
    requestId: CURRENT_DECISION, sha: CURRENT_SHA, version: MIGRATION_RECEIPT_VERSION };
  recordMigrationReceipt(store, source);
  const credential = (): string => CREDENTIAL;
  // A silently refused seed would make the restore resolution refuse UNAVAILABLE and the exclusion
  // arm vacuous.
  expect(setEnvironmentVariable({ credential, now: clock, projectId: PROJECT_ID, store },
    { environment: ENVIRONMENT, name: DEPLOY_MIGRATION_DATABASE_VARIABLE, value: DATABASE_URL }))
    .toMatchObject({ ok: true });

  /** RECORDS AND THEN THROWS, for the reason the sibling file gives: recording makes "never called"
   *  a readable fact, and throwing makes a regression loud rather than silently green. */
  const restores: string[] = [];
  const rollbackOptions = { operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store, clock,
    healthBudgetMs: 1, pollMs: 1, sleep: async (): Promise<void> => {},
    environmentCredential: credential, migrationWorkspace: root, ports: basePorts,
    backupPorts: { restoreDatabaseInto: async (_connection: string, path: string): Promise<void> => {
      restores.push(path);
      throw new Error("the restore port must not be reached while the environment guard is held");
    } } };

  let dumps = 0, reverts = 0;
  const migrateDownOptions = { clock, operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store,
    hostContext: (environment: string) => environment === ENVIRONMENT
      ? { databaseUrl: DATABASE_URL, projectRoot: root, workspace: root } : null,
    ports: { dump: async (_connection: string, path: string): Promise<void> => {
        dumps += 1; writeFileSync(path, "-- reverted\n");
      },
      revert: async (_workspace: string, _connection: string, batch: readonly string[]) => {
        reverts += 1; return [...batch].reverse();
      } } };

  /** THE COUNTED MIGRATION PORT. It is the member DoD 4 asserts records ZERO calls, and it is an
   *  INJECTED port precisely so the fence has to hold for a composition that supplies its own —
   *  `options.ports` replaces the whole ports object, so a guard living inside the production
   *  closure would never run here. It writes no migration receipt, which keeps the dump walk's
   *  anchor on the seeded one. */
  const migrations: string[] = [];
  const migratingPorts = (options: { readonly buildStderr?: string } = {}): DeployPorts => ({
    ...basePorts,
    ...(options.buildStderr === undefined ? {} : {
      build: async () => ({ code: 1, stderr: options.buildStderr ?? "", stdout: "" }),
    }),
    migrate: async (
      _environment: string, _sha: string, decisionId: string,
    ): Promise<DeployMigrationResult> => {
      migrations.push(decisionId);
      return { applied: [...BATCH], ok: true };
    },
  });

  return {
    store, restores, migrations,
    effects: () => ({ dumps, reverts }),
    stall: (kind: string | null): void => { stalledKind = kind; },
    guardId: (): string => environmentSchemaGuardId(PROJECT_ID, ENVIRONMENT),
    guardVersion: (): number => store.getAggregateVersion(environmentSchemaGuardId(PROJECT_ID, ENVIRONMENT)),
    /** A decision's committed bytes, decoded — read from the store, never from a local variable. */
    decisionBytes: (commandId: string, principalId: string): Record<string, unknown> | null => {
      const record = store.getCommandDecision({ commandId, principalId, projectId: PROJECT_ID });
      return record === null
        ? null : JSON.parse(new TextDecoder().decode(record.resultBytes)) as Record<string, unknown>;
    },
    deploy: async (
      commandId: string, ports: DeployPorts, buildContext?: string,
    ): Promise<unknown> => createDeployCommandHandler(
      deployOptions(ports, buildContext))({ principal,
        envelope: envelope(commandId, "deployment.deploy",
          { environment: ENVIRONMENT, sha: NEXT_SHA }) } as CommandHandlerInput),
    migratingPorts,
    rollback: async (commandId: string, restoreDatabase: boolean): Promise<unknown> =>
      createRollbackCommandHandler(rollbackOptions)({ principal,
        envelope: envelope(commandId, "deployment.rollback", { environment: ENVIRONMENT,
          toReceiptRef: target.receipt.receiptId, restoreDatabase }) } as CommandHandlerInput),
    migrateDown: async (commandId: string): Promise<unknown> =>
      createMigrateDownCommandHandler(migrateDownOptions)({ principal,
        envelope: envelope(commandId, "deployment.migrate_down", { environment: ENVIRONMENT,
          toMigrationRequestId: CURRENT_DECISION }) } as CommandHandlerInput),
  };
}

/** The refusal a throwing dispatch produced, or a failure naming what came back instead — so an arm
 *  cannot pass by swallowing a success it was supposed to refuse. `httpStatus` is carried because
 *  409-vs-422 is the difference between "retry this" and "this request is wrong". */
async function refusalOf(
  promise: Promise<unknown>,
): Promise<{ code: string; httpStatus: number; layer: string }> {
  try {
    const answered = await promise;
    throw new Error(`expected a refusal, received ${JSON.stringify(answered)}`);
  } catch (error) {
    const carried = error as { code?: unknown; httpStatus?: unknown; layer?: unknown };
    if (typeof carried.code === "string" && typeof carried.layer === "string"
      && typeof carried.httpStatus === "number") {
      return { code: carried.code, httpStatus: carried.httpStatus, layer: carried.layer };
    }
    throw error;
  }
}

it("a deploy that migrated records the UNIFIED stream in its intent and releases it at its terminal",
  async () => {
    const world = await deployGuardWorld();
    expect(world.guardVersion()).toBe(0);
    await world.deploy(DEPLOY_ID, world.migratingPorts());
    expect(world.migrations).toEqual([DEPLOY_ID]);
    // THE SUBJECT: the stream this deploy really reserved, read out of its own durable intent rather
    // than re-derived. Pointed at any other stream this is not `environment-schema:<hash>` and the
    // fence is not shared. The version is ODD because it is the one the reserve TOOK.
    expect(world.decisionBytes(DEPLOY_ID, DEPLOY_SCHEMA_INTENT_PRINCIPAL))
      .toEqual({ guardId: world.guardId(), guardVersion: 1 });
    // AND GIVEN BACK: the terminal's extra leg made the parity even again, so the next command may
    // take it. A reserve with no release is the leak epic rail 4 forbids.
    expect(world.guardVersion()).toBe(2);
  });

it("a deploy holding the environment refuses a RESTORING rollback without the restore being reached",
  async () => {
    const world = await deployGuardWorld();
    // THE HOLDER: a real deploy whose TERMINAL never commits. Its intent — and the guard reservation
    // inside the same multi-leg commit — landed, so the environment is held exactly as a crashed
    // deploy holds it.
    world.stall("deployment.deploy");
    await expect(world.deploy(DEPLOY_ID, world.migratingPorts())).rejects.toThrow("fixture stalled");
    world.stall(null);
    // ASSERTED BEFORE THE REFUSAL IS: the DEPLOY reserved the unified stream. Pointed back at the
    // project stream this reads 0 and the arm is red here, which is what stops the refusal below
    // from being satisfied by two commands guarding two streams neither shares.
    expect(world.migrations).toEqual([DEPLOY_ID]);
    expect(world.guardVersion() % 2).toBe(1);

    const refusal = await refusalOf(world.rollback(ROLLBACK_ID, true));
    expect(refusal).toEqual({ code: "DEPLOY_ROLLBACK_IN_PROGRESS", httpStatus: 409,
      layer: DAEMON_COMMAND_SEAM });
    // NOT REACHED, not merely not-succeeded: the port that would have recorded a call recorded none.
    expect(world.restores).toEqual([]);
  });

it("a held migrate_down refuses a real deploy at the guard, BEFORE its migration port is called",
  async () => {
    const world = await deployGuardWorld();
    // THE MIRROR HOLDER: a real revert whose terminal never commits.
    world.stall("deployment.migrate_down");
    await expect(world.migrateDown(MIGRATE_DOWN_ID)).rejects.toThrow("fixture stalled");
    world.stall(null);
    expect(world.guardVersion() % 2).toBe(1);
    expect(world.effects()).toEqual({ dumps: 1, reverts: 1 });

    const refusal = await refusalOf(world.deploy(BUSY_DEPLOY_ID, world.migratingPorts()));
    // THE SEAM'S OWN CODE AND LAYER, not the engine's. A deploy that reached the engine's refusal
    // path would answer DEPLOY_BUILD_FAILED at DAEMON_DEPLOY_ENGINE, and 422 rather than 409.
    expect(refusal).toEqual({ code: "DEPLOY_ENVIRONMENT_SCHEMA_BUSY", httpStatus: 409,
      layer: DAEMON_COMMAND_SEAM });
    // THE MIGRATION WAS NOT RUN AND THEN REPORTED — it was never called at all.
    expect(world.migrations).toEqual([]);
    // The revert still holds the environment: a refused deploy released nothing it never took.
    expect(world.guardVersion() % 2).toBe(1);
  });

it("a deploy interrupted between its reserve and its terminal finishes on re-issue and frees the environment",
  async () => {
    const world = await deployGuardWorld();
    // THE INTERRUPTION, driven rather than described: the deploy reserves, migrates, records its
    // receipt, and then dies in its terminal commit.
    world.stall("deployment.deploy");
    await expect(world.deploy(DEPLOY_ID, world.migratingPorts())).rejects.toThrow("fixture stalled");
    world.stall(null);
    expect(world.migrations).toEqual([DEPLOY_ID]);
    const held = world.guardVersion();
    expect(held % 2).toBe(1);

    // THE SAME COMMAND ID, RE-ISSUED. `replayOf` looks up the TERMINAL key, finds nothing and
    // returns null, so the whole handler runs again — and the recovery reader hands it the
    // `{guardId, guardVersion}` its OWN first attempt recorded instead of re-checking a parity its
    // own reservation made odd.
    await world.deploy(DEPLOY_ID, world.migratingPorts());
    // EVEN AGAIN: the environment is recoverable, not permanently unavailable.
    expect(world.guardVersion()).toBe(held + 1);
    // AND THE MIGRATION WAS NOT RE-RUN. The engine's receipt replay returns BEFORE the migration, so
    // this is the path on which a reservation read inside the migrate port would never have been
    // seen and the release leg would never have been appended — the stranding this arm exists for.
    expect(world.migrations).toEqual([DEPLOY_ID]);
    expect(world.decisionBytes(DEPLOY_ID, OPERATOR)).toMatchObject({ environment: ENVIRONMENT });

    // AND THE FREED ENVIRONMENT IS REALLY FREE: a real revert is admitted at it afterwards.
    await world.migrateDown(MIGRATE_DOWN_ID);
    expect(world.effects()).toEqual({ dumps: 1, reverts: 1 });
  });

it("a deploy refused BEFORE its migration commits a terminal with no release leg and leaves the guard untouched",
  async () => {
    const world = await deployGuardWorld();
    expect(world.guardVersion()).toBe(0);
    // REFUSED INSIDE THE ENGINE, PAST ADMISSION AND BEFORE THE MIGRATION: the terminal DOES commit,
    // which is exactly the case a release leg fired against a reservation that never happened would
    // destroy — the leg would fence an EVEN stream, fail the whole terminal, and turn a readable
    // DEPLOY_BUILD_FAILED into a bare conflict.
    const refusal = await refusalOf(
      world.deploy(BUILD_FAILED_ID, world.migratingPorts({ buildStderr: "no such context" })));
    expect(refusal.code).toBe("DEPLOY_BUILD_FAILED");
    expect(world.migrations).toEqual([]);
    // THE TERMINAL LANDED: a decided-but-refused deploy is durable, and it committed with no extra
    // leg. Both halves matter — an exception from the commit would also leave the guard at 0.
    expect(world.decisionBytes(BUILD_FAILED_ID, OPERATOR)).toMatchObject({ outcome: "REFUSED" });
    expect(world.decisionBytes(BUILD_FAILED_ID, DEPLOY_SCHEMA_INTENT_PRINCIPAL)).toBeNull();
    expect(world.guardVersion()).toBe(0);

    // AND THE ENVIRONMENT WAS NEVER TAKEN: a restoring rollback is admitted at it immediately after
    // and REACHES the restore port. The code is the restore's own failure — this fixture's port
    // always throws — and the point is which refusal it is NOT: a held guard answers
    // DEPLOY_ROLLBACK_IN_PROGRESS before the port is constructed, and `restores` would be empty.
    expect(await refusalOf(world.rollback(ROLLBACK_ID, true)))
      .toMatchObject({ code: "DEPLOY_ROLLBACK_RESTORE_FAILED", layer: DAEMON_COMMAND_SEAM });
    expect(world.restores).toHaveLength(1);
  });

it("a deploy refused before admission takes no reservation and commits nothing", async () => {
  const world = await deployGuardWorld();
  const refusal = await refusalOf(world.deploy(BUSY_DEPLOY_ID, world.migratingPorts(), ""));
  expect(refusal).toEqual({ code: "DEPLOY_BUILD_CONTEXT_UNCONFIGURED", httpStatus: 422,
    layer: DAEMON_COMMAND_SEAM });
  expect(world.migrations).toEqual([]);
  expect(world.guardVersion()).toBe(0);
  expect(world.decisionBytes(BUSY_DEPLOY_ID, DEPLOY_SCHEMA_INTENT_PRINCIPAL)).toBeNull();
});
