import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import type { SqliteEventStore } from "@moe/store";

import { backupFileHash } from "../backups/backup-ports.js";
import {
  CREDENTIAL, PROJECT_ID, cleanUp, credentialSource, openMemoryStore,
} from "../environment/environment-test-fixtures.js";
import { setEnvironmentVariable } from "../environment/environment-store.js";
import type { EnvironmentStoreConfig } from "../environment/environment-store.js";
import { migrationRefusal, recordMigrationReceipt } from "../repository/migrations/migration-receipt.js";
import type { MigrationReceipt } from "../repository/migrations/migration-receipt.js";
import { recordDeployReceipt } from "./deploy-ledger.js";
import { DEPLOY_MIGRATION_DATABASE_VARIABLE } from "./deploy-migration-context.js";
import { MIGRATION_RECEIPT_VERSION, migrationReceiptId } from "../repository/migrations/migration-receipt.js";
import {
  ROLLBACK_RESTORE_DETAILS, ROLLBACK_RESTORE_STAMP, applyResolvedRestore, applyRollbackRestore,
  resolveRollbackRestore,
} from "./rollback-restore.js";
import type { RollbackRestoreConfig, RollbackRestoreResult } from "./rollback-restore.js";

/**
 * THE BINDING'S ARMS. The subject is WHICH database and WHICH dump, and every arm reads the
 * restore port's RECORDED CALLS rather than the return value alone: "nothing was applied" is only
 * an assertion when a port exists that could have recorded one
 * (see `mem:gotcha-asserting-a-port-was-not-called-when-no-port-is-wired`).
 *
 * TWO DEPLOYS ARE ALWAYS SEEDED, with DIFFERENT `backupRef`s. An arm where the kept receipt and
 * the current receipt name the same dump cannot tell the right answer from the data-destroying
 * one, so the fixture makes them differ by construction and arm (a) asserts BOTH directions.
 *
 * Every refusal arm names the specific CODE and the LAYER that answered: three layers can refuse
 * here — this seam, the deploy resolver's DAEMON_DEPLOY_ENGINE and the environment slice's
 * SCOPE/KEY — and an arm asserting only "it refused" stays green when the wrong one starts
 * answering.
 */

const ENVIRONMENT = "production";
const KEPT_DECISION = "cmd-deploy-kept";
const CURRENT_DECISION = "cmd-deploy-current";
const KEPT_SHA = "a".repeat(40);
const CURRENT_SHA = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;
/** Credential-shaped ON PURPOSE: arm (e) sweeps every surface for this exact string. */
const PRODUCTION_URL = "postgres://app:pr0d-s3cr3t-value@db.internal:5432/app";
const DECOY_URL = "postgres://decoy:decoy-s3cr3t@decoy.invalid:5432/decoy";
const KEPT_MIGRATION = "1700000000001_kept.js";
const CURRENT_MIGRATION = "1700000000002_current.js";

const directories: string[] = [];

afterEach(() => {
  cleanUp();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) continue;
    try { rmSync(directory, { force: true, recursive: true }); }
    catch { /* a held handle on Windows must not mask a test failure */ }
  }
});

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "moe-rollback-restore-"));
  directories.push(directory);
  return directory;
}

interface RecordingPorts {
  readonly calls: { connection: string; path: string }[];
  readonly restoreDatabaseInto: (connection: string, path: string) => Promise<void>;
}

function recordingPorts(fail = false): RecordingPorts {
  const calls: { connection: string; path: string }[] = [];
  return { calls, restoreDatabaseInto: async (connection: string, path: string): Promise<void> => {
    calls.push({ connection, path });
    // The real port collapses every thrown message to `BACKUP_FAILED`; the double mirrors that
    // so no arm can accidentally prove leak-freedom against a friendlier error than production's.
    if (fail) throw Object.assign(new Error("BACKUP_FAILED"), { code: "BACKUP_FAILED" });
  } };
}

function environmentConfig(store: SqliteEventStore): EnvironmentStoreConfig {
  return { credential: credentialSource(CREDENTIAL), now: () => "2026-09-07T00:00:00.000Z", projectId: PROJECT_ID, store };
}

