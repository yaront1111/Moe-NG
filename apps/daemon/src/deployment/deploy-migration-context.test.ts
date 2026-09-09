import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { SqliteEventStore } from "@moe/store";

import {
  CREDENTIAL, PROJECT_ID, cleanUp, credentialSource, openMemoryStore, unreadableCredentialSource,
} from "../environment/environment-test-fixtures.js";
import { setEnvironmentVariable } from "../environment/environment-store.js";
import type { EnvironmentStoreConfig } from "../environment/environment-store.js";
import { migrateWithBackup } from "../repository/migrations/migration-service.js";
import {
  DEPLOY_MIGRATION_DATABASE_VARIABLE, resolveDeployMigrationContext,
} from "./deploy-migration-context.js";
import type {
  DeployMigrationContextConfig, DeployMigrationContextResult,
} from "./deploy-migration-context.js";

/**
 * THE HOST-CONTEXT RESOLVER'S ARMS.
 *
 * The subject is which database a named deploy environment means, and whether the answer can ever
 * be the WRONG environment's, absent, or visible. Every refusal arm names its specific code AND
 * the layer that answered, because two layers can refuse here — the environment slice (SCOPE/KEY)
 * and this module (DAEMON_DEPLOY_ENGINE) — and a test asserting only "it refused" would stay green
 * if the wrong one started answering.
 */

const SHA = "a".repeat(40);
const REQUEST = "deploy-migration-request-1";
const PRODUCTION_URL = "postgres://app:prod-s3cr3t@db.internal:5432/app";
const PREVIEW_URL = "postgres://app:preview-s3cr3t@db.preview:5432/app";

const directories: string[] = [];

afterEach(() => {
  cleanUp();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) continue;
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch { /* a held handle on Windows must not mask a test failure */ }
  }
});

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "moe-deploy-migration-"));
  directories.push(directory);
  return directory;
}

function environmentConfig(store: SqliteEventStore, credential: string | null = CREDENTIAL): EnvironmentStoreConfig {
  return { credential: credentialSource(credential), now: () => "2026-09-07T00:00:00.000Z", projectId: PROJECT_ID, store };
}

function seed(config: EnvironmentStoreConfig, environment: string, name: string, value: string): void {
  // A silently refused seed would make every later assertion vacuous.
  expect(setEnvironmentVariable(config, { environment, name, value })).toMatchObject({ ok: true });
}

function contextConfig(
  environment: EnvironmentStoreConfig, root: string | undefined,
): DeployMigrationContextConfig {
  return {
    credential: environment.credential, now: environment.now, projectId: environment.projectId,
    projectRoot: root, store: environment.store, workspace: root,
  };
}

function resolvedInput(result: DeployMigrationContextResult) {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error("unreachable: asserted ok above");
  return result.input;
}

/**
 * THE REAL COMPOSITION THE STEP ASKS FOR: resolve, and migrate ONLY when the resolution succeeded.
 * The two counters are what make "refuses BEFORE any migration effect" an assertion rather than a
 * hope — a resolver that refused but still let the caller reach `dump` would show `dumps: 1`.
 */
async function migrateAfterResolving(
  config: DeployMigrationContextConfig, environment: string, named?: string,
): Promise<{ readonly applies: number; readonly dumps: number; readonly result: DeployMigrationContextResult }> {
  let dumps = 0;
  let applies = 0;
  const result = resolveDeployMigrationContext(config, {
    environment, requestId: REQUEST, sha: SHA,
    ...(named === undefined ? {} : { workspace: named }),
  });
  if (result.ok) {
    await migrateWithBackup(config.store, result.input, {
      dump: async (): Promise<void> => { dumps += 1; },
      apply: async (): Promise<readonly string[]> => { applies += 1; return []; },
    });
  }
  return { applies, dumps, result };
}

