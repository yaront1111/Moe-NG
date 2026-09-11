import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { afterEach, expect, it } from "vitest";
import { closeStores, driveThrough, openStore, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { setEnvironmentVariable } from "../environment/environment-store.js";
import type { CommandHandlerInput } from "../http/http-contract.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { MIGRATION_RECEIPT_COMMAND_KIND, MIGRATION_RECEIPT_PRINCIPAL, migrationReceiptId, readMigrationReceipt }
  from "../repository/migrations/migration-receipt.js";
import type { MigrationReceipt } from "../repository/migrations/migration-receipt.js";
import { migrateWithBackup } from "../repository/migrations/migration-service.js";
import { readDeployLedger, recordDeployReceipt } from "./deploy-ledger.js";
import { DEPLOY_MIGRATION_DATABASE_VARIABLE } from "./deploy-migration-context.js";
import { createAsyncCommandEntries } from "../daemon-command-async-entries.js";
import { createDockerDouble } from "./deploy-ports.js";
import { candidateContainerName } from "./deploy-service.js";
import { DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND, createMigrateDownCommandHandler } from "./migrate-down-command.js";
import { DEPLOYMENT_DEPLOY_COMMAND_KIND } from "./deploy-target-contracts.js";
import { createRollbackCommandHandler } from "./rollback-command.js";
import { ROLLBACK_RESTORE_DETAILS, ROLLBACK_RESTORE_STAMP } from "./rollback-restore.js";
import { ROLLBACK_RESTORE_PRINCIPAL } from "./rollback-schema-moves.js";

/**
 * WHICH DUMP A RESTORING ROLLBACK APPLIES WHEN THE SCHEMA MOVED OUTSIDE THE DEPLOY LEDGER.
 *
 * `rollback-command-ordering.test.ts` (vii)-(ix) already pin the walk against histories made only
 * of deploys and rollbacks. This file is the two cases that history cannot express, both of which
 * end with an older image started on a newer schema and neither of which refuses today:
 *
 *   - a `deployment.migrate_down`, which records a migration receipt under its OWN request id and
 *     no deploy receipt at all, so it is invisible to a walk over deploy receipts;
 *   - a deploy that COMMITS INSIDE a restoring rollback, between that rollback's restore marker
 *     and its own deploy receipt, so deploy-receipt order disagrees with the order the schema
 *     actually moved in.
 *
 * THE SCHEMA IS A REAL SHARED STATE, not a label. One `tables` set backs the forward `apply`, the
 * reverse `revert` and every `dump`, so a dump's BYTES are the schema as it stood when it was
 * taken. Every assertion below compares dump CONTENT as well as identity: an arm that only checked
 * which file was chosen would stay green under a fix that chose the right file for the wrong
 * reason, and the harm this row exists to stop is a database restored to the wrong CONTENT.
 *
 * PRODUCTION WRITERS AND HANDLERS THROUGHOUT. Deploys go through `recordDeployReceipt`, forward
 * migrations through `migrateWithBackup`, the revert through the REGISTERED `deployment.migrate_down`
 * handler, and every rollback through `createRollbackCommandHandler`. The only doubles are the
 * host ports — docker, the migration engine's dump/apply/revert, and the restore port — so a
 * restore marker exists exactly where a restore was really applied.
 *
 * TEARDOWN: every temp root is removed in `afterEach`, store handles by `closeStores`. No
 * container, no port and no child process is created here.
 */

afterEach(closeStores);

const ENVIRONMENT = "production";
const SHA_A = "1".repeat(40), SHA_B = "2".repeat(40), SHA_C = "3".repeat(40), SHA_D = "4".repeat(40);
/** Credential-shaped ON PURPOSE, so a leak onto a durable surface would be findable. */
const DATABASE_URL = "postgres://app:sch3ma-m0ves-s3cr3t@db.internal:5432/app";
const CREDENTIAL = "rollback-schema-moves-environment-credential";
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
/** The prerequisite deploy `deployment.migrate_down` admission requires, on its own sha so it can
 *  never be mistaken for part of a history under test. */
const SEED_DEPLOY = "dep-seed", SEED_SHA = "9".repeat(40);
/** Every migration file this suite applies, and the table each one creates. */
const TABLES: Readonly<Record<string, string>> = Object.freeze({
  "1700000000001_a.js": "a_table",
  "1700000000002_b.js": "b_table",
  "1700000000003_c.js": "c_table",
  "1700000000004_d.js": "d_table",
});
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) continue;
    try { rmSync(root, { force: true, recursive: true }); }
    catch { /* a held handle on Windows must not mask a test failure */ }
  }
});

