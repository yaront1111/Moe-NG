import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it } from "vitest";
import { backupFileHash } from "../backups/backup-ports.js";
import { closeStores, driveThrough, openStore, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { setEnvironmentVariable } from "../environment/environment-store.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import type { CommandHandlerInput } from "../http/http-contract.js";
import { CONTROLLED_PROFILE_VERSION }
  from "../repository/controlled-profile/controlled-profile-generator.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { MIGRATION_RECEIPT_VERSION, migrationReceiptId, recordMigrationReceipt }
  from "../repository/migrations/migration-receipt.js";
import type { MigrationReceipt } from "../repository/migrations/migration-receipt.js";
import { createDeployCommandHandler } from "./deploy-command.js";
import { readDeployReceipt, recordDeployReceipt } from "./deploy-ledger.js";
import { DEPLOY_MIGRATION_DATABASE_VARIABLE } from "./deploy-migration-context.js";
import { createDockerDouble } from "./deploy-ports.js";
import { deployReceiptId } from "./deploy-receipt-contracts.js";
import { candidateContainerName } from "./deploy-service.js";
import { environmentSchemaGuardId, legacyMigrateDownGuardId, legacyRollbackGuardId }
  from "./environment-schema-guard.js";
import { createMigrateDownCommandHandler } from "./migrate-down-command.js";
import { createRollbackCommandHandler } from "./rollback-command.js";

/**
 * TWO COMMANDS, ONE ENVIRONMENT'S SCHEMA, ONE PARITY — the cross arms.
 *
 * Before `environment-schema-guard.ts` these two guarded the same environment on two private
 * streams that neither could read, so a `deployment.migrate_down` reverting a batch and a
 * `deployment.rollback` restoring a dump could be admitted at the same moment and both write the
 * same database. Each arm here holds the environment with ONE real command and then drives the
 * OTHER real command at it.
 *
 * THE VACUOUS GREEN THIS FILE IS BUILT TO AVOID, named in the plan: the two existing suites use
 * DIFFERENT environment names ("production" in `rollback-command-ordering.test.ts`, "staging" in
 * `migrate-down-test-fixtures.ts`), and a cross arm that let each command keep its own default
 * would be asserting that two DIFFERENT environments do not exclude each other — true before the
 * fix and after it. Both commands here run against ONE name, and before asserting any refusal each
 * arm asserts that the holder's reservation actually landed on the UNIFIED stream, read back
 * through `environmentSchemaGuardId`. That read is what fails when the commands are pointed back
 * at their old private streams.
 *
 * EVERY ARM ASSERTS THE CODE AND THE LAYER THAT MINTED IT, never merely that something refused: a
 * second refusal layer answering first would keep a code-only arm green while the guard did
 * nothing. It also asserts the EFFECT PORT'S CALL COUNT, because "refused" and "refused without
 * touching the database" are different claims and only the second one is the subject here.
 *
 * NOTHING IS PLANTED ON THE CROSS PATH. The holder is the real handler, admitted through the real
 * admission commit; the only fixture intervention is a store proxy that throws from the TERMINAL
 * commit of one command kind, which leaves the environment held exactly as a crashed command
 * leaves it. The intent — and the guard reservation inside it — commits for real.
 *
 * TEARDOWN: every temp root is removed in the module-level `afterEach` below, which also runs on a
 * throwing path, and store handles are released by `closeStores` (epic rail 4). No container, no
 * port and no child process is created by any arm.
 */

const ENVIRONMENT = "production";
const OPERATOR = "operator";
const TARGET_SHA = "a".repeat(40), TARGET_DIGEST = `sha256:${"b".repeat(64)}`;
const TARGET_DECISION = "target-deploy";
const CURRENT_SHA = "d".repeat(40), CURRENT_DECISION = "current-deploy";
const BATCH = ["1700000000002_current.js"] as const;
/** Credential-shaped ON PURPOSE, so a leak onto any durable surface would be findable. */
const DATABASE_URL = "postgres://app:gu4rd-s3cr3t@db.internal:5432/app";
const CREDENTIAL = "environment-schema-guard-credential";
const AT = "2026-09-06T01:00:00.000Z";
const clock = (): string => AT;
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
 * ONE STORE, ONE ENVIRONMENT, BOTH REAL HANDLERS.
 *
 * The deploy history is the shape a restoring rollback needs to get PAST its restore resolution and
 * reach the guard: a TARGET deploy to return to, a LATER deploy whose migration recorded a
 * verifiable dump, and a bound destination. Without all three the rollback refuses
 * DEPLOY_ROLLBACK_RESTORE_* at `rollback-command.ts:222-232` — which is BEFORE the guard is read at
 * :237 — and arm 1 would be green for a refusal that has nothing to do with this row.
 *
 * The same migration receipt is the migrate_down's SOURCE batch, so one history serves both
 * commands and neither is reaching for state the other invented.
 */
async function guardWorld() {
  const durable = openStore();
  driveThrough(durable, "goal.close");
  let stalledKind: string | null = null;
  let downgrade: { readonly kind: string; readonly legacyId: string } | null = null;
  let corrupt: { readonly kind: string; readonly guardId: unknown } | null = null;
  let downgraded = 0;
  const store = new Proxy(durable, { get(target, property) {
    if (property === "commitExpectedVersionDecisionLegs") {
      return (input: Parameters<Legs>[0]) => {
        // The TERMINAL only. Both intents commit under `internal.*` kinds, so the reservation the
        // arms depend on is never the thing being stalled.
        if (stalledKind !== null && input.commandKind === stalledKind) {
          throw new Error(`fixture stalled the ${stalledKind} terminal`);
        }
        // THE PRE-CHANGE ADMISSION, REPRODUCED BY THE REAL ADMISSION PATH. Rather than
        // hand-assembling an old intent, the real handler's own commit is rewritten into the exact
        // shape the pre-change code would have produced: the guard leg moved to that command's
        // LEGACY stream, and `guardId` stripped from the committed bytes. Everything else — the
        // request leg, the project leg, the request bytes, the decision key — is what production
        // wrote, so the arm recovers a decision this daemon really could have left behind.
        if (downgrade !== null && input.commandKind === downgrade.kind) {
          const unified = environmentSchemaGuardId(PROJECT_ID, ENVIRONMENT);
          const decoded = JSON.parse(new TextDecoder().decode(input.committedResultBytes)) as
            { readonly guardVersion: number };
          downgraded += 1;
          return target.commitExpectedVersionDecisionLegs({ ...input,
            committedResultBytes: new TextEncoder().encode(JSON.stringify({ guardVersion: decoded.guardVersion })),
            legs: input.legs.map(leg => leg.aggregateId === unified
              ? { ...leg, aggregateId: downgrade!.legacyId } : leg) });
        }
        // A PRESENT BUT UNUSABLE id, substituted for the real one. The key stays, so this is not a
        // pre-change intent and neither command may fall back to a legacy stream for it.
        if (corrupt !== null && input.commandKind === corrupt.kind) {
          const decoded = JSON.parse(new TextDecoder().decode(input.committedResultBytes)) as
            Record<string, unknown>;
          return target.commitExpectedVersionDecisionLegs({ ...input,
            committedResultBytes: new TextEncoder().encode(
              JSON.stringify({ ...decoded, guardId: corrupt.guardId })) });
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
    health: Object.fromEntries([TARGET_DECISION, ROLLBACK_ID, "legacy-rollback", "fresh-rollback"]
      .map(id => [candidateContainerName(ENVIRONMENT, TARGET_SHA, id), ["HEALTHY"]])) });
  const ports = { build: docker.build, docker: docker.docker, ssh: docker.ssh, transfer: docker.transfer,
    target: () => ({ network: "product", sshTarget: null, url: null }), releaseDecision: () => null };
  const principal = { capabilities: ["goal.write"], principalId: OPERATOR, projectId: PROJECT_ID };
  const envelope = (commandId: string, commandKind: string, payload: Readonly<Record<string, unknown>>) =>
    ({ commandId, commandKind, correlationId: `corr-${commandId}`,
      // READ from the store at send time, never pinned: a literal starts refusing CONFLICT as the
      // fixture grows, and a CONFLICT refusal would answer ahead of the guard.
      expectedVersion: store.getAggregateVersion(PROJECT_ID), payload,
      requestDigest: "c".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: "schema-guard-credential", targetAggregateId: PROJECT_ID });

  // THE TARGET DEPLOY IS A REAL `deployment.deploy`, not a planted receipt, and it has to be:
  // `COMMAND_PREREQUISITES["deployment.migrate_down"]` names `deployment.deploy`, so a fixture that
  // only wrote deploy receipts into the ledger gets BOOTSTRAP_PREREQUISITE_MISSING out of the
  // revert instead of the guard refusal these arms are about. No environmentCredential is composed
  // for it, so it runs no migration of its own and leaves the dump walk's anchor on its receipt.
  await createDeployCommandHandler({ operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store,
    buildContext: "/workspace/product", clock, healthBudgetMs: 10, pollMs: 1,
    sleep: async (): Promise<void> => {}, ports })({ principal,
      envelope: envelope(TARGET_DECISION, "deployment.deploy",
        { environment: ENVIRONMENT, sha: TARGET_SHA }) } as CommandHandlerInput);
  const target = readDeployReceipt(store, PROJECT_ID, deployReceiptId(PROJECT_ID, ENVIRONMENT, TARGET_DECISION));
  if (!target.ok) throw new Error(target.code);
  // A LATER deploy, so the walk has a successor to find. Written straight to the ledger: it needs
  // no bootstrap decision of its own, and a second real deploy would take a second docker path
  // this fixture has no reason to exercise.
  const current = recordDeployReceipt(store, { projectId: PROJECT_ID, environment: ENVIRONMENT,
    sha: CURRENT_SHA, imageDigest: `sha256:${"e".repeat(64)}`, decisionId: CURRENT_DECISION,
    decidedAt: AT, refusal: null, releaseDecision: null, url: null });
  expect(current).toMatchObject({ ok: true });

  const root = mkdtempSync(join(tmpdir(), "moe-schema-guard-"));
  roots.push(root);
  const dump = join(root, "pre-migration.sql");
  writeFileSync(dump, "-- the schema the target deploy ran against\nCREATE TABLE kept();\n");
  const source: MigrationReceipt = { applied: [...BATCH], backupRef: `${dump}@sha256:${await backupFileHash(dump)}`,
    decidedAt: AT, environment: ENVIRONMENT, outcome: "APPLIED", projectId: PROJECT_ID,
    receiptId: migrationReceiptId(PROJECT_ID, CURRENT_DECISION), refusal: null,
    requestId: CURRENT_DECISION, sha: CURRENT_SHA, version: MIGRATION_RECEIPT_VERSION };
  recordMigrationReceipt(store, source);
  const credential = (): string => CREDENTIAL;
  // A silently refused seed would make the restore resolution refuse UNAVAILABLE and arm 1 vacuous.
  expect(setEnvironmentVariable({ credential, now: clock, projectId: PROJECT_ID, store },
    { environment: ENVIRONMENT, name: DEPLOY_MIGRATION_DATABASE_VARIABLE, value: DATABASE_URL }))
    .toMatchObject({ ok: true });

  /** RECORDS AND THEN THROWS. Recording makes "it was never called" a readable fact rather than an
   *  inference from silence; throwing makes a regression loud, because a handler that restored and
   *  only then refused for the guard would answer DEPLOY_ROLLBACK_RESTORE_FAILED instead. */
  const restores: string[] = [];
  const rollbackOptions = { operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store, clock,
    healthBudgetMs: 1, pollMs: 1, sleep: async (): Promise<void> => {},
    environmentCredential: credential, migrationWorkspace: root, ports,
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

  return {
    store, restores, dump, source,
    effects: () => ({ dumps, reverts }),
    stall: (kind: string | null): void => { stalledKind = kind; },
    /** Admits the NEXT commit of `kind` the pre-change way, on `legacyId`. `downgrades()` is the
     *  positive control: an arm whose rewrite never fired planted nothing. */
    admitAsLegacy: (value: { readonly kind: string; readonly legacyId: string } | null): void => { downgrade = value; },
    /** Substitutes a PRESENT but unusable guard id into the next intent of `kind`. */
    corruptIntent: (value: { readonly kind: string; readonly guardId: unknown } | null): void => { corrupt = value; },
    downgrades: (): number => downgraded,
    versionOf: (aggregateId: string): number => store.getAggregateVersion(aggregateId),
    /** An intent decision's committed bytes, decoded — the durable record of which stream this
     *  request reserved. Read from the store, never from a local variable. */
    intentBytes: (commandId: string, principalId: string): Record<string, unknown> | null => {
      const record = store.getCommandDecision({ commandId, principalId, projectId: PROJECT_ID });
      return record === null
        ? null : JSON.parse(new TextDecoder().decode(record.resultBytes)) as Record<string, unknown>;
    },
    guardVersion: (): number => store.getAggregateVersion(environmentSchemaGuardId(PROJECT_ID, ENVIRONMENT)),
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

/** The refusal a throwing dispatch produced, or a failure naming what came back instead — so an
 *  arm cannot pass by swallowing a success it was supposed to refuse. */
async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; layer: string }> {
  try {
    const answered = await promise;
    throw new Error(`expected a refusal, received ${JSON.stringify(answered)}`);
  } catch (error) {
    const carried = error as { code?: unknown; layer?: unknown };
    if (typeof carried.code === "string" && typeof carried.layer === "string") {
      return { code: carried.code, layer: carried.layer };
    }
    throw error;
  }
}

it("a held migrate_down refuses a RESTORING rollback without the restore being reached", async () => {
  const world = await guardWorld();
  // THE HOLDER: a real migrate_down whose TERMINAL never commits. Its intent — and the guard
  // reservation inside the same multi-leg commit — landed, so the environment is held exactly as a
  // crashed revert holds it.
  world.stall("deployment.migrate_down");
  await expect(world.migrateDown(MIGRATE_DOWN_ID)).rejects.toThrow("fixture stalled");
  world.stall(null);
  // THE SUBJECT, ASSERTED BEFORE THE REFUSAL IS: the revert reserved the UNIFIED stream. Pointed
  // back at `migrate-down-environment:` this reads 0 and the arm is red here, which is what stops
  // the refusal below from being satisfied by two commands guarding two streams neither shares.
  expect(world.guardVersion() % 2).toBe(1);
  expect(world.effects()).toEqual({ dumps: 1, reverts: 1 });

  const refusal = await refusalOf(world.rollback(ROLLBACK_ID, true));
  expect(refusal).toEqual({ code: "DEPLOY_ROLLBACK_IN_PROGRESS", layer: DAEMON_COMMAND_SEAM });
  // NOT REACHED, not merely not-succeeded: the port that would have recorded a call recorded none.
  expect(world.restores).toEqual([]);
});

it("a held rollback refuses a real migrate_down without the revert being reached", async () => {
  const world = await guardWorld();
  // THE MIRROR HOLDER: a real rollback, restoreDatabase:false so no dump of its own is applied and
  // no restore marker is written, whose TERMINAL never commits.
  world.stall("deployment.rollback");
  await expect(world.rollback(ROLLBACK_ID, false)).rejects.toThrow("fixture stalled");
  world.stall(null);
  // Same subject from the other side: the ROLLBACK reserved the unified stream. Pointed back at
  // `rollback-environment:` this reads 0.
  expect(world.guardVersion() % 2).toBe(1);

  const refusal = await refusalOf(world.migrateDown(MIGRATE_DOWN_ID));
  expect(refusal).toEqual({ code: "MIGRATE_DOWN_IN_PROGRESS", layer: DAEMON_COMMAND_SEAM });
  // The revert was not REACHED: neither the dump the effect takes first nor the revert itself ran.
  expect(world.effects()).toEqual({ dumps: 0, reverts: 0 });
});

/**
 * THE UPGRADE HAZARD, BOTH DIRECTIONS (DoD 6).
 *
 * A request admitted BEFORE the guard was shared reserved its command's PRIVATE stream and recorded
 * only the version it took. Point its recovery at the NEW stream and the release leg's
 * expectedVersion can never agree with a stream the request never reserved, so that commandId could
 * never finish and its environment would stay reserved forever. The leaf's header states the chosen
 * behaviour — such a request STILL COMPLETES, ON ITS ORIGINAL STREAM — and these two arms pin it.
 *
 * THE THIRD ARM IS WHAT STOPS THE FALLBACK BECOMING THE DEFAULT. If a FRESH request also took the
 * legacy path, the unification would not be in effect at all and every cross arm above would be
 * green for the wrong reason, so the fresh intents are decoded and their recorded id asserted.
 */

const ROLLBACK_INTENT = "daemon:rollback-command", MIGRATE_DOWN_INTENT = "daemon:migrate-down-command";

it("finishes a ROLLBACK admitted on the pre-change stream, releasing that stream and not the shared one", async () => {
  const world = await guardWorld();
  const legacyId = legacyRollbackGuardId(PROJECT_ID, ENVIRONMENT);
  const unifiedId = environmentSchemaGuardId(PROJECT_ID, ENVIRONMENT);
  // ADMIT IT THE OLD WAY, THEN LOSE THE PROCESS: the intent lands in the pre-change shape on the
  // pre-change stream and the terminal never commits, which is exactly the state a daemon upgraded
  // mid-request wakes up to.
  world.admitAsLegacy({ kind: "internal.deployment.rollback_requested", legacyId });
  world.stall("deployment.rollback");
  await expect(world.rollback("legacy-rollback", false)).rejects.toThrow("fixture stalled");
  world.admitAsLegacy(null);
  world.stall(null);

  // THE PLANTED STATE IS WHAT IT CLAIMS TO BE, asserted rather than assumed: the rewrite fired, the
  // intent carries guardVersion ALONE with no guardId, the legacy stream is reserved, and the
  // shared stream was never touched.
  expect(world.downgrades()).toBe(1);
  expect(world.intentBytes("legacy-rollback", ROLLBACK_INTENT)).toEqual({ guardVersion: 1 });
  expect(world.versionOf(legacyId)).toBe(1);
  expect(world.versionOf(unifiedId)).toBe(0);

  // RECOVERY, on the NEW code, for the SAME command id. It must finish.
  expect(await world.rollback("legacy-rollback", false)).toMatchObject({ disposition: "REPLAYED" });
  // ...having released the stream it really reserved. Even is released; the shared stream stays
  // untouched, which is the half that proves the fallback went to the ORIGINAL id and not to a
  // convenient one.
  expect(world.versionOf(legacyId)).toBe(2);
  expect(world.versionOf(unifiedId)).toBe(0);
});

it("finishes a MIGRATE_DOWN admitted on the pre-change stream, releasing that stream and not the shared one", async () => {
  const world = await guardWorld();
  const legacyId = legacyMigrateDownGuardId(PROJECT_ID, ENVIRONMENT);
  const unifiedId = environmentSchemaGuardId(PROJECT_ID, ENVIRONMENT);
  world.admitAsLegacy({ kind: "internal.deployment.migrate_down_requested", legacyId });
  world.stall("deployment.migrate_down");
  await expect(world.migrateDown("legacy-migrate-down")).rejects.toThrow("fixture stalled");
  world.admitAsLegacy(null);
  world.stall(null);

  expect(world.downgrades()).toBe(1);
  expect(world.intentBytes("legacy-migrate-down", MIGRATE_DOWN_INTENT)).toEqual({ guardVersion: 1 });
  expect(world.versionOf(legacyId)).toBe(1);
  expect(world.versionOf(unifiedId)).toBe(0);

  expect(await world.migrateDown("legacy-migrate-down")).toMatchObject({ resultCode: "REVERTED" });
  expect(world.versionOf(legacyId)).toBe(2);
  expect(world.versionOf(unifiedId)).toBe(0);
  // The revert itself was NOT repeated: the recovery answered from the receipt the first dispatch
  // already wrote, so an uncertain effect is finished rather than retried.
  expect(world.effects()).toEqual({ dumps: 1, reverts: 1 });
});

it("records the SHARED guard id in a FRESH intent of either command, so the fallback is never the default", async () => {
  const world = await guardWorld();
  const unifiedId = environmentSchemaGuardId(PROJECT_ID, ENVIRONMENT);
  // A complete rollback: it reserves the shared stream and RELEASES it, which is what lets the
  // revert below be admitted at all — and is itself the proof that the two commands are now
  // sequenced through one parity rather than passing each other on two.
  expect(await world.rollback("fresh-rollback", false)).toMatchObject({ disposition: "DECIDED" });
  expect(world.versionOf(unifiedId)).toBe(2);
  expect(await world.migrateDown("fresh-migrate-down")).toMatchObject({ resultCode: "REVERTED" });
  expect(world.versionOf(unifiedId)).toBe(4);

  // THE SUBJECT: both fresh intents recorded the SHARED id, so neither will take the legacy
  // fallback on recovery. Asserted against the exact id, not merely "some string".
  expect(world.intentBytes("fresh-rollback", ROLLBACK_INTENT)).toEqual({ guardId: unifiedId, guardVersion: 1 });
  expect(world.intentBytes("fresh-migrate-down", MIGRATE_DOWN_INTENT)).toEqual({ guardId: unifiedId, guardVersion: 3 });
  // No legacy stream was touched by either fresh request.
  expect(world.versionOf(legacyRollbackGuardId(PROJECT_ID, ENVIRONMENT))).toBe(0);
  expect(world.versionOf(legacyMigrateDownGuardId(PROJECT_ID, ENVIRONMENT))).toBe(0);
});

/**
 * A TAMPERED OR CORRUPTED INTENT REFUSES; IT NEVER GUESSES A STREAM.
 *
 * Found by reading the diff adversarially rather than by the plan. The recovery branch distinguishes
 * a guardId that is ABSENT (a pre-change intent, take the legacy stream) from one that is PRESENT
 * but unusable. JSON can carry an explicit `"guardId": null`, and an implementation that collapsed
 * "absent" and "null" would route such an intent to the legacy stream in silence — reserving one
 * stream and releasing another, which is the whole failure class this row exists to close. Both
 * commands must refuse instead, each with its OWN existing code.
 */
it("refuses a recovery whose intent carries a PRESENT but unusable guard id, on both commands", async () => {
  // ONE WORLD PER CASE, and that is not tidiness. A refused recovery leaves the guard ODD — the
  // mechanism working — so a second command on the same store would answer IN_PROGRESS and the arm
  // would assert the wrong refusal. Measured: the first draft shared a world and the migrate_down
  // half came back MIGRATE_DOWN_IN_PROGRESS instead of the result-invalid code it is about.
  for (const guardId of [null, 42, ""] as const) {
    // Rewrite the intent to carry the bad id INSTEAD of the real one. The key STAYS, so this is not
    // a pre-change intent and neither command may fall back to a legacy stream for it.
    const first = await guardWorld();
    first.corruptIntent({ kind: "internal.deployment.rollback_requested", guardId });
    first.stall("deployment.rollback");
    await expect(first.rollback("legacy-rollback", false)).rejects.toThrow("fixture stalled");
    first.corruptIntent(null);
    first.stall(null);
    expect((await refusalOf(first.rollback("legacy-rollback", false))).code)
      .toBe("DEPLOY_ROLLBACK_RECEIPT_INVALID");

    // THE REVERT REFUSES ONE DISPATCH EARLIER, and the asymmetry is real rather than a fixture
    // artefact: `migrationCommandHistory` re-validates the intent's shape on EVERY dispatch, so the
    // corrupt id is caught inside `finishMigrationCommand` on the same call that wrote it — before
    // the terminal is even attempted. The rollback validates only in its recovery branch, so it
    // needs the second dispatch above. Both fail closed; they just fail closed at different lines.
    const second = await guardWorld();
    second.corruptIntent({ kind: "internal.deployment.migrate_down_requested", guardId });
    expect((await refusalOf(second.migrateDown("legacy-migrate-down"))).code)
      .toBe("MIGRATE_DOWN_COMMAND_RESULT_INVALID");
    second.corruptIntent(null);
    // ...and the refusal is durable: a retry of the SAME command id answers the same way rather
    // than quietly reserving a second stream.
    expect((await refusalOf(second.migrateDown("legacy-migrate-down"))).code)
      .toBe("MIGRATE_DOWN_COMMAND_RESULT_INVALID");
  }
});
