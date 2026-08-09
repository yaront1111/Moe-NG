import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { byCodeUnit, canonicalDigest, normalizedText, sha256Hex } from "./canonical-bytes.js";
import { SOURCE_MANIFEST_VERSION, refuseImport } from "./import-contract.js";
import type { ImportRefused } from "./import-contract.js";

/**
 * The read-only source manifest (design §21.2): hash every source file and emit a
 * manifest BEFORE anything is imported.
 *
 * This module only ever reads. There is no write call in it, and the suite proves the
 * promise by measuring each file's mtime and size before and after rather than by
 * trusting that claim — a tool that rewrites a file with identical bytes still bumps
 * mtime and violates §21.2.
 *
 * DETERMINISM LIVES HERE. `readdir` order varies by filesystem, platform and inode reuse,
 * so every listing is sorted by an explicit total order before it is hashed. Get this
 * wrong and identical bytes produce different canonical digests on a different machine —
 * a DoD-1 failure that will not reproduce for whoever has to debug it.
 */

export interface SourceFileEntry {
  readonly digest: string;
  readonly path: string;
  readonly size: number;
}

export interface SourceManifest {
  readonly digest: string;
  readonly entries: readonly SourceFileEntry[];
  readonly version: typeof SOURCE_MANIFEST_VERSION;
}

export type SourceManifestResult = ImportRefused | SourceManifest;

/** Relative POSIX path, NFC-normalized, so the manifest never encodes the host's shape. */
function relativePosix(parts: readonly string[]): string {
  return normalizedText(parts.join("/"));
}

function fileEntry(root: string, parts: readonly string[]): SourceFileEntry {
  const path = relativePosix(parts);
  const bytes = readFileSync(join(root, ...parts));
  return Object.freeze({ digest: sha256Hex(bytes), path, size: bytes.byteLength });
}

/**
 * Walks the tree depth-first, sorting each directory listing by name before descending.
 *
 * Sorting the LISTING rather than only the final entry array matters: it makes the walk
 * itself deterministic, so a partial read or an early refusal also stops at the same
 * place on every machine.
 */
function walk(root: string, parts: readonly string[], into: SourceFileEntry[]): void {
  const listing = readdirSync(join(root, ...parts), { withFileTypes: true });
  const names = listing.map((entry) => entry.name).sort(byCodeUnit);
  for (const name of names) {
    const next = [...parts, name];
    // Re-stat rather than trusting the Dirent: a symlink reports as a link, and following
    // it could read bytes from outside the frozen tree.
    const stat = statSync(join(root, ...next), { throwIfNoEntry: false });
    if (stat === undefined) continue;
    if (stat.isDirectory()) {
      walk(root, next, into);
      continue;
    }
    if (stat.isFile()) {
      into.push(fileEntry(root, next));
    }
  }
}

/**
 * Builds the manifest for a frozen source tree.
 *
 * Refuses rather than throwing, so a caller always gets a stable code and the layer that
 * produced it. An empty tree is refused rather than reported as a successful import of
 * nothing — silently importing zero records is exactly the successful-looking failure
 * §21.6's "report exact counts" exists to prevent.
 */
export function buildSourceManifest(root: string): SourceManifestResult {
  const rootStat = statSync(root, { throwIfNoEntry: false });
  if (rootStat === undefined || !rootStat.isDirectory()) {
    return refuseImport("IMPORT_ROOT_INVALID", "INPUT", `source root is not a directory: ${root}`);
  }
  const entries: SourceFileEntry[] = [];
  try {
    walk(root, [], entries);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return refuseImport("IMPORT_SOURCE_UNREADABLE", "MANIFEST", detail);
  }
  if (entries.length === 0) {
    return refuseImport("IMPORT_MANIFEST_EMPTY", "MANIFEST", `no files under ${root}`);
  }
  entries.sort((left, right) => byCodeUnit(left.path, right.path));
  const frozen = Object.freeze(entries);
  return Object.freeze({
    digest: canonicalDigest({ entries: frozen, version: SOURCE_MANIFEST_VERSION }),
    entries: frozen,
    version: SOURCE_MANIFEST_VERSION,
  });
}
