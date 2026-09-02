import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLITE_SCHEMA_MANIFEST_VERSION, SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { DIGEST, recordOf, seedImport } from "../projections/import-shadow-test-fixtures.js";
import { runRestoreQuiesce } from "../recovery/restore-controller.js";
import {
  PROJECT_ID as RESTORE_PROJECT_ID, anchoredIncarnation, cleanupRestoreHarnesses, restoreHarness,
  restoreRequest,
} from "../recovery/restore-test-harness.js";
import { writeLiveQuiesceEvidence } from "./cutover-activate-test-fixtures.js";
import { readCutoverGenerationSnapshot } from "./cutover-generation-snapshot.js";
import type { CutoverGenerationPorts } from "./cutover-generation-snapshot.js";
import { canonicalJson } from "./v2-readiness-evidence-contract.js";
import { produceBackupEvidence, produceStoreMigrationEvidence }
  from "./v2-readiness-evidence-store-producers.js";
import type { V2EvidenceStorePorts } from "./v2-readiness-evidence-store-producers.js";

/**
 * Both producers run against REAL file-backed stores: the migration producer against a
 * store the production store class created, the backup producer against a store carried
 * through the production restore controller — the only writer of the ProjectQuiesced
 * witness and the ACTIVE restore binding it embeds.
 */
const COMMIT = "b".repeat(40);
const directories: string[] = [];
afterAll(() => {
  cleanupRestoreHarnesses();
  for (const directory of directories) rmSync(directory, { force: true, recursive: true });
});

function scratch(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `moe-evidence-store-${label}-`));
  directories.push(directory);
  return directory;
}

const ports: V2EvidenceStorePorts = {
  readFile: (path) => new Uint8Array(readFileSync(path)),
  removeDirectory: (path) => { rmSync(path, { force: true, recursive: true }); },
  temporaryDirectory: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
};

const parse = (bytes: Uint8Array): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

describe("storeMigrationEvidence", () => {
  it("snapshots the store read-only, migrates the copy through the production store, and reads it back", () => {
    const directory = scratch("migration");
    const storePath = join(directory, "store.sqlite");
    const store = SqliteEventStore.openForProject(storePath, "project-migration");
    store.commit({
      aggregateId: "agg-1", commandBytes: new Uint8Array([1]), commandId: "cmd-1",
      committedAt: "2026-09-02T00:00:00.000Z",
      events: [{ eventId: "evt-1", eventType: "Seeded", payload: new Uint8Array([2]) }],
      expectedVersion: 0,
    });
    try {
      const outcome = produceStoreMigrationEvidence(ports, { projectId: "project-migration", storePath }, COMMIT);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const record = parse(outcome.bytes);
      expect(record).toMatchObject({
        after: { foreignKeyViolations: 0, quickCheck: "ok", schemaManifestVersion: SQLITE_SCHEMA_MANIFEST_VERSION },
        before: { schemaManifestVersion: SQLITE_SCHEMA_MANIFEST_VERSION },
        projectId: "project-migration", schemaVersion: "moe-store-migration-evidence/1",
        sourceCommit: COMMIT, storeSchemaVersion: SQLITE_SCHEMA_MANIFEST_VERSION,
      });
      expect((record["before"] as { userVersion: number }).userVersion).toBeGreaterThan(0);
      expect((record["after"] as { userVersion: number }).userVersion)
        .toBe((record["before"] as { userVersion: number }).userVersion);
      expect(typeof record["storeDatabaseSha256"]).toBe("string");
      expect(new TextDecoder().decode(outcome.bytes)).toBe(canonicalJson(record));
      // The SOURCE store is untouched: the migration ran on the snapshot only, and the
      // handle that was open throughout still reads its own committed history.
      expect(store.getAggregateVersion("agg-1")).toBe(1);
      expect(store.readEvents("agg-1").map((event) => event.eventType)).toEqual(["Seeded"]);
    } finally {
      store.close();
    }
  });

  it("refuses a file that is not a moe store, and a path that does not exist", () => {
    const directory = scratch("not-a-store");
    const plain = join(directory, "plain.sqlite");
    writeFileSync(plain, "");
    expect(produceStoreMigrationEvidence(ports, { projectId: "p", storePath: plain }, COMMIT))
      .toMatchObject({ code: "V2_EVIDENCE_INPUT_INVALID", ok: false });
    expect(produceStoreMigrationEvidence(ports, { projectId: "p", storePath: join(directory, "absent.sqlite") }, COMMIT))
      .toMatchObject({ code: "V2_EVIDENCE_INPUT_UNREADABLE", ok: false });
  });
});

describe("backupEvidence", () => {
  it("embeds the tuple the quiesce witness, the installed restore and the anchor agree on", async () => {
    const harness = await restoreHarness("backup-evidence");
    const binding = await anchoredIncarnation(harness, "restore-cmd-backup");
    const quiesced = runRestoreQuiesce(harness.store, restoreRequest(harness, binding));
    if (!quiesced.ok) throw new Error(`restore refused: ${quiesced.code}`);
    seedImport(harness.store, DIGEST, [recordOf()]);
    const storeRoot = join(scratch("backup-root"), "root");
    mkdirSync(storeRoot, { recursive: true });
    writeLiveQuiesceEvidence(storeRoot);
    const generation: CutoverGenerationPorts = {
      config: { storeRoot }, readFileText: (path) => readFileSync(path, "utf8"), store: harness.store,
    };
    const snapshot = readCutoverGenerationSnapshot(generation, { projectId: RESTORE_PROJECT_ID });
    if (!snapshot.ok) throw new Error(`snapshot refused: ${snapshot.code}`);

    const outcome = produceBackupEvidence({ generation, projectId: RESTORE_PROJECT_ID, store: harness.store }, COMMIT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(parse(outcome.bytes)).toMatchObject({
      backupCursor: harness.backupCursor,
      backupGenerationDigest: harness.generationDigest,
      incarnationRef: binding.incarnationRef,
      keyEpochRef: binding.keyEpochRef,
      projectId: RESTORE_PROJECT_ID,
      quiesceRecordSha256: snapshot.generations.quiesceRecordSha256,
      restoreBindingSlot: "ACTIVE",
      restoreCommandId: "restore-cmd-backup",
      schemaVersion: "moe-backup-evidence/1",
      sourceCommit: COMMIT,
    });
    // The generation the snapshot answered is the one the restore installed, by construction.
    expect(snapshot.generations.backupGenerationDigest).toBe(harness.generationDigest);
  }, 60_000);

  it("refuses a store that never restored, forwarding the snapshot's own code", () => {
    const directory = scratch("backup-absent");
    const store = SqliteEventStore.openForProject(join(directory, "store.sqlite"), "project-never-restored");
    try {
      const generation: CutoverGenerationPorts = {
        config: { storeRoot: directory }, readFileText: (path) => readFileSync(path, "utf8"), store,
      };
      expect(produceBackupEvidence({ generation, projectId: "project-never-restored", store }, COMMIT))
        .toMatchObject({
          code: "V2_EVIDENCE_STORE_REFUSED", ok: false,
          upstream: { layer: "DAEMON_CUTOVER_GENERATION" },
        });
    } finally {
      store.close();
    }
  });
});
