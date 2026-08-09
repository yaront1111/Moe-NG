import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";

import type { BackupGenerationReason } from "./backup-generation-contracts.js";
import { SQLITE_APPLICATION_ID } from "./store-contracts.js";

export interface CapturedDatabase {
  readonly byteLength: string;
  readonly cursor: string;
  readonly digest: string;
}

export type CaptureOutcome =
  | { readonly ok: false; readonly reason: BackupGenerationReason }
  | { readonly ok: true; readonly captured: CapturedDatabase };

const fail = (reason: BackupGenerationReason): CaptureOutcome => ({ ok: false, reason });

function readTailCursor(database: DatabaseSync): string {
  // CAST to TEXT in SQL: global_position is a bigint column and reading it as a
  // JS number would silently lose precision past 2^53.
  const row = database
    .prepare("SELECT CAST(COALESCE(MAX(global_position), 0) AS TEXT) AS tail FROM domain_events")
    .get() as { tail: string } | undefined;
  return row?.tail ?? "0";
}

function readBoundProject(database: DatabaseSync): string | null {
  const row = database
    .prepare("SELECT project_id AS projectId FROM store_project_binding WHERE singleton = 1")
    .get() as { projectId: string } | undefined;
  return row?.projectId ?? null;
}

async function streamDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  // Streamed rather than buffered: a project database can be multiple GiB and
  // reading it whole would trade a correctness win for an OOM.
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest("hex");
}

/**
 * Validates the staged image in its own right rather than trusting that a
 * successful copy implies a sound database.
 */
function validateStagedImage(
  path: string,
  projectId: string,
  cursor: string,
): BackupGenerationReason | null {
  let staged: DatabaseSync | null = null;
  try {
    staged = new DatabaseSync(path, { readOnly: true });
    const quick = staged.prepare("PRAGMA quick_check").get() as
      | Record<string, unknown>
      | undefined;
    if (Object.values(quick ?? {})[0] !== "ok") return "DATABASE_UNREADABLE";
    if ((staged.prepare("PRAGMA foreign_key_check").all() as unknown[]).length > 0) {
      return "DATABASE_UNREADABLE";
    }
    if (readBoundProject(staged) !== projectId) return "DATABASE_UNREADABLE";
    // The image must carry the exact cursor that was seated, not merely a
    // plausible one: this is what makes the generation cursor-BOUND.
    if (readTailCursor(staged) !== cursor) return "CURSOR_BEHIND_DATABASE";
    return null;
  } catch {
    return "DATABASE_UNREADABLE";
  } finally {
    staged?.close();
  }
}

/**
 * Snapshots the project database at one committed cursor.
 *
 * The read snapshot is seated by opening a dedicated read-only connection,
 * forcing `query_only`, beginning a deferred transaction and READING the tail —
 * a deferred transaction acquires nothing until its first read, so the read is
 * what pins the snapshot. `backup` then runs while that transaction stays open,
 * which is why commits landing on the live writer afterwards are outside the
 * captured generation rather than racing into it.
 */
export async function captureDatabaseAtCursor(
  databasePath: string,
  projectId: string,
  expectedCursor: string,
  stagedDatabasePath: string,
): Promise<CaptureOutcome> {
  let source: DatabaseSync | null = null;
  let seated = false;
  try {
    source = new DatabaseSync(databasePath, { readOnly: true });
    source.exec("PRAGMA query_only=ON");

    const applicationId = Object.values(
      (source.prepare("PRAGMA application_id").get() as Record<string, unknown>) ?? {},
    )[0];
    if (applicationId !== SQLITE_APPLICATION_ID) return fail("DATABASE_UNREADABLE");

    source.exec("BEGIN DEFERRED");
    seated = true;
    if (readBoundProject(source) !== projectId) return fail("DATABASE_UNREADABLE");

    const tail = readTailCursor(source);
    // Compared BEFORE any bytes are published, so a mismatched request never
    // produces a partial generation on disk.
    if (BigInt(expectedCursor) > BigInt(tail)) return fail("CURSOR_AHEAD_OF_DATABASE");
    if (BigInt(expectedCursor) < BigInt(tail)) return fail("CURSOR_BEHIND_DATABASE");

    await backup(source, stagedDatabasePath);
    source.exec("COMMIT");
    seated = false;
  } catch {
    return fail("DATABASE_UNREADABLE");
  } finally {
    if (source !== null) {
      if (seated) {
        try {
          source.exec("ROLLBACK");
        } catch {
          // The connection is closed next regardless; a failed rollback on a
          // read-only snapshot releases with the handle.
        }
      }
      source.close();
    }
  }

  const invalid = validateStagedImage(stagedDatabasePath, projectId, expectedCursor);
  if (invalid !== null) return fail(invalid);

  // Opening a WAL database — even read-only, even to validate it — leaves `-wal`
  // and `-shm` sidecars beside the image. They must not be published: the
  // manifest's `databaseDigest` covers `database.sqlite` alone, so a sidecar
  // riding along would be content that changes what restores while breaking no
  // digest. Removed BEFORE hashing so the digest covers the final bytes.
  try {
    await rm(`${stagedDatabasePath}-wal`, { force: true });
    await rm(`${stagedDatabasePath}-shm`, { force: true });
  } catch {
    return fail("DURABILITY_FAULT");
  }

  try {
    return {
      captured: {
        byteLength: String((await stat(stagedDatabasePath)).size),
        cursor: expectedCursor,
        digest: await streamDigest(stagedDatabasePath),
      },
      ok: true,
    };
  } catch {
    return fail("DATABASE_UNREADABLE");
  }
}
