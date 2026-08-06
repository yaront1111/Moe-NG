import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import {
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

import { PHASE0_MAX_DOCUMENT_BYTES } from "@moe/contracts";

import { identifyEvidence, snapshotEvidenceBytes } from "./evidence-digest.js";
import { equalBytes } from "./phase0-freeze-codec.js";

const OBJECT_PATH_PATTERN = /^objects\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/;

export function nodePortError(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function statsEqual(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function canonicalConfiguredRoot(root: string, label: string): string {
  if (typeof root !== "string" || root.length === 0 || !isAbsolute(root) || root.includes("\0")) {
    return nodePortError(`PHASE0_NODE_${label}_REPOSITORY_INVALID`, root);
  }
  return resolve(root);
}

export function requireConfiguredRoot(
  supplied: string,
  expected: string,
  label: "SOURCE" | "TARGET",
): void {
  const exact = typeof supplied === "string" && (
    process.platform === "win32"
      ? supplied.toLowerCase() === expected.toLowerCase()
      : supplied === expected
  );
  if (
    typeof supplied !== "string" ||
    supplied.includes("\0") ||
    !isAbsolute(supplied) ||
    !exact
  ) {
    nodePortError(`PHASE0_NODE_${label}_REPOSITORY_MISMATCH`, String(supplied));
  }
}

export function validateRelativeSourcePath(relativePath: string): readonly string[] {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    relativePath.includes(":") ||
    relativePath.startsWith("/")
  ) {
    return nodePortError("PHASE0_NODE_RELATIVE_PATH_INVALID", String(relativePath));
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return nodePortError("PHASE0_NODE_RELATIVE_PATH_INVALID", relativePath);
  }
  return segments;
}

export function validateObjectPath(objectPath: string): { readonly digest: string; readonly parts: readonly string[] } {
  if (typeof objectPath !== "string" || objectPath.includes("\0")) {
    return nodePortError("PHASE0_NODE_OBJECT_PATH_INVALID", String(objectPath));
  }
  const match = OBJECT_PATH_PATTERN.exec(objectPath);
  if (match === null || match[1] !== match[2]!.slice(0, 2)) {
    return nodePortError("PHASE0_NODE_OBJECT_PATH_INVALID", objectPath);
  }
  return Object.freeze({ digest: match[2]!, parts: Object.freeze(objectPath.split("/")) });
}

export async function requireStableRoot(root: string, label: "SOURCE" | "TARGET"): Promise<void> {
  const stat = await lstat(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    nodePortError(`PHASE0_NODE_${label}_PATH_ESCAPE`, root);
  }
  const resolved = await realpath(root);
  if (!samePath(resolved, root)) {
    nodePortError(`PHASE0_NODE_${label}_PATH_ESCAPE`, root);
  }
}

async function requireSafeDirectory(path: string, escapeCode: string): Promise<void> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    nodePortError(escapeCode, path);
  }
  const resolved = await realpath(path);
  if (!samePath(resolved, path)) {
    nodePortError(escapeCode, path);
  }
}

async function createSafeDirectoryChain(
  root: string,
  segments: readonly string[],
  escapeCode: string,
): Promise<string> {
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    await requireSafeDirectory(current, escapeCode);
    const next = containedPath(root, segments.slice(0, index + 1), escapeCode);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    await requireSafeDirectory(next, escapeCode);
    current = next;
  }
  return current;
}

export function containedPath(root: string, parts: readonly string[], code: string): string {
  const candidate = resolve(root, ...parts);
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return nodePortError(code, candidate);
  }
  return candidate;
}

export async function readStableRegularFile(path: string, escapeCode: string): Promise<Uint8Array> {
  const lexicalBefore = await lstat(path, { bigint: true });
  if (!lexicalBefore.isFile() || lexicalBefore.isSymbolicLink()) {
    return nodePortError(escapeCode, path);
  }
  if (lexicalBefore.size > BigInt(PHASE0_MAX_DOCUMENT_BYTES)) {
    return nodePortError("PHASE0_NODE_FILE_LIMIT_EXCEEDED", path);
  }
  const resolvedBefore = await realpath(path);
  if (!samePath(resolvedBefore, path)) {
    return nodePortError(escapeCode, path);
  }

  const handle = await open(path, "r");
  try {
    const handleBefore = await handle.stat({ bigint: true });
    if (!handleBefore.isFile() || !statsEqual(lexicalBefore, handleBefore)) {
      return nodePortError(`${escapeCode}_UNSTABLE`, path);
    }
    if (handleBefore.size > BigInt(PHASE0_MAX_DOCUMENT_BYTES)) {
      return nodePortError("PHASE0_NODE_FILE_LIMIT_EXCEEDED", path);
    }
    const expectedSize = Number(handleBefore.size);
    const bounded = new Uint8Array(expectedSize + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.byteLength) {
      const read = await handle.read(
        bounded,
        bytesRead,
        bounded.byteLength - bytesRead,
        bytesRead,
      );
      if (read.bytesRead === 0) {
        break;
      }
      bytesRead += read.bytesRead;
    }
    const bytes = bounded.slice(0, bytesRead);
    const handleAfter = await handle.stat({ bigint: true });
    const lexicalAfter = await lstat(path, { bigint: true });
    const resolvedAfter = await realpath(path);
    if (
      !statsEqual(handleBefore, handleAfter) ||
      !statsEqual(handleAfter, lexicalAfter) ||
      !samePath(resolvedBefore, resolvedAfter) ||
      bytesRead > expectedSize ||
      BigInt(bytes.byteLength) !== handleAfter.size
    ) {
      return nodePortError(`${escapeCode}_UNSTABLE`, path);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function writeContentAddressedObject(
  targetRoot: string,
  objectPath: string,
  input: Uint8Array,
): Promise<void> {
  const validated = validateObjectPath(objectPath);
  let bytes: Uint8Array;
  try {
    bytes = snapshotEvidenceBytes(input, PHASE0_MAX_DOCUMENT_BYTES);
  } catch {
    return nodePortError("PHASE0_NODE_FILE_LIMIT_EXCEEDED", objectPath);
  }
  if (identifyEvidence(bytes).digest !== validated.digest) {
    nodePortError("PHASE0_NODE_OBJECT_DIGEST_MISMATCH", objectPath);
  }
  await requireStableRoot(targetRoot, "TARGET");
  const finalPath = containedPath(
    targetRoot,
    validated.parts,
    "PHASE0_NODE_TARGET_PATH_ESCAPE",
  );
  const parentSegments = validated.parts.slice(0, -1);
  const parent = await createSafeDirectoryChain(
    targetRoot,
    parentSegments,
    "PHASE0_NODE_TARGET_PATH_ESCAPE",
  );
  if (!samePath(parent, dirname(finalPath))) {
    nodePortError("PHASE0_NODE_TARGET_PATH_ESCAPE", parent);
  }

  const temporaryPath = resolve(parent, `.phase0-${process.pid}-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await link(temporaryPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  } finally {
    await removeTemporary(temporaryPath);
  }

  const stored = await readStableRegularFile(finalPath, "PHASE0_NODE_TARGET_PATH_ESCAPE");
  if (!equalBytes(stored, bytes)) {
    nodePortError("PHASE0_NODE_OBJECT_COLLISION", objectPath);
  }
}
