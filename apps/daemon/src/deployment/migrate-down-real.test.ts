import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { expect, it } from "vitest";
import { SqliteEventStore } from "@moe/store";

import { closeStores, driveThrough, openStore, PROJECT_ID }
  from "../bootstrap/bootstrap-test-fixtures.js";
import { createAsyncCommandEntries } from "../daemon-command-async-entries.js";
import type { AuthenticatedPrincipal } from "../http/http-contract.js";
import { createVerifierDatabaseRunner } from "../orchestrator/verifier-database.js";
import { CONTROLLED_PROFILE_VERSION, generateControlledProfile }
  from "../repository/controlled-profile/controlled-profile-generator.js";
import { deploymentInfrastructureFiles }
  from "../repository/deployment/deployment-infrastructure-templates.js";
import { readMigrationReceipt } from "../repository/migrations/migration-receipt.js";
import { migrateWithBackup } from "../repository/migrations/migration-service.js";
import { createDockerDouble } from "./deploy-ports.js";
import type { DeployTarget } from "./deploy-ports.js";
import { candidateContainerName } from "./deploy-service.js";
import { DEPLOYMENT_DEPLOY_COMMAND_KIND } from "./deploy-target-contracts.js";
import { DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND } from "./migrate-down-command.js";

/**
 * THE REAL REVERT: `deployment.migrate_down` against a live PostgreSQL, through the REGISTERED
 * command, with the schema read out of `information_schema` before and after (DoD 5).
 *
 * Opt-in behind MOE_MIGRATION_RESTORE=1, the same flag the forward path's real arm uses. With the
 * flag set and Docker unavailable this FAILS rather than silently skipping. The offline journey
 * (`migrate-down-journey.test.ts`) proves the fences and the refusal codes on every machine; what
 * this file adds is the one thing a double cannot: that `node-pg-migrate down` actually took the
 * tables away and left the earlier batch standing.
 *
 * TWO BATCHES, and that is the point. The disposable-database lifecycle applies the generated
 * profile's own initial migration (batch one, `app_metadata`); this arm applies a second batch
 * through the real `migrateWithBackup`, then reverts THE LAST ONE and asserts batch one survived.
 * A revert that unwound everything is a different and far more dangerous command.
 *
 * TEARDOWN on every path: the holding recipe is released, the runner closed and the temp root
 * removed in nested `finally`s, and the arm asserts Docker reports NO container left (epic
 * rail 4).
 */

const RUN = process.env.MOE_MIGRATION_RESTORE === "1";
const OPERATOR = "principal-1";
const ENVIRONMENT = "staging";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const DECIDED_AT = "2026-09-06T00:00:00.000Z";
const REVERT_AT = "2026-09-06T01:00:00.000Z";
const ADDED = "1700000000001_added.js";
const LOCAL: DeployTarget = { network: "moe-net", sshTarget: null, url: "https://app.example.test" };
const PROXY_CONFIG =
  deploymentInfrastructureFiles(CONTROLLED_PROFILE_VERSION, []).get("docker/Caddyfile") ?? "";