describe("resolveDeployMigrationContext", () => {
  it("(a) resolves the full MigrationInput host half for the ADMITTED environment", () => {
    const store = openMemoryStore();
    const environment = environmentConfig(store);
    const root = workspace();
    seed(environment, "production", DEPLOY_MIGRATION_DATABASE_VARIABLE, PRODUCTION_URL);

    const input = resolvedInput(resolveDeployMigrationContext(
      contextConfig(environment, root), { environment: "production", requestId: REQUEST, sha: SHA },
    ));

    // The WHOLE host half, not a subset: a resolver that dropped `projectRoot` would send the
    // backup somewhere `migrationBackupDirectory` would then create out of thin air.
    expect(input).toEqual({
      databaseUrl: PRODUCTION_URL, environment: "production", projectId: PROJECT_ID,
      projectRoot: root, requestId: REQUEST, sha: SHA, workspace: root,
    });
  });

  it("(b) never returns another environment's variables — production and preview both directions", () => {
    const store = openMemoryStore();
    const environment = environmentConfig(store);
    const root = workspace();
    seed(environment, "production", DEPLOY_MIGRATION_DATABASE_VARIABLE, PRODUCTION_URL);
    seed(environment, "preview", DEPLOY_MIGRATION_DATABASE_VARIABLE, PREVIEW_URL);

    const config = contextConfig(environment, root);
    const production = resolvedInput(resolveDeployMigrationContext(
      config, { environment: "production", requestId: REQUEST, sha: SHA }));
    const preview = resolvedInput(resolveDeployMigrationContext(
      config, { environment: "preview", requestId: REQUEST, sha: SHA }));

    // Asserted as ISOLATION in both directions, not as "it returned something": each resolution
    // carries its own environment's value AND provably not the other's. Both environments are
    // seeded in ONE store, so a resolver that ignored the requested name would fail here.
    expect(production.databaseUrl).toBe(PRODUCTION_URL);
    expect(production.databaseUrl).not.toBe(PREVIEW_URL);
    expect(production.environment).toBe("production");
    expect(preview.databaseUrl).toBe(PREVIEW_URL);
    expect(preview.databaseUrl).not.toBe(PRODUCTION_URL);
    expect(preview.environment).toBe("preview");
  });

  it("(c) forwards the environment slice's OWN code and layer, and refuses before any migration effect", async () => {
    const unknown = await migrateAfterResolving(
      contextConfig(environmentConfig(openMemoryStore()), workspace()), "staging");
    // SCOPE, not this module's stamp: the environment slice is what refused an unnamed environment.
    expect(unknown.result).toMatchObject({ code: "ENV_ENVIRONMENT_UNKNOWN", layer: "SCOPE", ok: false });
    expect({ applies: unknown.applies, dumps: unknown.dumps }).toEqual({ applies: 0, dumps: 0 });

    const store = openMemoryStore();
    const seeded = environmentConfig(store);
    seed(seeded, "production", DEPLOY_MIGRATION_DATABASE_VARIABLE, PRODUCTION_URL);
    // The credential EXISTS but cannot be read — the seal is then underivable, which is KEY.
    const unreadable = await migrateAfterResolving(
      { ...contextConfig(seeded, workspace()), credential: unreadableCredentialSource() }, "production");
    expect(unreadable.result).toMatchObject({ code: "ENV_STORE_KEY_UNAVAILABLE", layer: "KEY", ok: false });
    expect({ applies: unreadable.applies, dumps: unreadable.dumps }).toEqual({ applies: 0, dumps: 0 });
  });

  it("(d) refuses a mismatched or unconfigured workspace, and an absent or empty database value", async () => {
    const store = openMemoryStore();
    const environment = environmentConfig(store);
    const root = workspace();
    seed(environment, "production", DEPLOY_MIGRATION_DATABASE_VARIABLE, PRODUCTION_URL);

    const mismatched = await migrateAfterResolving(
      contextConfig(environment, root), "production", join(root, "somewhere-else"));
    expect(mismatched.result).toMatchObject({
      code: "DEPLOY_MIGRATION_WORKSPACE_MISMATCH", layer: "DAEMON_DEPLOY_ENGINE", ok: false });
    expect({ applies: mismatched.applies, dumps: mismatched.dumps }).toEqual({ applies: 0, dumps: 0 });

    const unconfigured = await migrateAfterResolving(contextConfig(environment, undefined), "production");
    expect(unconfigured.result).toMatchObject({
      code: "DEPLOY_MIGRATION_WORKSPACE_UNCONFIGURED", layer: "DAEMON_DEPLOY_ENGINE", ok: false });
    expect({ applies: unconfigured.applies, dumps: unconfigured.dumps }).toEqual({ applies: 0, dumps: 0 });

    // A DIFFERENT store with the environment present but carrying no database variable at all.
    const bare = environmentConfig(openMemoryStore());
    seed(bare, "production", "STRIPE_KEY", "sk_live_example");
    const absent = await migrateAfterResolving(contextConfig(bare, workspace()), "production");
    expect(absent.result).toMatchObject({
      code: "DEPLOY_MIGRATION_DATABASE_UNSET", layer: "DAEMON_DEPLOY_ENGINE", ok: false });
    expect({ applies: absent.applies, dumps: absent.dumps }).toEqual({ applies: 0, dumps: 0 });

    // EMPTY is as absent as missing: `migrateWithBackup` would hand "" straight to `dump`.
    const empty = environmentConfig(openMemoryStore());
    seed(empty, "production", DEPLOY_MIGRATION_DATABASE_VARIABLE, "");
    const blank = await migrateAfterResolving(contextConfig(empty, workspace()), "production");
    expect(blank.result).toMatchObject({ code: "DEPLOY_MIGRATION_DATABASE_UNSET", ok: false });
    expect({ applies: blank.applies, dumps: blank.dumps }).toEqual({ applies: 0, dumps: 0 });
  });

  it("(e) puts the connection value in no refusal and no serialised form — with a positive control", () => {
    const store = openMemoryStore();
    const environment = environmentConfig(store);
    const root = workspace();
    seed(environment, "production", DEPLOY_MIGRATION_DATABASE_VARIABLE, PRODUCTION_URL);
    const config = contextConfig(environment, root);

    // Every refusal this module can reach WHILE a credential-shaped value is really in the store,
    // so the arm is not passing because nothing sensitive was ever present.
    const refusals: DeployMigrationContextResult[] = [
      resolveDeployMigrationContext(config, { environment: "staging", requestId: REQUEST, sha: SHA }),
      resolveDeployMigrationContext(config, {
        environment: "production", requestId: REQUEST, sha: SHA, workspace: join(root, "elsewhere") }),
      resolveDeployMigrationContext(
        { ...config, workspace: undefined }, { environment: "production", requestId: REQUEST, sha: SHA }),
      resolveDeployMigrationContext(
        { ...config, credential: unreadableCredentialSource() },
        { environment: "production", requestId: REQUEST, sha: SHA }),
    ];
    const contains = (haystack: string): boolean =>
      haystack.includes(PRODUCTION_URL) || haystack.includes("prod-s3cr3t");
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ ok: false });
      expect(contains(JSON.stringify(refusal))).toBe(false);
    }

    // THE POSITIVE CONTROL. `contains` is the SAME predicate the loop above ran; feeding it the
    // shape a leak would take proves the assertion can fail. Without this the four assertions
    // above are indistinguishable from a predicate that always answers false.
    const leaked = { ...refusals[0], detail: `could not open ${PRODUCTION_URL}` };
    expect(contains(JSON.stringify(leaked))).toBe(true);
    expect(contains(JSON.stringify({ detail: "prod-s3cr3t" }))).toBe(true);

    // And the ok branch DOES carry it — otherwise "nowhere in the refusals" would be satisfied by
    // a resolver that never resolved the value at all.
    expect(resolvedInput(resolveDeployMigrationContext(
      config, { environment: "production", requestId: REQUEST, sha: SHA })).databaseUrl).toBe(PRODUCTION_URL);
  });
});