function seedVariable(config: EnvironmentStoreConfig, value: string): void {
  // A silently refused seed would make every later assertion vacuous.
  expect(setEnvironmentVariable(config, {
    environment: ENVIRONMENT, name: DEPLOY_MIGRATION_DATABASE_VARIABLE, value,
  })).toMatchObject({ ok: true });
}

/** Writes a real artifact and returns the `<path>@sha256:<hash>` ref a migration receipt carries. */
async function seedDump(root: string, name: string, body: string): Promise<string> {
  const path = join(root, name);
  writeFileSync(path, body);
  return `${path}@sha256:${await backupFileHash(path)}`;
}

function seedDeploy(store: SqliteEventStore, decisionId: string, sha: string, decidedAt: string): void {
  expect(recordDeployReceipt(store, {
    decidedAt, decisionId, environment: ENVIRONMENT, imageDigest: DIGEST, projectId: PROJECT_ID,
    refusal: null, releaseDecision: null, sha, url: "https://app.example.test",
  })).toMatchObject({ ok: true });
}

function seedMigration(
  store: SqliteEventStore, requestId: string, sha: string, applied: string, backupRef: string | null,
): MigrationReceipt {
  // The decoder's own pairing rules, honoured rather than fought: a receipt with NO backup is
  // necessarily a REFUSED one, and a REFUSED one carries a refusal and an EMPTY applied list
  // (`migration-receipt.ts:80-83`). So "backupRef is null" is seeded as the real shape it takes
  // in the tree — a migration that refused — not as an invented APPLIED-without-a-backup row
  // that `recordMigrationReceipt` would reject anyway.
  const refused = backupRef === null;
  const receipt: MigrationReceipt = {
    applied: refused ? [] : [applied], backupRef, decidedAt: "2026-09-06T00:00:00.000Z",
    environment: ENVIRONMENT, outcome: refused ? "REFUSED" : "APPLIED", projectId: PROJECT_ID,
    receiptId: migrationReceiptId(PROJECT_ID, requestId),
    refusal: refused ? migrationRefusal("MIGRATION_BACKUP_FAILED", "backup failed") : null,
    requestId, sha, version: MIGRATION_RECEIPT_VERSION,
  };
  return recordMigrationReceipt(store, receipt);
}

interface Fixture {
  readonly config: RollbackRestoreConfig;
  readonly currentRef: string;
  readonly keptRef: string;
  readonly ports: RecordingPorts;
  readonly root: string;
  readonly store: SqliteEventStore;
}

/**
 * THE WHOLE HISTORY, in ledger order: a kept deploy, then the current one, each with its OWN
 * pre-migration dump. `backupRef`s differ by construction — that is what makes arm (a)'s "not the
 * kept receipt's ref" assertion able to fail.
 */
async function fixture(options: {
  readonly bind?: boolean; readonly credential?: boolean; readonly currentBackup?: boolean;
  readonly currentMigration?: boolean; readonly fail?: boolean; readonly history?: boolean;
  readonly workspace?: boolean;
} = {}): Promise<Fixture> {
  const store = openMemoryStore();
  const environment = environmentConfig(store);
  const root = workspace();
  if (options.bind !== false) seedVariable(environment, PRODUCTION_URL);
  const keptRef = await seedDump(root, "kept.sql", "-- kept schema\nCREATE TABLE kept();\n");
  const currentRef = await seedDump(root, "current.sql", "-- current schema\nCREATE TABLE current();\n");
  // `history: false` seeds NO deploy at all. Omitting only the CURRENT one would not produce
  // "no current deploy receipt" — the ledger would simply report the KEPT deploy as current, and
  // the arm would then apply the kept receipt's dump while claiming to test an absence.
  if (options.history !== false) {
    seedDeploy(store, KEPT_DECISION, KEPT_SHA, "2026-09-05T00:00:00.000Z");
    seedMigration(store, KEPT_DECISION, KEPT_SHA, KEPT_MIGRATION, keptRef);
    seedDeploy(store, CURRENT_DECISION, CURRENT_SHA, "2026-09-06T00:00:00.000Z");
    if (options.currentMigration !== false) {
      seedMigration(store, CURRENT_DECISION, CURRENT_SHA, CURRENT_MIGRATION,
        options.currentBackup === false ? null : currentRef);
    }
  }
  return { config: {
    credential: options.credential === false ? undefined : environment.credential,
    now: environment.now, projectId: PROJECT_ID, projectRoot: root, store,
    workspace: options.workspace === false ? undefined : root,
  }, currentRef, keptRef, ports: recordingPorts(options.fail === true), root, store };
}

