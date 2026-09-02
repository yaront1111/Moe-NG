import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DurableStoreError, SQLITE_SCHEMA_MANIFEST_VERSION, SqliteEventStore } from "@moe/store";

import { readAnchoredIncarnation } from "../recovery/recovery-incarnation-anchor.js";
import { readInstalledRestore } from "../recovery/restore-controller.js";
import { readCutoverGenerationSnapshot } from "./cutover-generation-snapshot.js";
import type { CutoverGenerationPorts } from "./cutover-generation-snapshot.js";
import { producedRecord, refusedEvidence, sha256Hex } from "./v2-readiness-evidence-contract.js";
import type { V2EvidenceOutcome } from "./v2-readiness-evidence-contract.js";

/**
 * The two producers whose input is the QUIESCED STORE itself. Both read through production
 * readers and embed only what those readers answered; neither takes a digest from a caller.
 */

export interface V2EvidenceStorePorts {
  readonly readFile: (path: string) => Uint8Array;
  /** A fresh directory this producer owns for the life of one call. */
  readonly temporaryDirectory: (prefix: string) => string;
  readonly removeDirectory: (path: string) => void;
}

// ---- storeMigrationEvidence -----------------------------------------------------------

interface SchemaFacts {
  readonly schemaManifestVersion: string | null;
  readonly userVersion: number;
}

function readSchemaFacts(database: DatabaseSync): SchemaFacts {
  const version = database.prepare("PRAGMA user_version").get() as Readonly<Record<string, unknown>>;
  let manifest: string | null = null;
  try {
    const row = database.prepare("SELECT value FROM store_metadata WHERE key = 'schema_manifest_version'")
      .get() as Readonly<Record<string, unknown>> | undefined;
    manifest = typeof row?.["value"] === "string" ? row["value"] : null;
  } catch {
    manifest = null; // a pre-metadata schema: absence, recorded as such
  }
  return { schemaManifestVersion: manifest, userVersion: Number(version["user_version"]) };
}

/**
 * The migration is RUN, not asserted: the quiesced store is snapshotted read-only (its
 * `user_version` and manifest row captured BEFORE any migrating open, which is the one
 * fact the production migration overwrites), the snapshot is opened through the
 * production store — the migrating path every daemon boot takes — and the migrated copy's
 * schema facts, `quick_check` and `foreign_key_check` are read back. The source store is
 * never opened for writing here.
 */
