/**
 * The durability primitive behind the anchor: write -> fsync -> close ->
 * rename -> parent persistence -> read-back verification.
 *
 * backup-generation.ts already follows this shape, but its `persistFile` is
 * module-private and that module is not one of this task's owned paths, so this
 * is a deliberate second implementation rather than an edit to a landed,
 * reviewed durability path. It differs in what it needs: directory persistence
 * and an atomic publish-over-existing, neither of which the backup writer has.
 */
import { createHash } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** win32 has no POSIX directory-fsync; claiming it would be a false guarantee. */
const DIRECTORY_FSYNC_SUPPORTED = process.platform !== "win32";

export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Write, flush to the device, then close. A write that was never flushed is not evidence. */
export async function persistFileDurably(path: string, payload: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "w");
  try {
    await handle.write(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Persist a directory entry itself, so the names of the files just written
 * survive a power loss and not merely their contents.
 *
 * On win32 this is a no-op by design: the platform exposes no directory-fsync,
 * and taskRail 3 forbids claiming POSIX semantics there. Windows durability is
 * carried by re-opening and syncing the published FILE instead, which
 * `publishFileAtomically` does unconditionally.
 */
export async function persistDirectoryDurably(path: string): Promise<void> {
  if (!DIRECTORY_FSYNC_SUPPORTED) return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Publish bytes at `path` such that a reader sees either the previous content
 * or the new content, never a partial write. The temp file is fully flushed
 * before the rename, and the final name is re-opened and flushed after it.
 */
export async function publishFileAtomically(path: string, payload: Uint8Array): Promise<void> {
  const staging = `${path}.staging`;
  try {
    await persistFileDurably(staging, payload);
    await rename(staging, path);
    const published = await open(path, "r+");
    try {
      await published.sync();
    } finally {
      await published.close();
    }
    await persistDirectoryDurably(dirname(path));
  } finally {
    await rm(staging, { force: true });
  }
}

/** Re-read from the filesystem and compare. Nothing is trusted from cache. */
export async function readBackMatches(path: string, expectedDigest: string): Promise<boolean> {
  let observed: Buffer;
  try {
    observed = await readFile(path);
  } catch {
    return false;
  }
  return digestBytes(observed) === expectedDigest;
}

/**
 * Absent means null; any OTHER failure propagates to the caller. Collapsing an
 * I/O fault into "no file" would let a transiently unreadable anchor read as
 * "no anchor exists" — and an install prepared on that answer targets the LIVE
 * slot. Only the caller knows which refusal an unreadable file maps to.
 */
export async function readFileIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Verification-side read: absence and an I/O fault both answer null, because
 * the caller maps null to a refusal either way — a slot that cannot be read
 * back is unproven, never verified. This is NOT for the anchor file, where
 * absent and unreadable mean different things.
 */
export async function readFileIfReadable(path: string): Promise<Buffer | null> {
  try {
    return await readFileIfPresent(path);
  } catch {
    return null;
  }
}

/** Remove a slot's contents wholesale before it is rebuilt. */
export async function clearDirectory(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
  await mkdir(path, { recursive: true });
}

/** Remove a slot outright, leaving no empty directory behind to look staged. */
export async function removeDirectory(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

export function slotPath(root: string, slotsDirName: string, slot: string): string {
  return join(root, slotsDirName, slot);
}
