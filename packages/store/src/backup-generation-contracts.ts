/**
 * Closed vocabulary and immutable shapes for a cursor-bound backup generation.
 *
 * Split from backup-generation-manifest.ts to keep each production source under
 * the per-file cap: this file owns WHAT a generation is, the manifest module
 * owns HOW one is canonicalized and verified.
 */

export const BACKUP_GENERATION_MANIFEST_VERSION = "moe-backup-generation/1" as const;

/**
 * A generation is only restorable when every category is represented. The set is
 * frozen and closed: an object naming a category absent from this list is a
 * shape rejection, not a silently ignored entry.
 */
export const BACKUP_OBJECT_CATEGORIES = Object.freeze([
  "ARTIFACT",
  "CONTEXT",
  "KEY_CHAIN",
  "MANIFEST",
  "RECEIPT",
] as const);
export type BackupObjectCategory = (typeof BACKUP_OBJECT_CATEGORIES)[number];

/**
 * Every refusal reason this capability can emit. A reason produced in production
 * but absent here is a defect: the frozen list is what lets a consumer switch
 * exhaustively instead of matching on message text.
 */
export const BACKUP_GENERATION_REASONS = Object.freeze([
  "CATEGORY_INCOMPLETE",
  "CURSOR_AHEAD_OF_DATABASE",
  "CURSOR_BEHIND_DATABASE",
  "DATABASE_DIGEST_MISMATCH",
  "DATABASE_UNREADABLE",
  "DESTINATION_UNSAFE",
  "DURABILITY_FAULT",
  "INVENTORY_MISMATCH",
  "KEY_CHAIN_UNTRUSTED",
  "MANIFEST_DIGEST_MISMATCH",
  "MANIFEST_SIGNATURE_INVALID",
  "MIXED_SOURCE_GENERATION",
  "OBJECT_DIGEST_MISMATCH",
  "OBJECT_DUPLICATE_IDENTITY",
  "OBJECT_MISSING",
  "OBJECT_SIZE_MISMATCH",
  "OBJECT_UNREADABLE",
  "REQUEST_SHAPE_INVALID",
] as const);
export type BackupGenerationReason = (typeof BACKUP_GENERATION_REASONS)[number];

/** One caller-declared member of the sealed closure. */
export interface BackupObjectDescriptor {
  readonly byteLength: string;
  readonly category: BackupObjectCategory;
  readonly digest: string;
  readonly logicalId: string;
  readonly logicalPath: string;
  readonly sourceGenerationDigest: string;
}

export interface BackupKeyChainEntry {
  readonly keyId: string;
  readonly role: "LEAF" | "ROOT";
}

/**
 * `cursor` and every byte length are canonical nonnegative decimal STRINGS.
 * `global_position` is a bigint column and a JS number loses precision past
 * 2^53, so a numeric cursor here would corrupt the one value the whole
 * generation is bound to.
 */
export interface BackupGenerationManifest {
  readonly cursor: string;
  readonly databaseByteLength: string;
  readonly databaseDigest: string;
  readonly generationDigest: string;
  readonly keyChain: readonly BackupKeyChainEntry[];
  readonly objects: readonly BackupObjectDescriptor[];
  readonly projectId: string;
  readonly sourceGenerationDigest: string;
  readonly version: typeof BACKUP_GENERATION_MANIFEST_VERSION;
}

/**
 * The signature sits structurally OUTSIDE the manifest it covers. Nesting it
 * would make the signed bytes self-referential and force an exclusion rule that
 * a verifier could get subtly wrong.
 */
export interface BackupGenerationContainer {
  readonly keyId: string;
  readonly manifest: BackupGenerationManifest;
  readonly publicKeySpkiDer: string;
  readonly signature: string;
}

/** Trust is supplied by the CALLER. A key carried inside a container never authorizes itself. */
export interface BackupGenerationTrust {
  readonly anchoredKeys: readonly { readonly keyId: string; readonly publicKeySpkiDer: string }[];
}

export interface BackupGenerationRefused {
  readonly code: "BACKUP_PROOF_UNKNOWN";
  readonly layer: "BACKUP_GENERATION";
  readonly ok: false;
  readonly reason: BackupGenerationReason;
  readonly restorable: false;
  readonly truth: "UNKNOWN";
}

export interface BackupGenerationVerified {
  readonly manifest: BackupGenerationManifest;
  readonly ok: true;
  readonly restorable: true;
}

export type BackupGenerationVerifyResult = BackupGenerationRefused | BackupGenerationVerified;

/**
 * One frozen tuple for every uncertainty path. Callers compare `reason`; the
 * other fields never vary, so no refusal can accidentally read as authority.
 */
export function refuseBackupGeneration(reason: BackupGenerationReason): BackupGenerationRefused {
  return Object.freeze({
    code: "BACKUP_PROOF_UNKNOWN",
    layer: "BACKUP_GENERATION",
    ok: false,
    reason,
    restorable: false,
    truth: "UNKNOWN",
  } as const);
}

/** Canonical nonnegative decimal text: no sign, no padding, no exponent, no separators. */
export function isCanonicalDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

export function isLowercaseHex(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value);
}

/**
 * Logical paths are `/`-separated, relative, and may not traverse. Rejecting a
 * backslash outright matters on Windows, where it is a separator the rest of
 * this check would not otherwise see.
 */
export function isSafeLogicalPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  if (value.includes("\\") || value.includes("\0")) return false;
  if (value.startsWith("/") || value.endsWith("/")) return false;
  if (value.normalize("NFC") !== value) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isWellFormedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value.normalize("NFC") === value &&
    !value.includes("\0")
  );
}
