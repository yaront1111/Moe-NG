/**
 * THE BOUNDED MIGRATION OBSERVATION, over REAL receipts written by the production engines
 * (`migrateWithBackup`, `revertLastBatch`) and a real store — never hand-built receipt objects,
 * so a projection that only satisfies a fixture's shape reds here.
 *
 * The leak arms carry POSITIVE CONTROLS: each asserts the credential-shaped value or untrusted
 * path is genuinely present in the durable receipt before asserting it is absent from the served
 * observation. Without that, "the output does not contain a password" passes because no password
 * was ever there.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { MigrationExecutionError } from "../repository/migrations/migration-ports.js";
import type { MigrationDownPorts } from "../repository/migrations/migration-down-ports.js";
import type { MigrationPorts } from "../repository/migrations/migration-ports.js";
import {
  MIGRATION_RECEIPT_COMMAND_KIND, migrationReceiptId, readMigrationReceipt, recordMigrationReceipt,
} from "../repository/migrations/migration-receipt.js";
import { revertLastBatch } from "../repository/migrations/migration-down-service.js";
import { migrateWithBackup } from "../repository/migrations/migration-service.js";
import { recordDeployReceipt } from "./deploy-ledger.js";
import type { DeployReceiptV1 } from "./deploy-receipt-contracts.js";
import { MAX_MIGRATION_IDENTIFIERS, readMigrationObservation } from "./migration-observation.js";

const roots: string[] = [];
afterEach(() => { closeStores(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;
const DATABASE_URL = "postgresql://admin:hunter2@db.internal:5432/product";
const ONE = ["1700000000001-first.js"];
const TWO = ["1700000000002-second.js", "1700000000003-third.js"];
/** The migration engine derives the dump leaf from the receipt instant, so distinct instants are
 *  what keep two receipts from colliding on one backup destination. */
const at = (hour: number) => new Date(`2026-09-06T0${hour}:00:00.000Z`);

function world() {
  const projectRoot = mkdtempSync(join(tmpdir(), "moe-migration-observation-")); roots.push(projectRoot);
  const store = openStore();
  const ports: MigrationPorts = {
    dump: async (_connection, path) => { writeFileSync(path, "fixture backup"); },
    apply: async () => ONE,
  };
  const down: MigrationDownPorts = {
    dump: async (_connection, path) => { writeFileSync(path, "fixture backup"); },
    revert: async (_workspace, _connection, batch) => [...batch].reverse(),
  };
  /** A REAL deploy receipt on the environment's own aggregate: its `decisionId` is the durable
   *  key the observation resolves the migration receipt by. */
  const deploy = (environment: string, decisionId: string): DeployReceiptV1 => {
    const result = recordDeployReceipt(store, { projectId: PROJECT_ID, environment, decisionId,
      decidedAt: "2026-09-06T09:00:00.000Z", imageDigest: DIGEST, refusal: null,
      releaseDecision: null, sha: SHA, url: null });
    if (!result.ok) throw new Error(result.code);
    return result.receipt;
  };
  const migrate = (requestId: string, environment: string, hour: number, over: Partial<MigrationPorts> = {}) =>
    migrateWithBackup(store, { projectRoot, workspace: projectRoot, projectId: PROJECT_ID, requestId,
      environment, sha: SHA, databaseUrl: DATABASE_URL, now: at(hour) }, { ...ports, ...over });
  const revert = (requestId: string, environment: string, toMigrationRequestId: string, hour: number) =>
    revertLastBatch(store, { projectRoot, workspace: projectRoot, projectId: PROJECT_ID, requestId,
      environment, toMigrationRequestId, databaseUrl: DATABASE_URL, now: at(hour) }, down);
  const observe = (environment: string, receipt: DeployReceiptV1 | null, root: string | null = projectRoot) =>
    readMigrationObservation(store, PROJECT_ID, environment, receipt, { backupRoot: root });
  return { projectRoot, store, ports, deploy, migrate, revert, observe };
}

/** A decision under the receipt's own key whose bytes are not a receipt: the strict decoder throws
 *  MIGRATION_RECEIPT_INVALID on it, which is the corruption the projection must survive. */
