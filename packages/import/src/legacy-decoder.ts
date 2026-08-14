import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isPlainRecord, sha256Hex } from "./canonical-bytes.js";
import type { LegacySourceRecord } from "./import-canonical.js";
import { refuseImport } from "./import-contract.js";
import type { ImportRefusalCode, ImportRefused } from "./import-contract.js";
import { escapesSkillDirectory } from "./import-skill-assets.js";
import type { SourceFileEntry, SourceManifest } from "./source-manifest.js";

/**
 * The production decoder: manifest-covered bytes to frozen `LegacySourceRecord` values.
 *
 * THE READ SET IS THE MANIFEST, and nothing else. This module holds no `readdir`, no
 * glob and no path arithmetic beyond joining the root to an entry the manifest already
 * hashed, so a file that appeared after `buildSourceManifest` ran cannot enter the import.
 * Widening that would be invisible — the extra records would look like ordinary data.
 *
 * NOTHING IS DERIVED FROM THE PATH EXCEPT WHICH DECODER APPLIES. The record's payload,
 * identity and declared time are parsed out of the bytes or the file refuses; the legacy
 * layout's directory family only selects the shape to apply, exactly as a file extension
 * selects a parser. A payload field invented from the path is the defect this module
 * exists to remove.
 *
 * There is no clock and no random source here, in keeping with the rest of the package:
 * `declaredTime` is whatever the SOURCE declared, or null.
 */

/** Bumped when the decoded record shape or the supported-family set changes. */
export const LEGACY_DECODER_VERSION = "moe-legacy-decoder/1" as const;

/**
 * The legacy directory families this version decodes, and the record kind each produces.
 *
 * A family absent here is UNSUPPORTED rather than skipped: silently skipping would make
 * two trees with different reachable content import identically.
 */
export const SUPPORTED_SOURCE_FAMILIES = Object.freeze({
  skills: "skill",
  tasks: "task",
} as const);

export type SupportedSourceFamily = keyof typeof SUPPORTED_SOURCE_FAMILIES;

/**
 * Keys that describe the RECORD rather than the domain fact, and so never reach the
 * payload. `id` is the older legacy dialect of `legacyId`; both are read, and a document
 * carrying two disagreeing identities is ambiguous rather than resolved by precedence.
 */
export const RECORD_ENVELOPE_KEYS = Object.freeze(["id", "legacyId", "time"] as const);

export interface DecodeRefusal {
  readonly refusal: ImportRefused;
  /** The manifest path that refused, so a caller can count refusals per file. */
  readonly sourcePath: string;
}

export interface DecodeReport {
  readonly records: readonly LegacySourceRecord[];
  readonly refusals: readonly DecodeRefusal[];
  readonly version: typeof LEGACY_DECODER_VERSION;
}

export interface DecodeLegacySourcesInput {
  readonly manifest: SourceManifest;
  /** The frozen copy the manifest was built from. Only manifest entries are read. */
  readonly root: string;
}

function refusal(sourcePath: string, refused: ImportRefused): DecodeRefusal {
  return Object.freeze({ refusal: refused, sourcePath });
}

function decodeRefusal(
  sourcePath: string,
  code: ImportRefusalCode,
  detail: string,
): DecodeRefusal {
  return refusal(sourcePath, refuseImport(code, "DECODE", detail));
}

/** The family is the first path segment; a nested file belongs to its top-level family. */
function familyOf(path: string): SupportedSourceFamily | null {
  const [head] = path.split("/");
  if (head === undefined) return null;
  return head in SUPPORTED_SOURCE_FAMILIES ? (head as SupportedSourceFamily) : null;
}

/**
 * Reads one manifest entry and re-hashes it BEFORE anything parses it.
 *
 * The digest check is not belt-and-braces: provenance binds every record to the manifest
 * entry's digest, so decoding bytes that no longer match that digest would attach real
 * provenance to content the manifest never covered.
 */
function readVerified(
  root: string,
  entry: SourceFileEntry,
): DecodeRefusal | Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(join(root, ...entry.path.split("/")));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return decodeRefusal(entry.path, "IMPORT_SOURCE_UNREADABLE", detail);
  }
  const digest = sha256Hex(bytes);
  if (digest !== entry.digest) {
    return decodeRefusal(
      entry.path,
      "IMPORT_SOURCE_DIGEST_MISMATCH",
      `${entry.path} hashes ${digest}; the manifest hashed ${entry.digest}`,
    );
  }
  return bytes;
}

/** The declared identity, or a refusal when it is absent, mistyped, or contradictory. */
function readIdentity(path: string, document: Record<string, unknown>): DecodeRefusal | string {
  const legacyId = document["legacyId"];
  const older = document["id"];
  for (const [key, value] of [["id", older], ["legacyId", legacyId]] as const) {
    if (value !== undefined && typeof value !== "string") {
      return decodeRefusal(path, "IMPORT_SOURCE_MALFORMED", `${key} is not a string`);
    }
  }
  if (typeof legacyId === "string" && typeof older === "string" && legacyId !== older) {
    return decodeRefusal(
      path,
      "IMPORT_SOURCE_AMBIGUOUS",
      `declares legacyId ${legacyId} and id ${older}; the bytes admit two identities`,
    );
  }
  const declared = typeof legacyId === "string" ? legacyId : older;
  if (typeof declared !== "string" || declared === "") {
    return decodeRefusal(path, "IMPORT_SOURCE_MALFORMED", "declares no legacyId");
  }
  return declared;
}

