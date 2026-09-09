import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { expect, it } from "vitest";
import type { SqliteEventStore } from "@moe/store";

import { nodeBackupPorts } from "../backups/backup-ports.js";
import { closeStores, driveThrough, openStore, PROJECT_ID }
  from "../bootstrap/bootstrap-test-fixtures.js";
import { createAsyncCommandEntries } from "../daemon-command-async-entries.js";
import { setEnvironmentVariable } from "../environment/environment-store.js";
import type { AuthenticatedPrincipal } from "../http/http-contract.js";
import { createVerifierDatabaseRunner } from "../orchestrator/verifier-database.js";
import { CONTROLLED_PROFILE_VERSION, generateControlledProfile }
  from "../repository/controlled-profile/controlled-profile-generator.js";
import { deploymentInfrastructureFiles }
  from "../repository/deployment/deployment-infrastructure-templates.js";
import { migrateWithBackup } from "../repository/migrations/migration-service.js";
import { DEPLOY_MIGRATION_DATABASE_VARIABLE } from "./deploy-migration-context.js";
import { createDockerDouble } from "./deploy-ports.js";
import type { DeployTarget } from "./deploy-ports.js";
import { deployReceiptId } from "./deploy-receipt-contracts.js";
import { candidateContainerName } from "./deploy-service.js";
import { DEPLOYMENT_DEPLOY_COMMAND_KIND } from "./deploy-target-contracts.js";

/**
 * THE REAL RESTORE: `deployment.rollback` with `restore: true` against a live PostgreSQL, through
 * the registered command and the REAL `nodeBackupPorts`, with the schema read out of
 * `information_schema` before and after (DoD 4).
 *
 * Opt-in behind MOE_MIGRATION_RESTORE=1, the same flag the migrate-down real arm uses. With the
 * flag set and Docker unavailable this FAILS rather than silently skipping. The offline arms
 * (`rollback-restore.test.ts`, `rollback-command.test.ts`) prove the selection, the refusal codes
 * and the recorded-call arms on every machine; what this file adds is the one thing a double
 * cannot: that the recorded dump really lands on the bound destination and really takes the
 * mutation away.
 *
 * THE JOURNEY IS THE DoD'S, in order. Two deploys through the REAL deploy command (kept, then
 * current) so the rollback has a receipt to keep and a current receipt to restore FROM. The
 * current deploy's migration is applied through the REAL `migrateWithBackup`, which dumps BEFORE
 * it applies -- that dump IS the schema the kept deploy ran against, and it is the one this
 * rollback must restore. Then the schema is MUTATED further, out of band, so "the schema came
 * back" cannot be satisfied by a rollback that did nothing.
 *
 * NO CONNECTION VALUE ANYWHERE. The disposable database's URL is generated at runtime, sealed
 * into the environment store, and never written to a log line, an assertion message or this file.
 *
 * TEARDOWN on every path including failure: the holding recipe is released, the runner closed and
 * the temp root removed in nested `finally`s; the arm asserts Docker reports no verifier container
 * left and no NEW `moe-backup-*` container beyond whatever a peer seat already had running
 * (epic rail 4).
 */

const RUN = process.env.MOE_MIGRATION_RESTORE === "1";
const OPERATOR = "principal-1";
/** One of the three names the environment store has, which is what lets a destination be BOUND
 *  to it at all -- `environment-contracts.ts:29` is closed to {preview, production, verify}. */
const ENVIRONMENT = "production";
const CREDENTIAL = "rollback-restore-real-credential";
const KEPT_SHA = "0123456789abcdef0123456789abcdef01234567";
const CURRENT_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const KEPT_COMMAND = "cmd-deploy-kept";
const CURRENT_COMMAND = "cmd-deploy-current";
const ROLLBACK_COMMAND = "cmd-rollback-restore";
const DECIDED_AT = "2026-09-06T00:00:00.000Z";
const ADDED = "1700000000001_added.js";
const LOCAL: DeployTarget = { network: "moe-net", sshTarget: null, url: "https://app.example.test" };
const PROXY_CONFIG =
  deploymentInfrastructureFiles(CONTROLLED_PROFILE_VERSION, []).get("docker/Caddyfile") ?? "";