function corrupt(store: ReturnType<typeof openStore>, requestId: string): void {
  const id = migrationReceiptId(PROJECT_ID, requestId);
  const bytes = new TextEncoder().encode('{"version":"moe-migration-receipt/1"}');
  const response = store.commitExpectedVersionDecision({ commandKind: MIGRATION_RECEIPT_COMMAND_KIND,
    committedResultBytes: bytes, correlationId: requestId, decidedAt: "2026-09-06T05:00:00.000Z",
    events: [{ eventId: `${id}-recorded`, eventType: "MigrationRecorded", payload: bytes }],
    expectedVersion: 0, key: { commandId: id, principalId: "daemon:migration-engine", projectId: PROJECT_ID },
    requestBytes: bytes, targetAggregateId: `migration:${id}` });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") throw new Error("fixture corruption refused");
}

describe("a decoded receipt becomes a bounded project/environment observation", () => {
  it("carries APPLIED with every identifier BY VALUE AND BY COUNT and a verified backup", async () => {
    const w = world();
    const applied = await w.migrate("deploy-1", "production", 1, { apply: async () => TWO });
    expect(applied.outcome).toBe("APPLIED");
    const view = w.observe("production", w.deploy("production", "deploy-1"));
    // A projection that kept only the first identifier passes every single-migration fixture.
    expect(view.migrations).toEqual(TWO);
    expect(view.migrations).toHaveLength(2);
    expect(view).toMatchObject({ subject: "PROJECT_ENVIRONMENT", environment: "production",
      state: "OBSERVED", receiptId: applied.receiptId, outcome: "APPLIED", backupState: "VERIFIED",
      backupSha256: applied.backupRef!.split("@sha256:")[1], refusalCode: null, refusalLayer: null,
      refusalFile: null, unknownCode: null, unknownLayer: null });
  });

  it("never presents the observation as node or goal ownership", async () => {
    const w = world();
    await w.migrate("deploy-1", "production", 1);
    const view = w.observe("production", w.deploy("production", "deploy-1"));
    // The receipt's eleven keys carry no nodeRef or goalRef, so neither may be invented here.
    expect(view.subject).toBe("PROJECT_ENVIRONMENT");
    expect(Object.keys(view)).not.toContain("nodeRef");
    expect(Object.keys(view)).not.toContain("goalRef");
  });

  it("keeps two environments' receipts apart in both directions", async () => {
    const w = world();
    const staging = await w.migrate("deploy-staging", "staging", 1, { apply: async () => ONE });
    const production = await w.migrate("deploy-production", "production", 2, { apply: async () => TWO });
    const onStaging = w.observe("staging", w.deploy("staging", "deploy-staging"));
    const onProduction = w.observe("production", w.deploy("production", "deploy-production"));
    expect(onStaging).toMatchObject({ environment: "staging", receiptId: staging.receiptId });
    expect(onStaging.migrations).toEqual(ONE);
    expect(onProduction).toMatchObject({ environment: "production", receiptId: production.receiptId });
    expect(onProduction.migrations).toEqual(TWO);
    // Neither row carries a trace of the other's receipt: no bleed, asserted both ways.
    expect(onStaging.receiptId).not.toBe(production.receiptId);
    expect(onStaging.migrations).not.toContain(TWO[0]);
    expect(onProduction.migrations).not.toContain(ONE[0]);
  });

  it("refuses a receipt whose environment disagrees with the row rather than bleeding it across", async () => {
    const w = world();
    // The receipt sits at PRODUCTION's durable key but records STAGING. The lookup selects it; the
    // guard is what stops it being served on the production row.
    await w.migrate("deploy-1", "staging", 1);
    const view = w.observe("production", w.deploy("production", "deploy-1"));
    expect(view).toMatchObject({ environment: "production", state: "UNKNOWN",
      unknownCode: "MIGRATION_RECEIPT_INVALID", unknownLayer: "DAEMON_INGRESS", outcome: null });
    expect(view.migrations).toBeNull();
  });

  it("carries REVERTED with the reversed batch and its own backup", async () => {
    const w = world();
    await w.migrate("batch-one", "production", 1, { apply: async () => TWO });
    const reverted = await w.revert("deploy-2", "production", "batch-one", 3);
    expect(reverted.outcome).toBe("REVERTED");
    const view = w.observe("production", w.deploy("production", "deploy-2"));
    expect(view).toMatchObject({ state: "OBSERVED", outcome: "REVERTED", backupState: "VERIFIED" });
    expect(view.migrations).toEqual([...TWO].reverse());
    expect(view.migrations).toHaveLength(2);
    expect(view.backupSha256).toBe(reverted.backupRef!.split("@sha256:")[1]);
  });
});