const pathOf = (ref: string): string => ref.slice(0, ref.lastIndexOf("@sha256:"));

function refusalOf(result: RollbackRestoreResult): { code: string; detail: string; layer: string } {
  expect(result).toMatchObject({ ok: false });
  if (result.ok) throw new Error("unreachable: asserted a refusal above");
  return { code: result.code, detail: result.detail, layer: result.layer };
}

describe("applyRollbackRestore", () => {
  it("(a) applies the CURRENT deploy's pre-migration dump, never the kept receipt's own", async () => {
    const f = await fixture();

    const result = await applyRollbackRestore(f.config, ENVIRONMENT, f.ports);

    expect(result).toEqual({ dump: pathOf(f.currentRef), ok: true });
    // THE FIXTURE CAN TELL THEM APART: an arm where both refs are equal proves nothing.
    expect(f.keptRef).not.toBe(f.currentRef);
    // READ FROM THE PORT'S RECORDED CALLS, not from the return value.
    expect(f.ports.calls).toHaveLength(1);
    expect(f.ports.calls[0]?.path).toBe(pathOf(f.currentRef));
    expect(f.ports.calls[0]?.path).not.toBe(pathOf(f.keptRef));
    // ...and the destination came from the environment credential seam.
    expect(f.ports.calls[0]?.connection).toBe(PRODUCTION_URL);
  });

  it("(b) refuses UNAVAILABLE with code AND layer when no destination is bound, and calls nothing", async () => {
    // The environment exists and has deployed; it simply carries no database variable.
    const unset = await fixture({ bind: false });
    expect(refusalOf(await applyRollbackRestore(unset.config, ENVIRONMENT, unset.ports))).toEqual({
      code: "DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE",
      detail: ROLLBACK_RESTORE_DETAILS.DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE,
      layer: ROLLBACK_RESTORE_STAMP,
    });
    expect(unset.ports.calls).toEqual([]);

    // The daemon has no environment store at all — the same code, still this seam's layer.
    const unwired = await fixture({ credential: false });
    expect(refusalOf(await applyRollbackRestore(unwired.config, ENVIRONMENT, unwired.ports))).toMatchObject({
      code: "DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE", layer: ROLLBACK_RESTORE_STAMP,
    });
    expect(unwired.ports.calls).toEqual([]);
  });

  it("(c) refuses each missing-evidence case with its OWN code and layer, touching nothing", async () => {
    const cases: readonly (readonly [string, Fixture])[] = [
      ["DEPLOY_ROLLBACK_RESTORE_DEPLOY_UNKNOWN", await fixture({ history: false })],
      ["DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNKNOWN", await fixture({ currentMigration: false })],
      ["DEPLOY_ROLLBACK_RESTORE_BACKUP_ABSENT", await fixture({ currentBackup: false })],
    ];
    // A sweep that silently yielded zero cases would pass while asserting nothing.
    expect(cases).toHaveLength(3);
    for (const [code, f] of cases) {
      expect(refusalOf(await applyRollbackRestore(f.config, ENVIRONMENT, f.ports)), code).toEqual({
        code, detail: ROLLBACK_RESTORE_DETAILS[code as keyof typeof ROLLBACK_RESTORE_DETAILS],
        layer: ROLLBACK_RESTORE_STAMP,
      });
      expect(f.ports.calls, code).toEqual([]);
    }

    // ...and the case that matters most: the artifact no longer hashes to what the receipt recorded.
    const tampered = await fixture();
    writeFileSync(pathOf(tampered.currentRef), "-- REWRITTEN AFTER THE RECEIPT WAS SEALED\n");
    expect(refusalOf(await applyRollbackRestore(tampered.config, ENVIRONMENT, tampered.ports))).toEqual({
      code: "DEPLOY_ROLLBACK_RESTORE_BACKUP_UNVERIFIED",
      detail: ROLLBACK_RESTORE_DETAILS.DEPLOY_ROLLBACK_RESTORE_BACKUP_UNVERIFIED,
      layer: ROLLBACK_RESTORE_STAMP,
    });
    expect(tampered.ports.calls).toEqual([]);

    // A dump that vanished entirely is the same refusal — never "restored nothing successfully".
    const removed = await fixture();
    rmSync(pathOf(removed.currentRef), { force: true });
    expect(refusalOf(await applyRollbackRestore(removed.config, ENVIRONMENT, removed.ports))).toMatchObject({
      code: "DEPLOY_ROLLBACK_RESTORE_BACKUP_UNVERIFIED", layer: ROLLBACK_RESTORE_STAMP,
    });
    expect(removed.ports.calls).toEqual([]);
  });

  it("(c2) forwards the environment slice's own refusal code AND layer unchanged", async () => {
    const f = await fixture();
    // An environment with no history of its own: this seam answers, and the answer is scoped to
    // the environment asked about rather than leaking the seeded one's receipts across.
    const refusal = refusalOf(await applyRollbackRestore(f.config, "never-deployed-anywhere", f.ports));
    expect(refusal.code).toBe("DEPLOY_ROLLBACK_RESTORE_DEPLOY_UNKNOWN");
    expect(f.ports.calls).toEqual([]);

    // With a deploy present but the workspace unconfigured, the RESOLVER's own layer answers —
    // proving the seam does not restamp a refusal that another layer minted.
    const unconfigured = await fixture({ workspace: false });
    const resolverRefusal = refusalOf(await applyRollbackRestore(unconfigured.config, ENVIRONMENT, unconfigured.ports));
    expect(resolverRefusal.code).toBe("DEPLOY_MIGRATION_WORKSPACE_UNCONFIGURED");
    expect(resolverRefusal.layer).toBe("DAEMON_DEPLOY_ENGINE");
    expect(resolverRefusal.layer).not.toBe(ROLLBACK_RESTORE_STAMP);
    expect(unconfigured.ports.calls).toEqual([]);
  });

  it("(c3) forwards the ENVIRONMENT slice's own code and layer for a name the store does not have", async () => {
    // A DEPLOY environment name is `/^[a-z][a-z0-9-]{0,62}$/`; the environment STORE is CLOSED to
    // {preview, production, verify} (`environment-contracts.ts:29`). So "staging" is deployable
    // and can never carry a bound destination -- and the refusal that says so belongs to the
    // environment slice. Restamping it DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE would report
    // a layer that did not answer and would hide the real cause from the operator.
    const f = await fixture();
    // The deploy history has to exist for THAT environment, or the seam's own missing-receipt
    // refusal would answer first and this arm would prove nothing about forwarding.
    expect(recordDeployReceipt(f.store, {
      decidedAt: "2026-09-06T00:00:00.000Z", decisionId: "cmd-deploy-staging", environment: "staging",
      imageDigest: DIGEST, projectId: PROJECT_ID, refusal: null, releaseDecision: null,
      sha: CURRENT_SHA, url: "https://app.example.test",
    })).toMatchObject({ ok: true });

    const refusal = refusalOf(await applyRollbackRestore(f.config, "staging", f.ports));

    expect(refusal.code).toBe("ENV_ENVIRONMENT_UNKNOWN");
    expect(refusal.layer).toBe("SCOPE");
    // A THIRD layer answering is what makes the layer column on every arm in this file
    // load-bearing rather than decorative.
    expect(refusal.layer).not.toBe(ROLLBACK_RESTORE_STAMP);
    expect(refusal.layer).not.toBe("DAEMON_DEPLOY_ENGINE");
    expect(f.ports.calls).toEqual([]);
  });

  it("(d) takes the destination ONLY from the credential seam — not process.env, not a payload", async () => {
    const previous = process.env[DEPLOY_MIGRATION_DATABASE_VARIABLE];
    process.env[DEPLOY_MIGRATION_DATABASE_VARIABLE] = DECOY_URL;
    try {
      const f = await fixture();
      await applyRollbackRestore(f.config, ENVIRONMENT, f.ports);
      expect(f.ports.calls).toHaveLength(1);
      expect(f.ports.calls[0]?.connection).toBe(PRODUCTION_URL);
      expect(f.ports.calls[0]?.connection).not.toBe(DECOY_URL);
    } finally {
      if (previous === undefined) delete process.env[DEPLOY_MIGRATION_DATABASE_VARIABLE];
      else process.env[DEPLOY_MIGRATION_DATABASE_VARIABLE] = previous;
    }

    // DURABLE, SURVIVES THE COMMIT: the module has no `process.env` read to be tricked into, and
    // no request payload reaches it — `applyRollbackRestore` takes an ALREADY-ADMITTED environment
    // NAME and a port, and there is no third place a caller-supplied URL could enter.
    const source = readFileSync(fileURLToPath(new URL("./rollback-restore.ts", import.meta.url)), "utf8");
    // CODE-SHAPED, NOT PROSE-SHAPED. The module's own header names `process.env` and "request
    // payload" as the two sources it refuses to use, so a bare identifier match would red on the
    // very comment that documents the rule. These anchor on a READ — a property access or an
    // index — which is what an actual leak would have to look like.
    expect(source).not.toMatch(/process\s*\.\s*env\s*[.[]/u);
    expect(source).not.toMatch(/payload\s*[.[]/u);
    // Non-vacuity: the file really was read and really is the module under test.
    expect(source).toMatch(/resolveDeployMigrationContext/u);
  });

  it("(e) leaks the connection value into NO returned value, refusal or detail — with a positive control", async () => {
    const secret = "pr0d-s3cr3t-value";
    // THE CONTROL FIRST. Without it this arm passes whenever nothing credential-shaped exists,
    // which is exactly the failure mode it is meant to rule out.
    const carries = (value: unknown): boolean => JSON.stringify(value ?? null).includes(secret);
    expect(carries(PRODUCTION_URL)).toBe(true);
    expect(carries({ detail: `connecting to ${PRODUCTION_URL}` })).toBe(true);
    expect(carries({ detail: "nothing here" })).toBe(false);

    const surfaces: unknown[] = [];
    const applied = await fixture();
    surfaces.push(await applyRollbackRestore(applied.config, ENVIRONMENT, applied.ports));
    for (const options of [{ bind: false }, { credential: false }, { history: false },
      { currentMigration: false }, { currentBackup: false }, { workspace: false }, { fail: true }]) {
      const f = await fixture(options);
      try { surfaces.push(await applyRollbackRestore(f.config, ENVIRONMENT, f.ports)); }
      catch (error) { surfaces.push(error instanceof Error ? error.message : error); }
    }
    // The sweep really ran: eight surfaces, not an empty loop reporting success.
    expect(surfaces).toHaveLength(8);
    for (const surface of surfaces) expect(carries(surface)).toBe(false);
    expect(carries(ROLLBACK_RESTORE_DETAILS)).toBe(false);
  });

  it("(f) a failing restore refuses RESTORE_FAILED with code and layer after exactly ONE attempt", async () => {
    const f = await fixture({ fail: true });

    expect(refusalOf(await applyRollbackRestore(f.config, ENVIRONMENT, f.ports))).toEqual({
      code: "DEPLOY_ROLLBACK_RESTORE_FAILED",
      detail: ROLLBACK_RESTORE_DETAILS.DEPLOY_ROLLBACK_RESTORE_FAILED,
      layer: ROLLBACK_RESTORE_STAMP,
    });
    // NO AUTOMATIC RETRY — invisible to an arm that only checks the outcome.
    expect(f.ports.calls).toHaveLength(1);
  });
});

/**
 * THE TWO HALVES, SEPARATELY — the seam the rollback command puts its admission through.
 *
 * The reason these are their own arms rather than a refactor covered by the composition's: the
 * command now calls the halves at two different points in its lifecycle, with a durable commit in
 * between. "The read half moves nothing" and "the effect half moves it once" are the two facts
 * that ordering depends on, and neither is observable through `applyRollbackRestore`, which always
 * does both.
 */
describe("resolveRollbackRestore / applyResolvedRestore", () => {
  it("(g) resolves destination AND dump with a WIRED port in hand, and calls it ZERO times", async () => {
    const f = await fixture();

    const resolved = await resolveRollbackRestore(f.config, ENVIRONMENT);

    expect(resolved).toEqual({ databaseUrl: PRODUCTION_URL, dump: pathOf(f.currentRef), ok: true });
    // THE EMPTY CALL LIST IS THE ASSERTION, and it is falsifiable: arm (a) drives this very port,
    // on this very fixture, to exactly one call through the composition. So an empty list here
    // separates "resolved without applying" from "resolved and applied", which the returned shape
    // on its own cannot do.
    expect(f.ports.calls).toEqual([]);
    // ...and the dump is the CURRENT deploy's, never the kept receipt's own — one step too far.
    expect(pathOf(f.currentRef)).not.toBe(pathOf(f.keptRef));

    // EVERY EVIDENCE REFUSAL KEEPS ITS CODE, DETAIL AND LAYER across the split. Boundness still
    // answers before deploy history, which is the order the production wiring arms depend on.
    const unbound = await fixture({ bind: false });
    expect(refusalOf(await resolveRollbackRestore(unbound.config, ENVIRONMENT))).toEqual({
      code: "DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE",
      detail: ROLLBACK_RESTORE_DETAILS.DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE,
      layer: ROLLBACK_RESTORE_STAMP,
    });
    expect(unbound.ports.calls).toEqual([]);

    const unmigrated = await fixture({ currentMigration: false });
    expect(refusalOf(await resolveRollbackRestore(unmigrated.config, ENVIRONMENT))).toEqual({
      code: "DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNKNOWN",
      detail: ROLLBACK_RESTORE_DETAILS.DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNKNOWN,
      layer: ROLLBACK_RESTORE_STAMP,
    });
    expect(unmigrated.ports.calls).toEqual([]);
  });

  it("(h) applies the resolved pair exactly once, and a throwing port refuses after ONE attempt", async () => {
    const f = await fixture();
    const resolved = await resolveRollbackRestore(f.config, ENVIRONMENT);
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) throw new Error("unreachable: asserted a resolved pair above");

    const applied = await applyResolvedRestore(resolved, f.ports);

    // EXACT KEYS, not `toMatchObject`: `databaseUrl` travelled in on `resolved` and must NOT
    // travel out — this value is what the command may put on a durable surface.
    expect(applied).toEqual({ dump: pathOf(f.currentRef), ok: true });
    // The pair really was spent on the port, both halves of it, and exactly once.
    expect(f.ports.calls).toEqual([{ connection: PRODUCTION_URL, path: pathOf(f.currentRef) }]);

    // A SECOND PORT, throwing, against the SAME already-resolved pair: the refusal belongs to the
    // apply, and re-resolving is not part of it.
    const throwing = recordingPorts(true);
    expect(refusalOf(await applyResolvedRestore(resolved, throwing))).toEqual({
      code: "DEPLOY_ROLLBACK_RESTORE_FAILED",
      detail: ROLLBACK_RESTORE_DETAILS.DEPLOY_ROLLBACK_RESTORE_FAILED,
      layer: ROLLBACK_RESTORE_STAMP,
    });
    // NO AUTOMATIC RETRY — a half that tried three times and then refused would pass every other
    // assertion in this arm.
    expect(throwing.calls).toHaveLength(1);
  });
});