interface Rollback { readonly commandId: string; readonly targetSha: string }

/**
 * ONE PROJECT, ONE ENVIRONMENT, and every command that can move its schema.
 *
 * `rollbacks` names each rollback this history will run with its TARGET's sha, because the
 * candidate container's name carries both and the engine's health probe reads that name.
 */
async function world(rollbacks: readonly Rollback[]) {
  const store = openStore();
  // The bootstrap state `deployment.migrate_down`'s admission requires; the rollback handler needs
  // none of it, which is why the deploy-only arms elsewhere can run without it.
  driveThrough(store, "goal.close");
  const root = mkdtempSync(join(tmpdir(), "moe-rollback-schema-moves-"));
  roots.push(root);
  const credential = (): string => CREDENTIAL;

  /** THE SCHEMA ITSELF: one set, moved by apply and revert, read by every dump. */
  const tables = new Set<string>();
  const schema = (): readonly string[] => [...tables].sort();
  const dumpText = (): string => `-- ${schema().join(",")}\n`;
  const dump = async (_connection: string, path: string): Promise<void> => { writeFileSync(path, dumpText()); };

  const docker = createDockerDouble({
    proxyConfig: deploymentInfrastructureFiles("", []).get("docker/Caddyfile") ?? "",
    running: { app: "HEALTHY" }, imageDigest: IMAGE_DIGEST,
    health: Object.fromEntries([
      [candidateContainerName(ENVIRONMENT, SEED_SHA, SEED_DEPLOY), ["HEALTHY"]],
      ...rollbacks.map(entry =>
        [candidateContainerName(ENVIRONMENT, entry.targetSha, entry.commandId), ["HEALTHY"]]),
    ]),
  });
  /** Every dump the restore port was handed, in order — the only evidence of what was applied. */
  const applied: string[] = [];
  /**
   * THE INTERLEAVE SEAM, and it exists because the hazard it builds is a REAL WINDOW rather than a
   * contrivance. A restoring rollback writes its restore marker the moment the dump lands, then
   * starts a candidate, polls it healthy and flips the proxy, and only THEN commits its deploy
   * receipt. Its environment guard fences rollbacks, not deploys
   * (`git grep -n 'rollback-environment:' -- apps/daemon/src/deployment ':!*.test.ts'` hits
   * rollback-command.ts alone), so an ordinary deploy can run to completion inside that window.
   *
   * The armed callback fires on the first DOCKER call made once the marker exists — that is, in the
   * candidate-start phase, after the restore and before the receipt. It uses only the port seam; no
   * store proxy, no patched module.
   */
  let armed: { readonly commandId: string; readonly run: () => Promise<void> } | null = null;
  const dockerPort: typeof docker.docker = async (args, stdin) => {
    if (armed !== null && store.getCommandDecision({
      commandId: armed.commandId, principalId: ROLLBACK_RESTORE_PRINCIPAL, projectId: PROJECT_ID }) !== null) {
      const pending = armed;
      armed = null;
      await pending.run();
    }
    return docker.docker(args, stdin);
  };
  const armInterleave = (commandId: string, run: () => Promise<void>): void => { armed = { commandId, run }; };
  const ports = { build: docker.build, docker: dockerPort, ssh: docker.ssh, transfer: docker.transfer,
    target: () => ({ network: "product", sshTarget: null, url: null }), releaseDecision: () => null };

  const send = async (commandKind: string, commandId: string, payload: Readonly<Record<string, unknown>>,
    handler: (input: CommandHandlerInput) => Promise<unknown>): Promise<unknown> => handler({
    principal: { principalId: "operator", projectId: PROJECT_ID, capabilities: ["goal.write"] },
    envelope: { commandId, commandKind, correlationId: `corr-${commandId}`,
      // READ from the store rather than pinned: a literal starts refusing CONFLICT as history grows.
      expectedVersion: store.getAggregateVersion(PROJECT_ID), payload,
      requestDigest: "c".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: "schema-moves-credential", targetAggregateId: PROJECT_ID },
  } as CommandHandlerInput);

  /**
   * THE PREREQUISITE DEPLOY, through the REGISTERED `deployment.deploy`.
   * `bootstrap-sequence.ts:64` makes `deployment.migrate_down` require a `deployment.deploy`
   * decision, and `bootstrapSequence()` carries no deploy, so without this the revert refuses
   * BOOTSTRAP_PREREQUISITE_MISSING and every arm here would be testing the admission fence.
   *
   * It runs BEFORE the database variable is bound and its entries table carries NO
   * `environmentCredential`, so `resolveDeployMigrationContext` refuses this deploy's migration
   * and it moves no schema. That keeps the seed out of every dump comparison below.
   */
  const entries = createAsyncCommandEntries({ operatorPrincipalId: "operator", projectId: PROJECT_ID, store,
    deploymentDeploy: { buildContext: root, clock: () => "2026-09-05T00:00:00.000Z",
      healthBudgetMs: 1, pollMs: 1, sleep: async () => {}, ports } });
  const seedHandler = entries[DEPLOYMENT_DEPLOY_COMMAND_KIND].asyncHandler;
  if (seedHandler === undefined) throw new Error("deployment.deploy carries no async handler");
  await send(DEPLOYMENT_DEPLOY_COMMAND_KIND, SEED_DEPLOY, { environment: ENVIRONMENT, sha: SEED_SHA }, seedHandler);
  expect(schema(), "the prerequisite deploy must not migrate").toEqual([]);

  // Bound only NOW, so the seed above could not reach it. A silently refused seed would make every
  // later assertion vacuous.
  expect(setEnvironmentVariable({ credential, now: () => "2026-09-06T00:00:00.000Z", projectId: PROJECT_ID, store },
    { environment: ENVIRONMENT, name: DEPLOY_MIGRATION_DATABASE_VARIABLE, value: DATABASE_URL })).toMatchObject({ ok: true });

  const migrateDownHandler = createMigrateDownCommandHandler({
    operatorPrincipalId: "operator", projectId: PROJECT_ID, store,
    hostContext: (environment: string) => environment === ENVIRONMENT
      ? { databaseUrl: DATABASE_URL, projectRoot: root, workspace: root } : null,
    ports: { dump, revert: async (_workspace, _connection, batch) => {
      for (const name of batch) tables.delete(TABLES[name] ?? name);
      return [...batch].reverse();
    } },
  });

  const deploy = (decisionId: string, sha: string, decidedAt: string): string => {
    const recorded = recordDeployReceipt(store, { projectId: PROJECT_ID, environment: ENVIRONMENT, sha,
      imageDigest: IMAGE_DIGEST, decisionId, decidedAt, refusal: null, releaseDecision: null, url: null });
    if (!recorded.ok) throw new Error(recorded.code);
    return recorded.receipt.receiptId;
  };
  /**
   * THE REAL FORWARD SERVICE. It dumps BEFORE it applies, so the receipt's `backupRef` is the
   * schema as it stood before this migration. `decidedAt` must be DISTINCT per migration in one
   * environment: `migration-service.ts:60` names the dump file after the timestamp's digits and
   * refuses MIGRATION_BACKUP_FAILED on a collision, so a constant clock here would silently turn
   * every migration after the first into a refusal and make the arms vacuous.
   */
  const migrate = async (requestId: string, sha: string, file: string, decidedAt: string): Promise<void> => {
    const receipt = await migrateWithBackup(store, { databaseUrl: DATABASE_URL, environment: ENVIRONMENT,
      now: new Date(decidedAt), projectId: PROJECT_ID, projectRoot: root, requestId, sha, workspace: root }, {
      dump, apply: async (): Promise<readonly string[]> => { tables.add(TABLES[file] ?? file); return [file]; },
    });
    expect(receipt, `migration ${requestId} did not apply`)
      .toMatchObject({ applied: [file], outcome: "APPLIED", refusal: null });
  };
  /**
   * THE ONLY WAY A NULL `backupRef` IS REALLY PRODUCED: the dump port fails, so `execute` never
   * reaches `apply`, deletes the file it owned and records the REFUSED base receipt. Routed through
   * the same production `migrateWithBackup`, not a hand-built receipt, so the shape under test is
   * the shape the tree writes.
   */
  const migrateWithFailingDump = async (
    requestId: string, sha: string, decidedAt: string,
  ): Promise<MigrationReceipt> => migrateWithBackup(store, { databaseUrl: DATABASE_URL,
    environment: ENVIRONMENT, now: new Date(decidedAt), projectId: PROJECT_ID, projectRoot: root,
    requestId, sha, workspace: root }, {
    dump: async (): Promise<void> => { throw new Error("BACKUP_FAILED"); },
    apply: async (): Promise<readonly string[]> => { throw new Error("apply must not be reached"); },
  });
  const migrateDown = async (commandId: string, toMigrationRequestId: string): Promise<unknown> =>
    send(DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND, commandId,
      { environment: ENVIRONMENT, toMigrationRequestId }, migrateDownHandler);

  /** READ BACK FROM THE STORE, never a path repeated from the fixture: the identifier is the assertion. */
  const dumpOf = (requestId: string): string => {
    const ref = readMigrationReceipt(store, PROJECT_ID, requestId)?.backupRef;
    if (ref === undefined || ref === null) throw new Error(`no backupRef recorded for ${requestId}`);
    return ref.slice(0, ref.lastIndexOf("@sha256:"));
  };
  const contentOf = (path: string): string => readFileSync(path, "utf8");
  /** The environment's deploy history as the OLD walk read it, oldest first. */
  const ledger = (): readonly string[] =>
    readDeployLedger(store, PROJECT_ID).get(ENVIRONMENT)?.receipts.map(receipt => receipt.decisionId) ?? [];
  /** The applied-restore marker, under the principal the production handler writes it with. */
  const marker = (commandId: string) =>
    store.getCommandDecision({ commandId, principalId: ROLLBACK_RESTORE_PRINCIPAL, projectId: PROJECT_ID });

  const rollbackWith = (clock: () => string) => {
    const handler = createRollbackCommandHandler({ operatorPrincipalId: "operator", projectId: PROJECT_ID, store,
      clock, healthBudgetMs: 1, pollMs: 1, sleep: async () => {}, ports,
      environmentCredential: credential, migrationWorkspace: root,
      backupPorts: { restoreDatabaseInto: async (_connection: string, path: string): Promise<void> => {
        applied.push(path);
        // The restore really replaces the schema, so a LATER dump records what the restore left.
        tables.clear();
        for (const name of contentOf(path).replace("--", "").trim().split(",")) {
          if (name.length > 0) tables.add(name);
        }
      } } });
    return (commandId: string, toReceiptRef: string, restoreDatabase: boolean): Promise<unknown> =>
      send("deployment.rollback", commandId, { environment: ENVIRONMENT, toReceiptRef, restoreDatabase }, handler);
  };
  const rollback = rollbackWith(() => "2026-09-06T02:00:00.000Z");
  return { applied, armInterleave, contentOf, deploy, dumpOf, ledger, marker, migrate, migrateDown,
    migrateWithFailingDump, rollback, rollbackWith, schema, store };
}