describe("refusals name the code AND the layer that answered", () => {
  it("reports a refusal taken BEFORE the backup with no backup at all", async () => {
    const w = world();
    const refused = await w.migrate("deploy-1", "production", 1, {
      dump: async () => { throw new Error("unavailable"); },
    });
    expect(refused).toMatchObject({ outcome: "REFUSED", backupRef: null });
    const view = w.observe("production", w.deploy("production", "deploy-1"));
    expect(view).toMatchObject({ state: "OBSERVED", outcome: "REFUSED",
      refusalCode: "MIGRATION_BACKUP_FAILED", refusalLayer: "DAEMON_INGRESS",
      backupState: "NONE", backupSha256: null });
    // "backup failed" is not a migration filename, so no failing file is claimed.
    expect(view.refusalFile).toBeNull();
    expect(view.migrations).toEqual([]);
  });

  it("reports a refusal taken AFTER the backup with the failing file basename and the backup kept", async () => {
    const w = world();
    const refused = await w.migrate("deploy-1", "production", 1, {
      apply: async () => { throw new MigrationExecutionError("1700000000009-broken.js"); },
    });
    expect(refused.backupRef).not.toBeNull();
    const view = w.observe("production", w.deploy("production", "deploy-1"));
    expect(view).toMatchObject({ state: "OBSERVED", outcome: "REFUSED",
      refusalCode: "MIGRATION_FAILED", refusalLayer: "DAEMON_INGRESS",
      refusalFile: "1700000000009-broken.js", backupState: "VERIFIED" });
    expect(view.backupSha256).toBe(refused.backupRef!.split("@sha256:")[1]);
    expect(view.migrations).toEqual([]);
  });
});

describe("UNKNOWN and known-none are different answers", () => {
  it("answers UNKNOWN, never APPLIED and never no-pending-work, for an absent or corrupt receipt", async () => {
    const w = world();
    const absent = w.observe("production", w.deploy("production", "deploy-1"));
    expect(absent).toMatchObject({ state: "UNKNOWN", unknownCode: "MIGRATION_RECEIPT_ABSENT",
      unknownLayer: "DAEMON_INGRESS", outcome: null, receiptId: null, backupState: null });
    expect(absent.migrations).toBeNull();
    expect(w.observe("production", null)).toMatchObject({ state: "UNKNOWN",
      unknownCode: "MIGRATION_RECEIPT_ABSENT" });
    corrupt(w.store, "deploy-2");
    expect(() => readMigrationReceipt(w.store, PROJECT_ID, "deploy-2"))
      .toThrowError("MIGRATION_RECEIPT_INVALID@DAEMON_INGRESS");
    const broken = w.observe("production", w.deploy("production", "deploy-2"));
    expect(broken).toMatchObject({ state: "UNKNOWN", unknownCode: "MIGRATION_RECEIPT_INVALID",
      unknownLayer: "DAEMON_INGRESS", outcome: null });
    expect(broken.migrations).toBeNull();
    await Promise.resolve();
  });

  it("distinguishes an unreadable answer from a receipt that honestly moved nothing", async () => {
    const w = world();
    const none = await w.migrate("deploy-1", "production", 1, { apply: async () => [] });
    expect(none.outcome).toBe("APPLIED");
    const known = w.observe("production", w.deploy("production", "deploy-1"));
    // KNOWN-NONE is an empty array; UNKNOWN is null. Collapsing them would report "nothing to
    // apply" about a project nobody could read.
    expect(known).toMatchObject({ state: "OBSERVED", outcome: "APPLIED" });
    expect(known.migrations).toEqual([]);
    expect(w.observe("production", null).migrations).toBeNull();
    expect(known.migrations).not.toBeNull();
  });
});