function docker(args: readonly string[]): string {
  const result = spawnSync("docker", [...args], { shell: false, windowsHide: true,
    timeout: 60_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 || result.error) throw new Error("ROLLBACK_RESTORE_TEST_DOCKER_FAILED");
  return result.stdout;
}

/** Containers the REAL backup ports mint. Peers may hold their own; only NEW ones are a leak. */
const backupContainers = (): readonly string[] =>
  docker(["ps", "-aq", "--filter", "name=^/moe-backup-"]).split("\n").map(line => line.trim()).filter(Boolean);

function materialize(root: string): void {
  const generated = generateControlledProfile({
    productName: "rollback-restore-proof", profileVersion: CONTROLLED_PROFILE_VERSION,
  });
  if (!generated.ok) throw new Error(`${generated.code}@${generated.refusedBy}`);
  for (const [path, body] of generated.files) {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body);
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("npm_") || key === "NODE_OPTIONS") delete env[key];
  const install = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: root, env, shell: false, encoding: "utf8", timeout: 600_000,
  });
  expect(install.error).toBeUndefined();
  expect(install.status, "GENERATED_PRODUCT_INSTALL_FAILED").toBe(0);
  writeFileSync(join(root, "holding-recipe.mjs"),
    "import { existsSync } from 'node:fs'; while (!existsSync('release')) await new Promise(r => setTimeout(r, 30));\n");
}

it("pins the live gate and the actual dispatch/restore imports", () => {
  expect(typeof createVerifierDatabaseRunner).toBe("function");
  expect(typeof createAsyncCommandEntries).toBe("function");
  // The DESTINATION-BOUND member, not the throwaway-container verification beside it: this file
  // would prove nothing if the production ports had lost the operation the rollback reaches for.
  expect(typeof nodeBackupPorts().restoreDatabaseInto).toBe("function");
  expect(DEPLOY_MIGRATION_DATABASE_VARIABLE).toBe("DATABASE_URL");
});