/** A dispatch's own disposition, read off an intentionally `unknown` answer: the handler's return
 *  type is not this file's subject and asserting through a cast keeps it from becoming one. */
const dispositionOf = (answer: unknown): unknown => (answer as { readonly disposition?: unknown }).disposition;

/** The refusal a throwing dispatch produced, or a failure naming what came back instead — so an arm
 *  cannot pass by swallowing a success it was supposed to refuse. */
async function refusalOf(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    const answered = await promise;
    throw new Error(`expected a refusal, received ${JSON.stringify(answered)}`);
  } catch (error) {
    if (error instanceof Error && "code" in error) return error as unknown as Record<string, unknown>;
    throw error;
  }
}

/**
 * (x) THE ROW'S OWN DEFECT: A `deployment.migrate_down` BETWEEN THE TARGET AND THE NEXT DEPLOY.
 *
 * dep-a migrates, dep-b migrates, and `deployment.migrate_down` then reverts dep-b's batch — its
 * OWN pre-revert dump is therefore the schema dep-b ran ON, and it is the only copy of it anywhere.
 * dep-d then migrates from the reverted database, so dep-d's dump holds dep-a's schema.
 *
 * A rollback to dep-b WITH a restore has exactly one honest answer: the revert's dump. The old walk
 * could not even see the revert — it records no deploy receipt — so it stopped at dep-d, applied a
 * schema with no `b_table` in it under dep-b's image, and refused nothing.
 */