/** The source's own time, or null when it declared none. Never a clock read. */
function readDeclaredTime(path: string, document: Record<string, unknown>): DecodeRefusal | string | null {
  const declared = document["time"];
  if (declared === undefined || declared === null) return null;
  if (typeof declared !== "string") {
    return decodeRefusal(path, "IMPORT_SOURCE_MALFORMED", "time is neither a string nor null");
  }
  return declared;
}

/**
 * Everything the envelope does not claim, in the bytes' own key order.
 *
 * BUILT WITH `Object.fromEntries`, NOT `payload[key] = value`. `JSON.parse` gives
 * `__proto__` an OWN property, but assigning to `payload["__proto__"]` hits the inherited
 * setter: the field vanishes with no refusal AND the payload's prototype is replaced,
 * which then fails `isPlainRecord` and reports CORRUPT_BYTES for a reason nobody can see.
 */
function readPayload(document: Record<string, unknown>): Record<string, unknown> {
  const envelope: readonly string[] = RECORD_ENVELOPE_KEYS;
  return Object.freeze(Object.fromEntries(
    Object.keys(document)
      .filter((key) => !envelope.includes(key))
      .map((key) => [key, document[key]] as const),
  ));
}

function parseDocument(path: string, bytes: Uint8Array): DecodeRefusal | Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return decodeRefusal(path, "IMPORT_SOURCE_MALFORMED", `is not JSON: ${detail}`);
  }
  if (!isPlainRecord(parsed)) {
    return decodeRefusal(path, "IMPORT_SOURCE_MALFORMED", "is not a JSON record");
  }
  return parsed;
}

function isRefusal(value: unknown): value is DecodeRefusal {
  return typeof value === "object" && value !== null && "refusal" in value;
}

/**
 * Decodes one manifest entry into a record, or into the exact reason it could not be one.
 *
 * A file yields a record or a refusal, never both and never a partial record: every
 * failure arm returns before the record is constructed.
 */
function decodeEntry(root: string, entry: SourceFileEntry): DecodeRefusal | LegacySourceRecord {
  // The manifest is a PARAMETER, so its entry paths are only as trustworthy as the caller.
  // `buildSourceManifest` never emits one of these, but a hand-built manifest carrying an
  // absolute path, a drive letter or a `..` segment would otherwise make `join` read bytes
  // outside the frozen tree with full provenance. Same reasoning, and the same segment-wise
  // test, as the symlink refusal in source-manifest.ts.
  if (escapesSkillDirectory(entry.path)) {
    return decodeRefusal(
      entry.path,
      "IMPORT_SOURCE_UNREADABLE",
      "manifest entry leaves the frozen tree; reading it would cover bytes the manifest did not",
    );
  }
  const family = familyOf(entry.path);
  if (family === null || !entry.path.endsWith(".json")) {
    return decodeRefusal(
      entry.path,
      "IMPORT_SOURCE_UNSUPPORTED",
      `${LEGACY_DECODER_VERSION} decodes .json under ${Object.keys(SUPPORTED_SOURCE_FAMILIES).join(", ")}`,
    );
  }
  const bytes = readVerified(root, entry);
  if (isRefusal(bytes)) return bytes;
  const document = parseDocument(entry.path, bytes);
  if (isRefusal(document)) return document;
  const legacyId = readIdentity(entry.path, document);
  if (isRefusal(legacyId)) return legacyId;
  const declaredTime = readDeclaredTime(entry.path, document);
  if (isRefusal(declaredTime)) return declaredTime;
  return Object.freeze({
    declaredTime,
    kind: SUPPORTED_SOURCE_FAMILIES[family],
    legacyId,
    payload: readPayload(document),
    sourcePath: entry.path,
  });
}

/**
 * Decodes every manifest entry, in the manifest's own canonical order.
 *
 * Total by construction: a bad file becomes a typed refusal rather than a throw, so one
 * unreadable legacy file cannot hide how much of the project was importable.
 */
export function decodeLegacySources(input: DecodeLegacySourcesInput): DecodeReport {
  const records: LegacySourceRecord[] = [];
  const refusals: DecodeRefusal[] = [];
  for (const entry of input.manifest.entries) {
    const decoded = decodeEntry(input.root, entry);
    if (isRefusal(decoded)) refusals.push(decoded);
    else records.push(decoded);
  }
  return Object.freeze({
    records: Object.freeze(records),
    refusals: Object.freeze(refusals),
    version: LEGACY_DECODER_VERSION,
  });
}