function docker(args: readonly string[]): string {
  const result = spawnSync("docker", [...args], { shell: false, windowsHide: true,
    timeout: 30_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 || result.error) throw new Error("MIGRATION_TEST_DOCKER_FAILED");
  return result.stdout;
}

function materialize(root: string): void {
  const generated = generateControlledProfile({
    productName: "migrate-down-proof", profileVersion: CONTROLLED_PROFILE_VERSION,
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

it("pins the live gate and the actual dispatch/engine imports", () => {
  expect(typeof createVerifierDatabaseRunner).toBe("function");
  expect(typeof createAsyncCommandEntries).toBe("function");
  expect(DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND).toBe("deployment.migrate_down");
});

it.runIf(RUN)("reverts the LAST batch against a live PostgreSQL and records it", async () => {
  docker(["version", "--format", "{{.Server.Version}}"]);
  const root = mkdtempSync(join(tmpdir(), "moe-migrate-down-live-"));
  const names: string[] = [];
  let ready: (url: string) => void = () => undefined;
  const connection = new Promise<string>(resolve => { ready = resolve; });
  const brief = { workspace: root, test: "node holding-recipe.mjs",
    instructions: "migrate down proof", title: "migrate down proof" };
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
      operation.then(() => { throw new Error("MIGRATION_RECIPE_NOT_STARTED"); })]);
    expect(names).toHaveLength(1);
    const container = names[0]!;
    const query = (sql: string): string => docker(["exec", container, "psql", "-U", "app", "-d", "app",
      "-v", "ON_ERROR_STOP=1", "-tAc", sql]).trim();
    const schema = (): string => query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position");

    // BATCH ONE is the profile's own initial migration, applied by the disposable-database
    // lifecycle before the recipe ran. Read, never assumed.
    const afterFirst = schema();
    expect(afterFirst).toContain("app_metadata");
    expect(query("SELECT count(*) FROM pgmigrations")).toBe("1");

    store = openStore();
    driveThrough(store, "goal.close");
    const double = createDockerDouble({
      proxyConfig: PROXY_CONFIG, running: { app: "HEALTHY" },
      health: { [candidateContainerName(ENVIRONMENT, SHA, "cmd-deploy-first")]: ["HEALTHY"] },
    });
    const entries = createAsyncCommandEntries({
      operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store,
      deploymentDeploy: {
        buildContext: "/workspace/product", clock: (): string => DECIDED_AT,
        healthBudgetMs: 10, pollMs: 1, sleep: (): Promise<void> => Promise.resolve(),
        ports: { docker: double.docker, releaseDecision: (): string | null => null,
          ssh: double.ssh, target: (): DeployTarget => LOCAL, transfer: double.transfer },
      },
      // THE REAL PORTS: no `ports` override, so the child runs the generated product's own
      // installed `node-pg-migrate` against the live database.
      migrateDown: { clock: (): string => REVERT_AT, databaseUrl: url, projectRoot: root, workspace: root },
    });
    const deploy = entries[DEPLOYMENT_DEPLOY_COMMAND_KIND].asyncHandler;
    const revert = entries[DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND].asyncHandler;
    if (deploy === undefined || revert === undefined) throw new Error("async handlers absent");
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
      sessionCredential: "migrate-down-real-credential", targetAggregateId: PROJECT_ID,
    });
    // The prerequisite the sequence table demands, committed by the REAL deploy command.
    await deploy({ envelope: envelopeFor(DEPLOYMENT_DEPLOY_COMMAND_KIND, "cmd-deploy-first",
      { environment: ENVIRONMENT, sha: SHA }), principal });

    // BATCH TWO, applied through the real forward engine against the live database.
    writeFileSync(join(root, "migrations", ADDED),
      "export const up = pgm => pgm.createTable('added_by_migration', { id: 'integer' });\n"
      + "export const down = pgm => pgm.dropTable('added_by_migration');\n");
    const applied = await migrateWithBackup(store, {
      databaseUrl: url, environment: ENVIRONMENT, now: new Date(DECIDED_AT), projectId: PROJECT_ID,
      projectRoot: root, requestId: "batch-two", sha: SHA, workspace: root,
    });
    expect(applied).toMatchObject({ applied: [ADDED], outcome: "APPLIED", refusal: null });
    const afterSecond = schema();
    expect(afterSecond).toContain("added_by_migration");
    expect(query("SELECT count(*) FROM pgmigrations")).toBe("2");

    await revert({ envelope: envelopeFor(DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND, "cmd-migrate-down",
      { environment: ENVIRONMENT, toMigrationRequestId: "batch-two" }), principal });

    // THE SCHEMA CHANGED BACK — compared byte for byte against the reading taken BEFORE batch two.
    expect(schema()).toBe(afterFirst);
    expect(schema()).not.toBe(afterSecond);
    // THE LAST BATCH ONLY: batch one is still applied and its table still stands.
    expect(schema()).toContain("app_metadata");
    expect(query("SELECT count(*) FROM pgmigrations")).toBe("1");
    // THE RECEIPT RECORDS THE REVERT, read back from the store, with the migration NAMED.
    expect(readMigrationReceipt(store, PROJECT_ID, "cmd-migrate-down")).toMatchObject({
      applied: [ADDED], environment: ENVIRONMENT, outcome: "REVERTED", refusal: null,
    });
    process.stdout.write("REAL MIGRATE_DOWN: last batch reverted, first batch standing, receipt recorded\n");
  } finally {
    store?.close();
    closeStores();
    writeFileSync(join(root, "release"), "release");
    try { if (operation) await operation; } finally {
      try { await runner.close(); } finally {
        rmSync(root, { recursive: true, force: true });
        for (const name of names) expect(docker(["ps", "-aq", "--filter", `name=^/${name}$`]).trim()).toBe("");
      }
    }
  }
}, 900_000);
