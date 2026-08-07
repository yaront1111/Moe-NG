import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { BoundedJsonErrorCode } from "@moe/contracts";

import {
  canonicalDigest,
  canonicalJson,
  deepFreeze,
  hasExactKeys,
  isHex64,
  isNormalizedText,
  isPlainRecord,
  isSafeByteCount,
  isSkillOrigin,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_ID_CHARS,
  MAX_SKILL_PATH_CHARS,
  MAX_SKILL_TOTAL_BYTES,
  SKILL_MANIFEST_VERSION,
  skillFailure,
} from "./skill-contract.js";
import type { SkillFailure, SkillOrigin } from "./skill-contract.js";

const MANIFEST_KEYS = ["manifestVersion", "skillId", "version", "origin", "files"] as const;
const FILE_KEYS = ["path", "sha256", "byteLength"] as const;

const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const RESERVED_DEVICE_STEMS = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** Bounded-json codes collapse into three stable skill outcomes. */
const BOUNDED_CODE_MAP: Readonly<Record<BoundedJsonErrorCode, string>> = Object.freeze({
  JSON_UTF8_INVALID: "SKILL_UNICODE_INVALID",
  JSON_UNICODE_INVALID: "SKILL_UNICODE_INVALID",
  JSON_BODY_LIMIT_EXCEEDED: "SKILL_LIMIT_EXCEEDED",
  JSON_DEPTH_LIMIT_EXCEEDED: "SKILL_LIMIT_EXCEEDED",
  JSON_STRING_LIMIT_EXCEEDED: "SKILL_LIMIT_EXCEEDED",
  JSON_SYNTAX_INVALID: "SKILL_MANIFEST_BYTES_INVALID",
  JSON_DUPLICATE_KEY: "SKILL_MANIFEST_BYTES_INVALID",
  JSON_NUMBER_RANGE_INVALID: "SKILL_MANIFEST_BYTES_INVALID",
  JSON_INPUT_TYPE_INVALID: "SKILL_MANIFEST_BYTES_INVALID",
});

export interface SkillManifestFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface SkillManifest {
  readonly manifestVersion: string;
  readonly skillId: string;
  readonly version: string;
  readonly origin: SkillOrigin;
  readonly files: readonly SkillManifestFile[];
}

export interface ValidatedSkillManifest {
  readonly ok: true;
  readonly manifest: SkillManifest;
  readonly canonicalJson: string;
  readonly identityDigest: string;
}

export type SkillManifestResult = ValidatedSkillManifest | SkillFailure;

/**
 * Rejects any path that Win32 would reinterpret. Every rule here runs before a
 * single filesystem call, so a hostile manifest never reaches the loader.
 */
function pathRejection(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) {
    return "file path must be a non-empty string";
  }
  if (path.length > MAX_SKILL_PATH_CHARS) {
    return `file path exceeds ${MAX_SKILL_PATH_CHARS} characters`;
  }
  if (!isNormalizedText(path)) {
    return "file path must be well-formed NFC text";
  }
  if (path.includes("\\")) return "file path must not contain a backslash";
  if (path.includes(":")) return "file path must not contain a colon";
  if (path.includes("~")) return "file path must not contain a tilde";
  if (path.startsWith("/")) return "file path must be relative";
  for (const segment of path.split("/")) {
    if (segment.length === 0) return "file path must not contain an empty segment";
    if (segment === "." || segment === "..") return "file path must not contain a dot segment";
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      return "file path segment must not end with a dot or space";
    }
    const stem = segment.split(".")[0]!.toLowerCase();
    if (RESERVED_DEVICE_STEMS.has(stem)) {
      return `file path segment ${JSON.stringify(segment)} is a reserved device name`;
    }
  }
  return null;
}

function validateIdentity(record: Record<string, unknown>): SkillFailure | null {
  const { skillId, version, origin } = record;
  if (
    typeof skillId !== "string" ||
    skillId.length === 0 ||
    skillId.length > MAX_SKILL_ID_CHARS ||
    !SKILL_ID_PATTERN.test(skillId)
  ) {
    return skillFailure("SKILL_IDENTITY_INVALID", "skillId must match ^[a-z0-9][a-z0-9-]*$");
  }
  if (typeof version !== "string" || version.length === 0 || !isNormalizedText(version)) {
    return skillFailure("SKILL_IDENTITY_INVALID", "version must be non-empty NFC text");
  }
  if (!isSkillOrigin(origin)) {
    return skillFailure("SKILL_IDENTITY_INVALID", "origin must be authored or legacy-moe-skills");
  }
  return null;
}