it("(x) a migrate_down between the target and the next deploy supplies the dump, not that deploy", async () => {
  const h = await world([{ commandId: "rb-b", targetSha: SHA_B }]);
  h.deploy("dep-a", SHA_A, "2026-09-06T00:00:00.000Z");
  await h.migrate("dep-a", SHA_A, "1700000000001_a.js", "2026-09-06T00:10:00.000Z");
  const b = h.deploy("dep-b", SHA_B, "2026-09-06T00:20:00.000Z");
  await h.migrate("dep-b", SHA_B, "1700000000002_b.js", "2026-09-06T00:30:00.000Z");
  expect(h.schema()).toEqual(["a_table", "b_table"]);

  await h.migrateDown("md-1", "dep-b");
  // THE REVERT REALLY RAN, through the registered command: the schema went back and the receipt
  // says REVERTED. Without this the rest of the arm would be asserting against a no-op.
  expect(h.schema()).toEqual(["a_table"]);
  expect(readMigrationReceipt(h.store, PROJECT_ID, "md-1"))
    .toMatchObject({ applied: ["1700000000002_b.js"], environment: ENVIRONMENT, outcome: "REVERTED", refusal: null });

  h.deploy("dep-d", SHA_D, "2026-09-06T00:40:00.000Z");
  await h.migrate("dep-d", SHA_D, "1700000000004_d.js", "2026-09-06T00:50:00.000Z");

  // THE CASE WAS ACTUALLY BUILT. The revert is NOWHERE in the deploy ledger — that invisibility is
  // the defect — and the two candidate dumps are different files holding different schemas.
  expect(h.ledger()).toEqual([SEED_DEPLOY, "dep-a", "dep-b", "dep-d"]);
  expect(h.dumpOf("md-1")).not.toBe(h.dumpOf("dep-d"));
  expect(h.contentOf(h.dumpOf("md-1"))).toBe("-- a_table,b_table\n");
  expect(h.contentOf(h.dumpOf("dep-d"))).toBe("-- a_table\n");

  expect(dispositionOf(await h.rollback("rb-b", b, true))).toBe("DECIDED");

  // THE RESTORE PORT'S RECORDED CALLS, read back: exactly one dump, and it is the REVERT's.
  expect(h.applied).toEqual([h.dumpOf("md-1")]);
  expect(h.applied).not.toEqual([h.dumpOf("dep-d")]);
  // ...and its CONTENT is the schema dep-b ran on, `b_table` included. This is the assertion the
  // defect fails on: dep-d's dump has no `b_table`, so dep-b's image would have started without it.
  expect(h.contentOf(h.applied[0] ?? "")).toBe("-- a_table,b_table\n");
  expect(h.schema()).toEqual(["a_table", "b_table"]);
  expect(h.marker("rb-b")).not.toBeNull();
});

