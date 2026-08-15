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

import { RECOVERY_ANCHOR_LAYER } from "./recovery-anchor-contracts.js";

/** win32 has no POSIX directory-fsync; claiming it would be a false guarantee. */
const DIRECTORY_FSYNC_SUPPORTED = process.platform !== "win32";

export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The slice of a Node `FileHandle` this module actually needs. Declaring it
 * gives the write path a substitutable seam, which is the only reproducible way
 * to exercise a SHORT write: a real device short-writes when it feels like it.
 */
export interface DurableWriteHandle {
  close(): Promise<void>;
  sync(): Promise<void>;
  write(
    data: Uint8Array,
    offset: number,
    length: number,
  ): Promise<{ readonly bytesWritten: number }>;
}

/** Opens `path` truncating for write. Internal: never published on the root. */
export type DurableWriteOpener = (path: string) => Promise<DurableWriteHandle>;

const openForTruncatingWrite: DurableWriteOpener = (path) => open(path, "w");

/**
 * The write path THROWS rather than returning a refusal object: every primitive
 * here is `Promise<void>` or `Promise<T | null>`, and no caller catches a write
 * fault (`installRecoveryAnchor` returns `runInstall` uncaught), so the stable
 * code and layer have to ride on the failure itself to reach anyone at all.
 */
export class RecoveryAnchorWriteIncompleteError extends Error {
  public readonly code = "RECOVERY_ANCHOR_WRITE_INCOMPLETE" as const;
  public readonly layer = RECOVERY_ANCHOR_LAYER;

  public constructor(written: number, expected: number) {
    super(
      `RECOVERY_ANCHOR_WRITE_INCOMPLETE: proved ${String(written)} of ${String(expected)} bytes written.`,
    );
    this.name = "RecoveryAnchorWriteIncompleteError";
  }
}

/**
 * `FileHandle.write` may write FEWER bytes than requested — a legitimate POSIX
 * outcome, not a fault — so the remainder is retried from the offset already
 * proven written. Retrying only ever ADVANCES: a chunk that reports no progress,
 * a non-integer count, or more bytes than were offered refuses instead, so the
 * loop runs at most `payload.byteLength` times and can never spin.
 */
async function writeWholePayload(handle: DurableWriteHandle, payload: Uint8Array): Promise<void> {
  const expected = payload.byteLength;
  let written = 0;
  while (written < expected) {
    const remaining = expected - written;
    const { bytesWritten } = await handle.write(payload, written, remaining);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
      throw new RecoveryAnchorWriteIncompleteError(written, expected);
    }
    written += bytesWritten;
  }
}

/**
 * Write EVERY byte, flush to the device, then close. A write that was never
 * flushed is not evidence — and neither is one that was never finished, which
 * is why the flush happens only once the whole payload is proven written.
 */
export async function persistFileDurably(
  path: string,
  payload: Uint8Array,
  openHandle: DurableWriteOpener = openForTruncatingWrite,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await openHandle(path);
  try {
    await writeWholePayload(handle, payload);
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
export async function publishFileAtomically(
  path: string,
  payload: Uint8Array,
  openHandle: DurableWriteOpener = openForTruncatingWrite,
): Promise<void> {
  const staging = `${path}.staging`;
  try {
    await persistFileDurably(staging, payload, openHandle);
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
