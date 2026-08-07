import { readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

import {
  canonicalDigest,
  deepFreeze,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_TOTAL_BYTES,
  sha256Hex,
  skillFailure,
} from "./skill-contract.js";
import type { SkillFailure, SkillOrigin } from "./skill-contract.js";
import type { SkillManifest } from "./skill-manifest.js";

/**
 * Minimal filesystem surface the loader needs. Injectable so containment logic
 * is unit-testable without Developer-Mode symlink permissions on Windows.
 */
export interface SkillFsFacade {
  readonly realpathSync: (target: string) => string;
  readonly readFileSync: (target: string) => Uint8Array;
}

const NODE_FS: SkillFsFacade = Object.freeze({
  realpathSync: (target: string): string => realpathSync.native(target),
  readFileSync: (target: string): Uint8Array => readFileSync(target),
});

export interface LoadedSkillFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly contentBase64: string;
}

export interface LoadedSkillBundle {
  readonly skillId: string;
  readonly version: string;
  readonly origin: SkillOrigin;
  readonly bundleDigest: string;
  readonly files: readonly LoadedSkillFile[];
}

export interface LoadedSkillBundleOk {
  readonly ok: true;
  readonly bundle: LoadedSkillBundle;
}

export type LoadSkillBundleResult = LoadedSkillBundleOk | SkillFailure;

/**
 * Containment predicate. The trailing separator is mandatory: a bare prefix
 * test would accept a sibling directory such as `/x/skills-evil` against the
 * root `/x/skills`.
 */
function isContained(realFile: string, realRoot: string): boolean {
  return realFile.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`);
}

/** Any realpath failure — absent, device, revoked link — is one closed outcome. */
function resolveReal(fs: SkillFsFacade, target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function loadOneFile(
  fs: SkillFsFacade,
  realRoot: string,
  declared: SkillManifest["files"][number],
): LoadedSkillFile | SkillFailure {
  const realFile = resolveReal(fs, join(realRoot, declared.path));
  if (realFile === null) {
    return skillFailure("SKILL_FILE_MISSING", `skill file ${JSON.stringify(declared.path)} is unreadable`);
  }
  if (!isContained(realFile, realRoot)) {
    return skillFailure(
      "SKILL_SYMLINK_ESCAPE",
      `skill file ${JSON.stringify(declared.path)} resolves outside the bundle root`,
    );
  }
  let content: Uint8Array;
  try {
    content = fs.readFileSync(realFile);
  } catch {
    return skillFailure("SKILL_FILE_MISSING", `skill file ${JSON.stringify(declared.path)} is unreadable`);
  }
  // Every check below runs against the bytes just read, never a re-stat or
  // re-read, so there is no window in which the file can change underneath us.
  if (content.byteLength > MAX_SKILL_FILE_BYTES || content.byteLength !== declared.byteLength) {
    return skillFailure(
      "SKILL_FILE_OVERSIZED",
      `skill file ${JSON.stringify(declared.path)} is ${content.byteLength} bytes, expected ${declared.byteLength}`,
    );
  }
  const actualDigest = sha256Hex(content);
  if (actualDigest !== declared.sha256) {
    return skillFailure(
      "SKILL_DIGEST_MISMATCH",
      `skill file ${JSON.stringify(declared.path)} does not match its declared digest`,
    );
  }
  return {
    path: declared.path,
    sha256: actualDigest,
    byteLength: content.byteLength,
    contentBase64: Buffer.from(content).toString("base64"),
  };
}

function isFailure(value: unknown): value is SkillFailure {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

/**
 * Reads exactly the files a validated manifest declares and returns a frozen,
 * content-addressed bundle.
 *
 * Read-only: this function never writes, creates, or removes anything. Every
 * failure is a stable SKILL_* code; nothing throws for hostile input.
 */
export function loadSkillBundle(
  bundleRoot: string,
  manifest: SkillManifest,
  fs: SkillFsFacade = NODE_FS,
): LoadSkillBundleResult {
  const realRoot = resolveReal(fs, bundleRoot);
  if (realRoot === null) {
    return skillFailure("SKILL_FILE_MISSING", "skill bundle root is unreadable");
  }
  const files: LoadedSkillFile[] = [];
  let totalBytes = 0;
  for (const declared of manifest.files) {
    const loaded = loadOneFile(fs, realRoot, declared);
    if (isFailure(loaded)) {
      return loaded;
    }
    totalBytes += loaded.byteLength;
    if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
      return skillFailure("SKILL_FILE_OVERSIZED", `bundle exceeds ${MAX_SKILL_TOTAL_BYTES} bytes`);
    }
    files.push(loaded);
  }
  const identity = {
    skillId: manifest.skillId,
    version: manifest.version,
    origin: manifest.origin,
    files: files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      byteLength: file.byteLength,
    })),
  };
  return deepFreeze({
    ok: true as const,
    bundle: {
      skillId: manifest.skillId,
      version: manifest.version,
      origin: manifest.origin,
      bundleDigest: canonicalDigest(identity),
      files,
    },
  });
}