/**
 * (xi) THE INTERLEAVED RESTORE — the hazard qa-77a9823a recorded against the parent row at 11:10,
 * and the reason step 3's ordering key is LOAD-BEARING rather than tidiness.
 *
 * A restoring rollback is not atomic against deploys. rb-r applies its dump and commits its marker,
 * then starts a candidate, polls it healthy and flips the proxy; only then does its deploy receipt
 * land. `armInterleave` runs dep-d's whole migrate-and-deploy INSIDE that window, so:
 *
 *   DEPLOY RECEIPTS read    [..., dep-c, dep-d, rb-r]  — rb-r LAST, because it reported last
 *   DECISION POSITIONS read [..., dep-c, rb-r's MARKER, dep-d, rb-r's receipt]
 *
 * A walk over deploy receipts never reaches rb-r's marker: it stops at dep-d and applies dep-d's
 * dump, which is the RESTORED schema, under dep-c's image — the parent's defect family with a race
 * in place of a history. A walk over `decision_position` meets the MARKER first, because the marker
 * committed when the restore actually happened, and refuses.
 */
it("(xi) a deploy that commits INSIDE a restoring rollback does not become the chosen dump", async () => {
  const h = await world([{ commandId: "rb-r", targetSha: SHA_A }, { commandId: "rb-c", targetSha: SHA_C }]);
  h.deploy("dep-a", SHA_A, "2026-09-06T00:00:00.000Z");
  await h.migrate("dep-a", SHA_A, "1700000000001_a.js", "2026-09-06T00:10:00.000Z");
  const a = h.deploy("dep-a2", SHA_A, "2026-09-06T00:15:00.000Z");
  const c = h.deploy("dep-c", SHA_C, "2026-09-06T00:20:00.000Z");
  await h.migrate("dep-c", SHA_C, "1700000000003_c.js", "2026-09-06T00:30:00.000Z");
  expect(h.schema()).toEqual(["a_table", "c_table"]);

  // dep-d migrates from the RESTORED database, inside rb-r's candidate phase.
  h.armInterleave("rb-r", async () => {
    await h.migrate("dep-d", SHA_D, "1700000000004_d.js", "2026-09-06T00:50:00.000Z");
    h.deploy("dep-d", SHA_D, "2026-09-06T00:55:00.000Z");
  });
  expect(dispositionOf(await h.rollback("rb-r", a, true))).toBe("DECIDED");

  // THE CASE WAS ACTUALLY BUILT, and this is what makes the arm non-vacuous: the DEPLOY LEDGER puts
  // dep-d BEFORE rb-r, so a receipt-ordered walk stops at dep-d and never sees the marker. If the
  // interleave ever stopped happening this list would read [..., rb-r, dep-d] and the arm would be
  // testing an ordinary history instead.
  expect(h.ledger()).toEqual([SEED_DEPLOY, "dep-a", "dep-a2", "dep-c", "dep-d", "rb-r"]);
  expect(h.marker("rb-r")).not.toBeNull();
  // dep-d's dump is the RESTORED schema — dep-a's, with no c_table — so pairing it with dep-c's
  // image is exactly the harm. It is also a different file from anything else on offer.
  expect(h.contentOf(h.dumpOf("dep-d"))).toBe("-- a_table\n");
  expect(h.dumpOf("dep-d")).not.toBe(h.dumpOf("dep-c"));

  expect(await refusalOf(h.rollback("rb-c", c, true))).toMatchObject({
    code: "DEPLOY_ROLLBACK_RESTORE_SCHEMA_OVERWRITTEN", layer: ROLLBACK_RESTORE_STAMP,
    detail: ROLLBACK_RESTORE_DETAILS.DEPLOY_ROLLBACK_RESTORE_SCHEMA_OVERWRITTEN,
  });
  // NOT REACHED: the port still holds rb-r's single call, so dep-d's dump was never applied.
  expect(h.applied).toEqual([h.dumpOf("dep-c")]);
  expect(h.marker("rb-c")).toBeNull();
});

