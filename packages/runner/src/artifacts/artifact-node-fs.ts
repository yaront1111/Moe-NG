import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  MAX_ARTIFACT_ENUMERATION_ENTRIES,
  type ArtifactDirectoryEntry,
  type ArtifactDirectoryEntryKind,
  type ArtifactFsPort,
} from "./artifact-contract.js";

/**
 * Makes a rename durable.
 *
 * On POSIX the rename is parent-directory metadata, so the directory itself is
 * the thing that must be flushed. Node cannot open a directory for fsync on
 * win32, so there the final path is reopened and flushed instead. Either way
 * this is the boundary the store treats as "persisted".
 */
function persistAfterRename(path: string): void {
  const target = process.platform === "win32" ? path : dirname(path);
  const mode = process.platform === "win32" ? "r+" : "r";
  const fd = openSync(target, mode);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    // A short write is legal; looping is what makes the digest of the temp
    // equal the digest the caller staged.
    offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
  }
}

function entryKind(entry: { isFile(): boolean; isDirectory(): boolean }): ArtifactDirectoryEntryKind {
  if (entry.isFile()) return "FILE";
  if (entry.isDirectory()) return "DIRECTORY";
  return "OTHER";
}

/**
 * Reads a directory incrementally through a handle rather than slurping it.
 *
 * `readdirSync` allocates the whole listing before anyone can bound it, so a
 * directory with millions of entries would be materialised in full before the
 * ceiling could reject it. The handle stops at N+1 and the `finally` closes it
 * on the normal path, the overflow path and the error path alike — an unclosed
 * directory handle on win32 keeps the directory locked against later renames.
 *
 * Only the basename and a coarse kind escape: no raw path and no OS error text.
 * Symlinks report OTHER rather than being followed, so the store can refuse
 * them explicitly instead of reading through them.
 */
function listDirectory(path: string): readonly ArtifactDirectoryEntry[] {
  const entries: ArtifactDirectoryEntry[] = [];
  const handle = opendirSync(path);
  try {
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      if (entries.length === MAX_ARTIFACT_ENUMERATION_ENTRIES) {
        entries.push(Object.freeze({ name: entry.name, kind: entryKind(entry) }));
        break;
      }
      entries.push(Object.freeze({ name: entry.name, kind: entryKind(entry) }));
    }
  } finally {
    handle.closeSync();
  }
  return Object.freeze(entries);
}

/**
 * Default adapter over node:fs. `wx` is deliberate: a temp-name collision must
 * fail rather than clobber another attempt's in-flight bytes.
 */
export function createNodeArtifactFs(): ArtifactFsPort {
  return Object.freeze({
    openWrite(path: string): number {
      mkdirSync(dirname(path), { recursive: true });
      return openSync(path, "wx");
    },
    write: writeAll,
    fsync(fd: number): void {
      fsyncSync(fd);
    },
    close(fd: number): void {
      closeSync(fd);
    },
    exists(path: string): boolean {
      return existsSync(path);
    },
    rename(from: string, to: string): void {
      renameSync(from, to);
    },
    persistAfterRename,
    readAll(path: string): Uint8Array {
      return new Uint8Array(readFileSync(path));
    },
    unlink(path: string): void {
      unlinkSync(path);
    },
    listDirectory,
  });
}