/** Returns the validated file list, or the failure that stopped it. */
function validateFiles(value: unknown): readonly SkillManifestFile[] | SkillFailure {
  if (!Array.isArray(value) || value.length === 0) {
    return skillFailure("SKILL_LIMIT_EXCEEDED", "files must be a non-empty array");
  }
  if (value.length > MAX_SKILL_FILES) {
    return skillFailure("SKILL_LIMIT_EXCEEDED", `files exceeds ${MAX_SKILL_FILES} entries`);
  }
  const files: SkillManifestFile[] = [];
  const seenExact = new Set<string>();
  const seenFolded = new Set<string>();
  let totalBytes = 0;
  for (const entry of value) {
    if (!isPlainRecord(entry) || !hasExactKeys(entry, FILE_KEYS)) {
      return skillFailure("SKILL_MANIFEST_SCHEMA_INVALID", "file entry has unexpected keys");
    }
    const rejection = pathRejection(entry.path);
    if (rejection !== null) {
      return skillFailure("SKILL_PATH_INVALID", rejection);
    }
    const path = entry.path as string;
    if (!isHex64(entry.sha256)) {
      return skillFailure("SKILL_IDENTITY_INVALID", "file sha256 must be lowercase 64-hex");
    }
    if (!isSafeByteCount(entry.byteLength) || entry.byteLength > MAX_SKILL_FILE_BYTES) {
      return skillFailure(
        "SKILL_LIMIT_EXCEEDED",
        `file byteLength must be an integer in [0, ${MAX_SKILL_FILE_BYTES}]`,
      );
    }
    if (seenExact.has(path)) {
      return skillFailure("SKILL_IDENTITY_DUPLICATE", `duplicate file path ${JSON.stringify(path)}`);
    }
    const folded = path.toLowerCase();
    if (seenFolded.has(folded)) {
      return skillFailure("SKILL_PATH_AMBIGUOUS", `file path ${JSON.stringify(path)} collides case-insensitively`);
    }
    seenExact.add(path);
    seenFolded.add(folded);
    totalBytes += entry.byteLength;
    if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
      return skillFailure("SKILL_LIMIT_EXCEEDED", `declared bytes exceed ${MAX_SKILL_TOTAL_BYTES}`);
    }
    files.push({ path, sha256: entry.sha256, byteLength: entry.byteLength });
  }
  return files;
}

function isFailure(value: unknown): value is SkillFailure {
  return isPlainRecord(value) && value.ok === false;
}

/**
 * Validates raw manifest bytes into a deep-frozen canonical manifest.
 *
 * Fails closed: every rejection carries a stable SKILL_* code, and no
 * filesystem access happens here.
 */
export function validateSkillManifestBytes(bytes: Uint8Array): SkillManifestResult {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok) {
    const mapped = BOUNDED_CODE_MAP[decoded.code] ?? "SKILL_MANIFEST_BYTES_INVALID";
    return skillFailure(
      mapped as SkillFailure["code"],
      `${decoded.code}: ${decoded.message}`,
    );
  }
  const body = decoded.value;
  if (!isPlainRecord(body)) {
    return skillFailure("SKILL_MANIFEST_SCHEMA_INVALID", "manifest must be a JSON object");
  }
  if (!hasExactKeys(body, MANIFEST_KEYS)) {
    return skillFailure("SKILL_MANIFEST_SCHEMA_INVALID", "manifest has unexpected or missing keys");
  }
  if (body.manifestVersion !== SKILL_MANIFEST_VERSION) {
    return skillFailure(
      "SKILL_MANIFEST_VERSION_UNSUPPORTED",
      `manifestVersion must be ${SKILL_MANIFEST_VERSION}`,
    );
  }
  const identityFailure = validateIdentity(body);
  if (identityFailure !== null) {
    return identityFailure;
  }
  const files = validateFiles(body.files);
  if (isFailure(files)) {
    return files;
  }
  const manifest: SkillManifest = {
    manifestVersion: SKILL_MANIFEST_VERSION,
    skillId: body.skillId as string,
    version: body.version as string,
    origin: body.origin as SkillOrigin,
    files,
  };
  return deepFreeze({
    ok: true as const,
    manifest,
    canonicalJson: canonicalJson(manifest),
    identityDigest: canonicalDigest(manifest),
  });
}