/**
 * (xii) THE CLOCKS CROSSED. Two schema moves whose `decidedAt` order is the REVERSE of their commit
 * order, where only commit order gives the safe answer.
 *
 * rb-r's marker is stamped 09:00 by the rollback's clock and commits FIRST; dep-d's migration is
 * stamped 00:50 and commits SECOND. Ordering by `decision_position` meets the marker first and
 * refuses. Ordering by `decidedAt` — which the base plan called for — puts dep-d's migration first
 * and hands back its dump with no refusal at all. A clock that ties or steps backwards is not
 * hypothetical: every rollback fixture in this directory runs a constant one, and a production
 * clock adjustment does the same thing.
 */
it("(xii) a clock that disagrees with commit order does not reorder the schema history", async () => {
  const h = await world([{ commandId: "rb-r", targetSha: SHA_A }, { commandId: "rb-b", targetSha: SHA_B }]);
  const a = h.deploy("dep-a", SHA_A, "2026-09-06T00:00:00.000Z");
  await h.migrate("dep-a", SHA_A, "1700000000001_a.js", "2026-09-06T00:10:00.000Z");
  const b = h.deploy("dep-b", SHA_B, "2026-09-06T00:15:00.000Z");
  await h.migrate("dep-b", SHA_B, "1700000000002_b.js", "2026-09-06T00:20:00.000Z");

  // THE MARKER IS STAMPED LATE, and commits first.
  expect(dispositionOf(await h.rollbackWith(() => "2026-09-06T09:00:00.000Z")("rb-r", a, true))).toBe("DECIDED");
  expect(h.marker("rb-r")).not.toBeNull();
  // THE MIGRATION IS STAMPED EARLY, and commits second.
  await h.migrate("dep-d", SHA_D, "1700000000004_d.js", "2026-09-06T00:50:00.000Z");
  h.deploy("dep-d", SHA_D, "2026-09-06T00:55:00.000Z");

  // THE DISAGREEMENT IS REAL, read off the records themselves rather than the fixture's literals:
  // the record that committed FIRST carries the LATER timestamp.
  const migration = h.store.getCommandDecision({ commandId: migrationReceiptId(PROJECT_ID, "dep-d"),
    principalId: MIGRATION_RECEIPT_PRINCIPAL, projectId: PROJECT_ID });
  expect(migration).not.toBeNull();
  expect((h.marker("rb-r")?.decidedAt ?? "") > (migration?.decidedAt ?? "")).toBe(true);
  expect((h.marker("rb-r")?.decisionPosition ?? 0n) < (migration?.decisionPosition ?? 0n)).toBe(true);

  expect(await refusalOf(h.rollback("rb-b", b, true))).toMatchObject({
    code: "DEPLOY_ROLLBACK_RESTORE_SCHEMA_OVERWRITTEN", layer: ROLLBACK_RESTORE_STAMP,
    detail: ROLLBACK_RESTORE_DETAILS.DEPLOY_ROLLBACK_RESTORE_SCHEMA_OVERWRITTEN,
  });
  expect(h.applied).toEqual([h.dumpOf("dep-b")]);
  expect(h.marker("rb-b")).toBeNull();
});