it.runIf(RUN)("restores the recorded dump to the bound destination and takes the mutation away", async () => {
  docker(["version", "--format", "{{.Server.Version}}"]);
  const foreignBackups = new Set(backupContainers());
  const root = mkdtempSync(join(tmpdir(), "moe-rollback-restore-live-"));
  const names: string[] = [];
  let ready: (url: string) => void = () => undefined;
  const connection = new Promise<string>(resolve => { ready = resolve; });
  const brief = { workspace: root, test: "node holding-recipe.mjs",
    instructions: "rollback restore proof", title: "rollback restore proof" };
  const runner = createVerifierDatabaseRunner({ timeoutMs: 180_000, spawn: (file, args, options) => {
    if (file === "docker" && args[0] === "run") names.push(args[args.indexOf("--name") + 1]!);
    if (file === brief.test && typeof options.env?.DATABASE_URL === "string") ready(options.env.DATABASE_URL);
    return spawn(file, [...args], options);
  } });
  let operation: ReturnType<typeof runner> | undefined;
  let store: SqliteEventStore | undefined;
  try {
    materialize(root);
    operation = runner(brief);
    const url = await Promise.race([connection,
      operation.then(() => { throw new Error("ROLLBACK_RESTORE_RECIPE_NOT_STARTED"); })]);
    expect(names).toHaveLength(1);
    const container = names[0]!;
    const query = (sql: string): string => docker(["exec", container, "psql", "-U", "app", "-d", "app",
      "-v", "ON_ERROR_STOP=1", "-tAc", sql]).trim();
    const schema = (): string => query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position");

    // BATCH ONE is the profile's own initial migration, applied by the disposable-database
    // lifecycle before the recipe ran. Read, never assumed.
    expect(schema()).toContain("app_metadata");

    store = openStore();
    driveThrough(store, "goal.close");
    // THE DESTINATION IS BOUND THROUGH THE CREDENTIAL SEAM, which is the only source DoD 1
    // admits. A silently refused seed would leave the rollback refusing UNAVAILABLE and the
    // whole arm proving the unbound path instead.
    expect(setEnvironmentVariable({ credential: (): string => CREDENTIAL, now: (): string => DECIDED_AT,
      projectId: PROJECT_ID, store }, { environment: ENVIRONMENT,
      name: DEPLOY_MIGRATION_DATABASE_VARIABLE, value: url })).toMatchObject({ ok: true });

    const double = createDockerDouble({
      proxyConfig: PROXY_CONFIG, running: { app: "HEALTHY" },
      health: {
        [candidateContainerName(ENVIRONMENT, KEPT_SHA, KEPT_COMMAND)]: ["HEALTHY"],
        [candidateContainerName(ENVIRONMENT, CURRENT_SHA, CURRENT_COMMAND)]: ["HEALTHY"],
        [candidateContainerName(ENVIRONMENT, KEPT_SHA, ROLLBACK_COMMAND)]: ["HEALTHY"],
      },
    });
    const entries = createAsyncCommandEntries({
      environmentCredential: (): string => CREDENTIAL,
      operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store,
      // `buildContext` is what `createAsyncCommandEntries` forwards to the rollback as
      // `migrationWorkspace`, so the restore resolves its destination against the SAME
      // host-scoped tree the deploy built from. The image side stays on the double: this arm
      // is about the DATABASE, and a real image build would prove nothing extra about it.
      deploymentDeploy: {
        buildContext: root, clock: (): string => DECIDED_AT,
        healthBudgetMs: 10, pollMs: 1, sleep: (): Promise<void> => Promise.resolve(),
        ports: { build: double.build, docker: double.docker, releaseDecision: (): string | null => null,
          ssh: double.ssh, target: (): DeployTarget => LOCAL, transfer: double.transfer },
      },
    });
    const deploy = entries[DEPLOYMENT_DEPLOY_COMMAND_KIND].asyncHandler;
    const rollback = entries["deployment.rollback"].asyncHandler;
    if (deploy === undefined || rollback === undefined) throw new Error("async handlers absent");
    const principal: AuthenticatedPrincipal =
      { capabilities: ["goal.write"], principalId: OPERATOR, projectId: PROJECT_ID };
    const envelopeFor = (
      kind: string, commandId: string, payload: Readonly<Record<string, unknown>>,
    ): RuntimeCommandEnvelope => ({
      commandId, commandKind: kind as RuntimeCommandEnvelope["commandKind"],
      correlationId: `corr-${commandId}`,
      expectedVersion: store!.getAggregateVersion(PROJECT_ID),
      payload: payload as RuntimeCommandEnvelope["payload"], requestDigest: "d".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: "rollback-restore-real-session", targetAggregateId: PROJECT_ID,
    });

    // THE KEPT DEPLOY, then THE CURRENT ONE. Both through the real command, so both receipts are
    // minted by production code and the ledger's `current` really is the second.
    await deploy({ envelope: envelopeFor(DEPLOYMENT_DEPLOY_COMMAND_KIND, KEPT_COMMAND,
      { environment: ENVIRONMENT, sha: KEPT_SHA }), principal });
    await deploy({ envelope: envelopeFor(DEPLOYMENT_DEPLOY_COMMAND_KIND, CURRENT_COMMAND,
      { environment: ENVIRONMENT, sha: CURRENT_SHA }), principal });

    // THE READING THE RESTORE MUST COME BACK TO, taken before the current deploy's migration.
    const beforeMigration = schema();

    // THE CURRENT DEPLOY'S MIGRATION, through the REAL forward engine: it dumps BEFORE it applies
    // and records the dump on the migration receipt under `requestId === decisionId`, which is
    // the durable join the rollback resolves the backup by.
    writeFileSync(join(root, "migrations", ADDED),
      "export const up = pgm => pgm.createTable('added_by_migration', { id: 'integer' });\n"
      + "export const down = pgm => pgm.dropTable('added_by_migration');\n");
    const applied = await migrateWithBackup(store, {
      databaseUrl: url, environment: ENVIRONMENT, now: new Date(DECIDED_AT), projectId: PROJECT_ID,
      projectRoot: root, requestId: CURRENT_COMMAND, sha: CURRENT_SHA, workspace: root,
    });
    expect(applied).toMatchObject({ applied: [ADDED], outcome: "APPLIED", refusal: null });
    expect(applied.backupRef).not.toBeNull();

    // AND A FURTHER MUTATION, out of band. Without it "the schema came back" would also be true
    // of a rollback that touched nothing at all.
    query("CREATE TABLE mutated_after_migration (id integer)");
    const mutated = schema();
    expect(mutated).toContain("added_by_migration");
    expect(mutated).toContain("mutated_after_migration");
    expect(mutated).not.toBe(beforeMigration);

    await rollback({ envelope: envelopeFor("deployment.rollback", ROLLBACK_COMMAND, {
      environment: ENVIRONMENT, restoreDatabase: true,
      toReceiptRef: deployReceiptId(PROJECT_ID, ENVIRONMENT, KEPT_COMMAND),
    }), principal });

    // THE SCHEMA IS BACK -- compared byte for byte against the reading taken before the
    // migration, never merely "the command returned".
    const restored = schema();
    expect(restored).toBe(beforeMigration);
    expect(restored).not.toBe(mutated);
    expect(restored).not.toContain("added_by_migration");
    expect(restored).not.toContain("mutated_after_migration");
    expect(restored).toContain("app_metadata");
    process.stdout.write("REAL ROLLBACK RESTORE: recorded dump applied to the bound destination, mutation gone\n");
  } finally {
    store?.close();
    closeStores();
    writeFileSync(join(root, "release"), "release");
    try { if (operation) await operation; } finally {
      try { await runner.close(); } finally {
        rmSync(root, { recursive: true, force: true });
        for (const name of names) expect(docker(["ps", "-aq", "--filter", `name=^/${name}$`]).trim()).toBe("");
        // NOTHING THE BACKUP PORTS STARTED IS STILL RUNNING. Scoped to containers this arm
        // introduced, so a peer seat's live backup cannot fail an otherwise clean teardown.
        expect(backupContainers().filter(id => !foreignBackups.has(id))).toEqual([]);
      }
    }
  }
}, 900_000);