describe("no secret, path or download affordance reaches the observation", () => {
  it("withholds a credential-shaped refusal detail entirely, and the control proves it was there", async () => {
    const w = world();
    // A REAL production path that writes caller text verbatim into the receipt: the revert records
    // the request id it could not find as its refusal detail.
    const reverted = await w.revert("deploy-1", "production", DATABASE_URL, 3);
    // POSITIVE CONTROL: the credential IS in the durable receipt, so the assertions below are not
    // passing because nothing credential-shaped was ever present.
    expect(reverted.refusal?.detail).toBe(DATABASE_URL);
    expect(JSON.stringify(reverted)).toContain("hunter2");
    const view = w.observe("production", w.deploy("production", "deploy-1"));
    const served = JSON.stringify(view);
    expect(served).not.toContain("hunter2");
    expect(served).not.toContain(DATABASE_URL);
    expect(served).not.toContain("postgresql://");
    expect(view).toMatchObject({ outcome: "REFUSED", refusalCode: "MIGRATION_DOWN_BATCH_UNKNOWN",
      refusalLayer: "DAEMON_INGRESS", refusalFile: null, backupState: "NONE", backupSha256: null });
  });

  it("never serves a backup path, and refuses to call an unconfined reference verified", () => {
    const w = world();
    const outside = mkdtempSync(join(tmpdir(), "moe-migration-elsewhere-")); roots.push(outside);
    const stolen = join(outside, "20260906100000000.sql");
    writeFileSync(stolen, "not a confined backup");
    const digest = "d".repeat(64);
    const receipt = recordMigrationReceipt(w.store, { version: "moe-migration-receipt/1",
      receiptId: migrationReceiptId(PROJECT_ID, "deploy-1"), requestId: "deploy-1",
      projectId: PROJECT_ID, environment: "production", sha: SHA, decidedAt: "2026-09-06T01:00:00.000Z",
      applied: ONE, backupRef: `${stolen}@sha256:${digest}`, outcome: "APPLIED", refusal: null });
    // POSITIVE CONTROL: the untrusted path and its digest ARE in the durable receipt. The needle
    // is the JSON-ESCAPED path, because a Windows separator is doubled inside a serialised frame
    // and a raw-path search would miss a leak that really shipped.
    const needle = JSON.stringify(stolen).slice(1, -1);
    expect(receipt.backupRef).toBe(`${stolen}@sha256:${digest}`);
    expect(JSON.stringify(receipt)).toContain(needle);
    expect(JSON.stringify(receipt)).toContain(digest);
    expect(existsSync(stolen)).toBe(true);
    const view = w.observe("production", w.deploy("production", "deploy-1"));
    const served = JSON.stringify(view);
    expect(served).not.toContain(needle);
    expect(served).not.toContain(stolen);
    expect(served).not.toContain(JSON.stringify(outside).slice(1, -1));
    expect(served).not.toContain(digest);
    expect(served).not.toContain(".sql");
    // The file EXISTS — it is refused for being outside the confined directory, not for absence.
    expect(view).toMatchObject({ state: "OBSERVED", outcome: "APPLIED",
      backupState: "UNVERIFIED", backupSha256: null });
  });

  it("fails closed on an identifier or a batch past the served bounds instead of truncating", () => {
    const w = world();
    const long = `1700000000001-${"x".repeat(200)}.js`;
    // The receipt DECODER admits both of these — `migrationFilename` bounds the charset but not
    // the length, and `applied` is bounded only by the receipt's 1 MiB envelope. The projection is
    // where they stop, and it answers UNKNOWN rather than serving a shortened list of what ran.
    const receipt = recordMigrationReceipt(w.store, { version: "moe-migration-receipt/1",
      receiptId: migrationReceiptId(PROJECT_ID, "deploy-1"), requestId: "deploy-1",
      projectId: PROJECT_ID, environment: "production", sha: SHA, decidedAt: "2026-09-06T01:00:00.000Z",
      applied: [long], backupRef: `backup.sql@sha256:${"d".repeat(64)}`, outcome: "APPLIED", refusal: null });
    expect(receipt.applied).toEqual([long]);
    const view = w.observe("production", w.deploy("production", "deploy-1"));
    expect(view).toMatchObject({ state: "UNKNOWN", unknownCode: "MIGRATION_RECEIPT_INVALID",
      unknownLayer: "DAEMON_INGRESS" });
    expect(view.migrations).toBeNull();
    expect(JSON.stringify(view)).not.toContain("x".repeat(200));
    expect(MAX_MIGRATION_IDENTIFIERS).toBe(512);
  });

  it("reports a backup that is claimed but missing or unprovable as unverified, never as present", async () => {
    const w = world();
    const applied = await w.migrate("deploy-1", "production", 1);
    const path = applied.backupRef!.split("@sha256:")[0]!;
    const deployed = w.deploy("production", "deploy-1");
    expect(w.observe("production", deployed)).toMatchObject({ backupState: "VERIFIED" });
    // No root means no confinement proof, so the claim is not promoted to an existing backup.
    expect(w.observe("production", deployed, null)).toMatchObject({
      backupState: "UNVERIFIED", backupSha256: null });
    rmSync(path, { force: true });
    expect(existsSync(path)).toBe(false);
    expect(w.observe("production", deployed)).toMatchObject({
      backupState: "UNVERIFIED", backupSha256: null });
  });
});