/**
 * (xiii) RULE 2, WHICH NOTHING PINNED BEHAVIOURALLY BEFORE THIS ROW. A migration record whose bytes
 * will not decode answers DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNVERIFIED — it is NOT skipped, and it
 * is NOT read as an absence.
 *
 * Corruption cannot be produced through `recordMigrationReceipt`, which validates before it writes,
 * so this arm commits the decision directly under the key and kind the reader recognises. That is
 * the whole point: "unreadable" and "nothing happened" are the same shape to a walk that only asks
 * whether a receipt came back, and one of them moved a schema.
 */
it("(xiii) a migration record that will not decode refuses UNVERIFIED rather than being skipped", async () => {
  const h = await world([{ commandId: "rb-a", targetSha: SHA_A }]);
  const a = h.deploy("dep-a", SHA_A, "2026-09-06T00:00:00.000Z");
  await h.migrate("dep-a", SHA_A, "1700000000001_a.js", "2026-09-06T00:10:00.000Z");

  const receiptId = migrationReceiptId(PROJECT_ID, "dep-corrupt");
  const bytes = new TextEncoder().encode(JSON.stringify({ version: "moe-migration-receipt/1", corrupt: true }));
  const written = h.store.commitExpectedVersionDecision({
    commandKind: MIGRATION_RECEIPT_COMMAND_KIND, committedResultBytes: bytes,
    correlationId: "dep-corrupt", decidedAt: "2026-09-06T00:30:00.000Z", expectedVersion: 0,
    events: [{ eventId: receiptId + "-recorded", eventType: "MigrationRecorded", payload: bytes }],
    key: { commandId: receiptId, principalId: MIGRATION_RECEIPT_PRINCIPAL, projectId: PROJECT_ID },
    requestBytes: bytes, targetAggregateId: "migration:" + receiptId,
  });
  // A silently refused write would leave this arm asserting against an absence.
  expect(written.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
  // ...and a LATER, perfectly readable dump exists, so "skipped" and "refused" give different
  // answers here. Without it the arm could not tell a refusal from an exhausted walk.
  await h.migrate("dep-d", SHA_D, "1700000000004_d.js", "2026-09-06T00:50:00.000Z");
  h.deploy("dep-d", SHA_D, "2026-09-06T00:55:00.000Z");

  expect(await refusalOf(h.rollback("rb-a", a, true))).toMatchObject({
    code: "DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNVERIFIED", layer: ROLLBACK_RESTORE_STAMP,
    detail: ROLLBACK_RESTORE_DETAILS.DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNVERIFIED,
  });
  expect(h.applied).toEqual([]);
  expect(h.marker("rb-a")).toBeNull();
});

/**
 * (xiv) RULE 1, pinned in the walk's own file. `rollback-restore.test.ts` (c) already reaches
 * BACKUP_ABSENT through a seeded receipt; this reaches it through the REAL forward service with a
 * failing dump port, which is how a null `backupRef` is actually produced in the tree.
 *
 * A migration whose DUMP failed records REFUSED with no `backupRef` — the only shape the decoder
 * admits with a null one (`migration-receipt.ts:88`). The walk must refuse there rather than skip
 * to dep-d's dump, which is a LATER state and would destroy strictly more than the rollback asked.
 */
it("(xiv) a migration that recorded no dump refuses BACKUP_ABSENT rather than skipping to a later one", async () => {
  const h = await world([{ commandId: "rb-a", targetSha: SHA_A }]);
  const a = h.deploy("dep-a", SHA_A, "2026-09-06T00:00:00.000Z");
  await h.migrate("dep-a", SHA_A, "1700000000001_a.js", "2026-09-06T00:10:00.000Z");

  const refused = await h.migrateWithFailingDump("dep-nodump", SHA_B, "2026-09-06T00:30:00.000Z");
  // THE SHAPE WAS ACTUALLY PRODUCED: REFUSED, no dump, and the schema untouched.
  expect(refused).toMatchObject({ backupRef: null, outcome: "REFUSED" });
  expect(h.schema()).toEqual(["a_table"]);
  // ...and a later, readable dump exists, so skipping would have somewhere to go.
  await h.migrate("dep-d", SHA_D, "1700000000004_d.js", "2026-09-06T00:50:00.000Z");
  h.deploy("dep-d", SHA_D, "2026-09-06T00:55:00.000Z");

  expect(await refusalOf(h.rollback("rb-a", a, true))).toMatchObject({
    code: "DEPLOY_ROLLBACK_RESTORE_BACKUP_ABSENT", layer: ROLLBACK_RESTORE_STAMP,
    detail: ROLLBACK_RESTORE_DETAILS.DEPLOY_ROLLBACK_RESTORE_BACKUP_ABSENT,
  });
  expect(h.applied).toEqual([]);
});
