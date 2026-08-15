import { readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { BackupGenerationReason } from "./backup-generation-contracts.js";
import { verifyBackupGeneration } from "./backup-generation-manifest.js";

/**
 * Where a superseded generation waits while its replacement is renamed in.
 *
 * A reserved sibling rather than a random temporary name: after a crash the
 * recovery below has to find it again from the destination path alone.
 */
export function backupAsidePath(finalPath: string): string {
  return `${finalPath}.previous`;
}

/** `stat` throws for a missing path rather than returning a falsy value. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is a COMPLETE generation present at `path`?
 *
 * Completeness, deliberately not authority. The carried key is anchored to
 * itself here, so this answers "are these bytes an internally consistent, fully
 * populated generation" and never "is this generation trusted" — trust is the
 * caller's anchored-key decision at restore time, and the previous generation's
 * signing key is not knowable during recovery. Shape, digest and signature come
 * from the production verifier; only the on-disk inventory is added, because a
 * manifest alone is exactly the half-published directory this guards against.
 */
export async function generationIsComplete(path: string): Promise<boolean> {
  let container: unknown;
  try {
    container = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
  } catch {
    return false;
  }
  // `JSON.parse("null")` parses cleanly, so the cast is null-tolerant: reading a
  // field off it would be a TypeError escaping a function whose whole contract
  // is to ANSWER, and it would surface as the catch-all refusal instead.
  const carried = container as { keyId?: unknown; publicKeySpkiDer?: unknown } | null;
  const verified = verifyBackupGeneration(container, {
    anchoredKeys: [{ keyId: carried?.keyId, publicKeySpkiDer: carried?.publicKeySpkiDer }],
  });
  if (!verified.ok) return false;
  if (!(await pathExists(join(path, "database.sqlite")))) return false;
  for (const entry of verified.manifest.objects) {
    if (!(await pathExists(join(path, ...entry.logicalPath.split("/"))))) return false;
  }
  return true;
}

/**
 * Swaps a fully staged generation into place without ever destroying the only
 * copy that exists.
 *
 * Windows cannot rename onto an existing directory, which is why the previous
 * generation is moved aside rather than deleted: at every instant a COMPLETE
 * generation is present under one of two known names, and the exposed interval
 * is two adjacent metadata renames rather than a recursive delete of an entire
 * generation directory.
 */
export async function publishStagedGeneration(
  stagingRoot: string,
  finalPath: string,
): Promise<void> {
  const asidePath = backupAsidePath(finalPath);
  const hadPrevious = await pathExists(finalPath);
  if (hadPrevious) await rename(finalPath, asidePath);
  try {
    await rename(stagingRoot, finalPath);
  } catch (error) {
    // A failed publish must never be the reason the destination is empty.
    if (hadPrevious) await rename(asidePath, finalPath).catch(() => undefined);
    throw error;
  }
  // The publish has already succeeded here. A held handle on the superseded
  // copy raises EBUSY on Windows, which `force` does NOT suppress, and that
  // must not turn a published generation into a failure: the recovery below
  // removes the leftover on the next run.
  await rm(asidePath, { force: true, recursive: true }).catch(() => undefined);
}

/**
 * Resolves the destination an interrupted publish left behind, deciding from
 * which paths exist and whether the generation at each is complete — never from
 * timestamps or directory mtimes, which would make correctness depend on host
 * clock and filesystem behavior.
 *
 * Recovery is not optional housekeeping: a leftover aside also blocks every
 * later publish, because renaming onto an existing directory fails on Windows.
 * A combination those facts cannot settle refuses with the existing store
 * reason rather than picking a side, since choosing wrong here presents an
 * unverified generation as a complete one.
 */
export async function resolveInterruptedPublish(
  finalPath: string,
): Promise<BackupGenerationReason | null> {
  const asidePath = backupAsidePath(finalPath);
  if (!(await pathExists(asidePath))) return null;
  if (await pathExists(finalPath)) {
    // Both names occupied: the swap landed and only the removal was cut short —
    // unless what landed is not a complete generation, which no fact on disk
    // can disambiguate from a destination that was never a generation at all.
    if (!(await generationIsComplete(finalPath))) return "DURABILITY_FAULT";
    await rm(asidePath, { force: true, recursive: true });
    return null;
  }
  // Only the aside survives: the process died between the two renames.
  if (!(await generationIsComplete(asidePath))) return "DURABILITY_FAULT";
  await rename(asidePath, finalPath);
  return null;
}