export function produceStoreMigrationEvidence(
  ports: V2EvidenceStorePorts,
  input: Readonly<{ projectId: string; storePath: string }>,
  sourceCommit: string,
): V2EvidenceOutcome {
  const kind = "storeMigrationEvidence";
  const scratch = ports.temporaryDirectory("moe-store-migration-evidence-");
  const copyPath = join(scratch, "store.sqlite");
  try {
    let before: SchemaFacts;
    try {
      const source = new DatabaseSync(input.storePath, { readOnly: true });
      try {
        before = readSchemaFacts(source);
        // A consistent snapshot of the source through SQLite itself, never a file copy that
        // could miss a WAL frame. Works on a read-only connection by design.
        source.prepare("VACUUM INTO ?").run(copyPath);
      } finally {
        source.close();
      }
    } catch (error) {
      return refusedEvidence(kind, "V2_EVIDENCE_INPUT_UNREADABLE",
        `${input.storePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (before.userVersion === 0) {
      return refusedEvidence(kind, "V2_EVIDENCE_INPUT_INVALID", "user_version 0: not a moe store");
    }
    const storeDatabaseSha256 = sha256Hex(ports.readFile(copyPath));

    try {
      SqliteEventStore.openForProject(copyPath, input.projectId).close();
    } catch (error) {
      return refusedEvidence(kind, "V2_EVIDENCE_STORE_REFUSED",
        error instanceof Error ? error.message : String(error),
        error instanceof DurableStoreError ? { code: error.code, layer: "DURABLE_STORE" } : null);
    }

    const migrated = new DatabaseSync(copyPath, { readOnly: true });
    let after: SchemaFacts & { readonly foreignKeyViolations: number; readonly quickCheck: string };
    try {
      const quick = migrated.prepare("PRAGMA quick_check").all() as readonly Readonly<Record<string, unknown>>[];
      const foreign = migrated.prepare("PRAGMA foreign_key_check").all();
      after = {
        ...readSchemaFacts(migrated),
        foreignKeyViolations: foreign.length,
        quickCheck: quick.map((row) => String(row["quick_check"])).join("; "),
      };
    } finally {
      migrated.close();
    }
    if (after.schemaManifestVersion !== SQLITE_SCHEMA_MANIFEST_VERSION || after.quickCheck !== "ok"
      || after.foreignKeyViolations !== 0) {
      return refusedEvidence(kind, "V2_EVIDENCE_STORE_REFUSED",
        `migrated copy: manifest ${String(after.schemaManifestVersion)}, quick_check ${after.quickCheck}, `
        + `${String(after.foreignKeyViolations)} foreign-key violations`);
    }
    return producedRecord(kind, {
      after, before, projectId: input.projectId, schemaVersion: "moe-store-migration-evidence/1",
      sourceCommit, storeDatabaseSha256, storeSchemaVersion: SQLITE_SCHEMA_MANIFEST_VERSION,
    });
  } finally {
    ports.removeDirectory(scratch);
  }
}

// ---- backupEvidence -------------------------------------------------------------------

/**
 * The durable backup tuple, read where the activation reads it: the fenced generation
 * snapshot (backup generation AND quiesce record under one horizon), the INSTALLED restore
 * binding in the ACTIVE slot, and the anchored restore incarnation — three sources that
 * must name the same generation and the same restore command, or nothing is produced.
 */
export function produceBackupEvidence(
  input: Readonly<{ generation: CutoverGenerationPorts; projectId: string; store: SqliteEventStore }>,
  sourceCommit: string,
): V2EvidenceOutcome {
  const kind = "backupEvidence";
  const snapshot = readCutoverGenerationSnapshot(input.generation, { projectId: input.projectId });
  if (!snapshot.ok) return refusedEvidence(kind, "V2_EVIDENCE_STORE_REFUSED", snapshot.code, snapshot);
  const restore = readInstalledRestore(input.store, input.projectId);
  if (!restore.ok) return refusedEvidence(kind, "V2_EVIDENCE_STORE_REFUSED", restore.code, restore);
  if (restore.outcome !== "INSTALLED") {
    return refusedEvidence(kind, "V2_EVIDENCE_STORE_REFUSED", `restore binding is ${restore.outcome}`);
  }
  const { record } = restore;
  const anchored = readAnchoredIncarnation(input.store, input.projectId, record.incarnationRef);
  if (anchored === null) {
    return refusedEvidence(kind, "V2_EVIDENCE_STORE_REFUSED", `no anchored incarnation ${record.incarnationRef}`);
  }
  if (record.generationDigest !== snapshot.generations.backupGenerationDigest
    || anchored.backupGenerationDigest !== record.generationDigest
    || anchored.restoreCommandId !== record.restoreCommandId) {
    return refusedEvidence(kind, "V2_EVIDENCE_INPUT_INVALID",
      "the quiesce witness, the installed restore and the anchored incarnation name different generations");
  }
  return producedRecord(kind, {
    anchorBindingDigest: anchored.bindingDigest,
    backupCursor: record.backupCursor,
    backupGenerationDigest: record.generationDigest,
    incarnationRef: record.incarnationRef,
    keyEpochRef: record.keyEpochRef,
    projectId: input.projectId,
    quiesceRecordSha256: snapshot.generations.quiesceRecordSha256,
    restoreBindingDigest: restore.bindingDigest,
    restoreBindingSlot: "ACTIVE",
    restoreCommandId: record.restoreCommandId,
    schemaVersion: "moe-backup-evidence/1",
    sourceCommit,
  });
}
