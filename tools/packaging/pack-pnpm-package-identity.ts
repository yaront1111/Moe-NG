import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";

import {
  PACK_STEP_FAILED, capturePackFileIdentity, normalizedTreeSha256,
  pathInside, sameCanonicalPath,
  type PackFileIdentity, type PackTreeEntry, type PackTreeIdentity,
} from "./pack-tool-identity.js";

const SCHEMA = "moe-pnpm-package-shim/1";
const TOKEN = Buffer.from("<PNPM_ACTION_DESTINATION>", "utf8");
const SHIM_ROOT = "node_modules/.bin";
const SHIMS = Object.freeze([
  `${SHIM_ROOT}/pn`, `${SHIM_ROOT}/pn.CMD`,
  `${SHIM_ROOT}/pnpm`, `${SHIM_ROOT}/pnpm.CMD`,
  `${SHIM_ROOT}/pnpx`, `${SHIM_ROOT}/pnpx.CMD`,
  `${SHIM_ROOT}/pnx`, `${SHIM_ROOT}/pnx.CMD`,
]);
const FOREIGN_ABSOLUTE = /(?:[A-Za-z]:[\\/]|\/mnt\/[A-Za-z]\/|\\\\(?:[?.]\\|[^\\\s"',;()]+\\[^\\\s"',;()]+)|(?:^|[="' ;:(\[])\/(?!bin\/sh|node_modules\/)(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]*)/mu;
const decoder = new TextDecoder("utf-8", { fatal: true });

interface DestinationForms {
  readonly native: string;
  readonly shell: string;
}

export interface PnpmPackageIdentityAuthority {
  readonly actionDestination: string;
  readonly pnpmVersion: string;
}

function unavailable(): never {
  throw new Error(`${PACK_STEP_FAILED}: pnpm package identity unavailable`);
}

function exactRootDestination(
  root: string, authority: PnpmPackageIdentityAuthority,
): string {
  if (authority === null || typeof authority !== "object"
    || typeof authority.actionDestination !== "string"
    || typeof authority.pnpmVersion !== "string"
    || !/^\d+\.\d+\.\d+$/u.test(authority.pnpmVersion)
    || !isAbsolute(authority.actionDestination)
    || !sameCanonicalPath(realpathSync(authority.actionDestination), authority.actionDestination)) {
    return unavailable();
  }
  if (!isAbsolute(root) || !sameCanonicalPath(realpathSync(root), root)) unavailable();
  let cursor = root;
  for (const expected of ["pnpm", "node_modules"] as const) {
    if (basename(cursor) !== expected) unavailable();
    cursor = dirname(cursor);
  }
  if (basename(cursor) !== `pnpm@${authority.pnpmVersion}`) unavailable();
  cursor = dirname(cursor);
  for (const expected of [".pnpm", "node_modules"] as const) {
    if (basename(cursor) !== expected) unavailable();
    cursor = dirname(cursor);
  }
  if (!isAbsolute(cursor) || cursor === root
    || !sameCanonicalPath(cursor, authority.actionDestination)) unavailable();
  return cursor;
}

function destinationForms(destination: string): DestinationForms {
  const drive = /^([A-Za-z]):[\\/](.*)$/u.exec(destination);
  if (drive !== null && drive[1] !== undefined && drive[2] !== undefined) {
    return Object.freeze({
      native: `${drive[1].toUpperCase()}:\\${drive[2].replaceAll("/", "\\")}`,
      shell: `/mnt/${drive[1].toLowerCase()}/${drive[2].replaceAll("\\", "/")}`,
    });
  }
  const mounted = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/u.exec(destination);
  if (mounted !== null && mounted[1] !== undefined) {
    const tail = mounted[2] ?? "";
    return Object.freeze({
      native: `${mounted[1].toUpperCase()}:\\${tail.replaceAll("/", "\\")}`,
      shell: `/mnt/${mounted[1].toLowerCase()}${tail === "" ? "" : `/${tail}`}`,
    });
  }
  // The release authority is Windows-only, but its node:test contract also runs on POSIX hosts.
  // Preserve the same exact-root projection there without teaching Windows to accept POSIX roots.
  if (process.platform !== "win32" && destination.startsWith("/")) {
    return Object.freeze({ native: destination, shell: destination });
  }
  return unavailable();
}

function candidateEntries(tree: PackTreeIdentity): readonly PackTreeEntry[] {
  if (tree.entries.length === 0) unavailable();
  const unique = new Set(tree.entries.map((entry) => entry.path));
  if (unique.size !== tree.entries.length) unavailable();
  const below = tree.entries.filter((entry) =>
    entry.path === SHIM_ROOT || entry.path.startsWith(`${SHIM_ROOT}/`));
  const root = below.filter((entry) => entry.path === SHIM_ROOT);
  const files = below.filter((entry) => entry.kind === "file");
  if (root.length !== 1 || root[0]?.kind !== "directory" || below.length !== SHIMS.length + 1
    || files.length !== SHIMS.length) unavailable();
  const byPath = new Map(files.map((entry) => [entry.path, entry]));
  if (byPath.size !== SHIMS.length || SHIMS.some((path) => !byPath.has(path))) unavailable();
  return SHIMS.map((path) => byPath.get(path) ?? unavailable());
}

function sameFile(entry: PackTreeEntry, identity: PackFileIdentity, absolute: string): boolean {
  return sameCanonicalPath(identity.path, absolute)
    && identity.dev === entry.dev && identity.ino === entry.ino
    && identity.mode === entry.mode && identity.nlink === entry.nlink
    && identity.size === entry.size && identity.sha256 === entry.sha256;
}

function securelyRead(tree: PackTreeIdentity, entry: PackTreeEntry): Buffer {
  const absolute = join(tree.root, ...entry.path.split("/"));
  if (!pathInside(tree.root, absolute) || entry.kind !== "file") unavailable();
  const before = capturePackFileIdentity(absolute, false, true);
  if (!sameFile(entry, before, absolute)) unavailable();
  const bytes = readFileSync(absolute);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== entry.size || sha256 !== entry.sha256) unavailable();
  const after = capturePackFileIdentity(absolute, false, true);
  if (!sameFile(entry, after, absolute)) unavailable();
  return bytes;
}

function splitCandidate(
  tree: PackTreeIdentity, entry: PackTreeEntry, forms: DestinationForms,
): readonly Buffer[] {
  const bytes = securelyRead(tree, entry);
  const text = decoder.decode(bytes);
  if (!Buffer.from(text, "utf8").equals(bytes)) unavailable();
  const expected = entry.path.endsWith(".CMD") ? forms.native : forms.shell;
  const alternate = entry.path.endsWith(".CMD") ? forms.shell : forms.native;
  if (expected.length === 0 || (alternate !== expected && text.includes(alternate))) unavailable();
  const segments = text.split(expected);
  if (segments.length !== 9 || segments.some((segment) => FOREIGN_ABSOLUTE.test(segment))) {
    unavailable();
  }
  return Object.freeze(segments.map((segment) => Buffer.from(segment, "utf8")));
}

function frame(hash: ReturnType<typeof createHash>, label: string, bytes: Buffer): void {
  const labelBytes = Buffer.from(label, "utf8");
  const size = Buffer.allocUnsafe(8);
  size.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(Buffer.from([labelBytes.length]));
  hash.update(labelBytes);
  hash.update(size);
  hash.update(bytes);
}

function projectedEntry(entry: PackTreeEntry, segments: readonly Buffer[]): PackTreeEntry {
  const hash = createHash("sha256");
  frame(hash, "schema", Buffer.from(SCHEMA, "utf8"));
  frame(hash, "path", Buffer.from(entry.path, "utf8"));
  let size = TOKEN.length * (segments.length - 1);
  segments.forEach((segment, index) => {
    frame(hash, `segment-${index}`, segment);
    if (index < segments.length - 1) frame(hash, `destination-${index}`, TOKEN);
    size += segment.length;
  });
  return Object.freeze({ ...entry, sha256: hash.digest("hex"), size });
}

/** Portable digest for the exact copy-mode pnpm/action-setup package tree. */
export function normalizedPnpmPackageTreeSha256(
  tree: PackTreeIdentity, authority: PnpmPackageIdentityAuthority,
): string {
  try {
    const forms = destinationForms(exactRootDestination(tree.root, authority));
    const candidates = candidateEntries(tree);
    const projected = new Map(candidates.map((entry) => [
      entry.path, projectedEntry(entry, splitCandidate(tree, entry, forms)),
    ]));
    if (projected.size !== SHIMS.length) unavailable();
    return normalizedTreeSha256(Object.freeze({
      entries: Object.freeze(tree.entries.map((entry) => projected.get(entry.path) ?? entry)),
      root: tree.root,
    }));
  } catch {
    return unavailable();
  }
}
