import { createHash } from "node:crypto";

/**
 * Closed vocabulary for content-addressed artifact staging.
 *
 * Every rejection in this area is one of these codes, so a consumer can branch
 * on cause — a corrupt address, an unverifiable one, and an uncertain reference
 * count are different facts and never collapse into a generic failure.
 */
export const RUNNER_ARTIFACT_ERROR_CODES = Object.freeze([
  "RUNNER_ARTIFACT_STAGING_INVALID",
  "RUNNER_ARTIFACT_REF_INVALID",
  "RUNNER_ARTIFACT_WRITE_FAILED",
  "RUNNER_ARTIFACT_FLUSH_FAILED",
  "RUNNER_ARTIFACT_CLOSE_FAILED",
  "RUNNER_ARTIFACT_RENAME_FAILED",
  "RUNNER_ARTIFACT_PERSIST_FAILED",
  "RUNNER_ARTIFACT_VERIFY_FAILED",
  "RUNNER_ARTIFACT_ADDRESS_CORRUPT",
  "RUNNER_ARTIFACT_MISSING",
  "RUNNER_ARTIFACT_DELETE_FAILED",
  "RUNNER_ARTIFACT_REFS_UNCERTAIN",
  "RUNNER_ARTIFACT_REFS_PRESENT",
  "RUNNER_ARTIFACT_ENUMERATION_UNAVAILABLE",
  "RUNNER_ARTIFACT_ENUMERATION_LIMIT",
] as const);

export type RunnerArtifactErrorCode = (typeof RUNNER_ARTIFACT_ERROR_CODES)[number];

/**
 * Descriptor-oriented on purpose: a path-oriented write helper has no fd, so
 * "flush before rename" would be unimplementable and the durability claim would
 * be a lie. `persistAfterRename` is a first-class boundary because the rename
 * itself is metadata that POSIX only durables via a parent-directory fsync and
 * win32 only via reopening the final path.
 */
export interface ArtifactFsPort {
  openWrite(path: string): number;
  write(fd: number, bytes: Uint8Array): void;
  fsync(fd: number): void;
  close(fd: number): void;
  exists(path: string): boolean;
  rename(from: string, to: string): void;
  persistAfterRename(path: string): void;
  readAll(path: string): Uint8Array;
  unlink(path: string): void;
  /**
   * Bounded directory listing. OPTIONAL so ports already injected by existing
   * tests and callers keep compiling; the store fails closed with
   * RUNNER_ARTIFACT_ENUMERATION_UNAVAILABLE when a port does not supply it,
   * rather than reporting an empty directory it never read.
   */
  listDirectory?(path: string): readonly ArtifactDirectoryEntry[];
}

/**
 * Entry kinds are deliberately coarse. The store needs to know only whether an
 * entry can be read as an object; anything else is reported, never skipped. The
 * name is a BASENAME so no raw path escapes the port.
 */
export const ARTIFACT_DIRECTORY_ENTRY_KINDS = Object.freeze([
  "FILE",
  "DIRECTORY",
  "OTHER",
] as const);

export type ArtifactDirectoryEntryKind = (typeof ARTIFACT_DIRECTORY_ENTRY_KINDS)[number];

export interface ArtifactDirectoryEntry {
  readonly name: string;
  readonly kind: ArtifactDirectoryEntryKind;
}

/**
 * Two boundaries can refuse an enumeration and they mean different things:
 * ARTIFACT_FS_PORT is what the filesystem said, ARTIFACT_STORE is what the
 * layout means. Collapsing them would let a layout bug read as an I/O fault.
 */
export const ARTIFACT_ENUMERATION_LAYERS = Object.freeze([
  "ARTIFACT_FS_PORT",
  "ARTIFACT_STORE",
] as const);

export type ArtifactEnumerationLayer = (typeof ARTIFACT_ENUMERATION_LAYERS)[number];

/** Hard ceiling on entries read in one scan; the N+1st entry refuses. */
export const MAX_ARTIFACT_ENUMERATION_ENTRIES = 100_000;

export interface ArtifactObjectObservation {
  readonly sha256: string;
  readonly byteLength: number;
}

/** Staging temps are reported by name: they are not addressable content yet. */
export interface ArtifactStagingObservation {
  readonly name: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ArtifactEnumerationFailure {
  readonly ok: false;
  readonly code: RunnerArtifactErrorCode;
  readonly message: string;
  readonly layer: ArtifactEnumerationLayer;
}

export interface ArtifactEnumerationOk {
  readonly ok: true;
  readonly objects: readonly ArtifactObjectObservation[];
  readonly staging: readonly ArtifactStagingObservation[];
  readonly entryCount: number;
  /** Present even when the listing is empty, so absence is an observed fact. */
  readonly observationDigest: string;
}

export type ArtifactEnumerationResult = ArtifactEnumerationOk | ArtifactEnumerationFailure;

export function enumerationFailure(
  code: RunnerArtifactErrorCode,
  message: string,
  layer: ArtifactEnumerationLayer,
): ArtifactEnumerationFailure {
  return Object.freeze({ ok: false as const, code, message, layer });
}

/** Exact grammar of the store's own temp names: `<16hex>.<counter>.tmp`. */
export const ARTIFACT_STAGING_PATTERN = /^[0-9a-f]{16}\.(?:0|[1-9][0-9]*)\.tmp$/u;

export interface ArtifactRef {
  readonly sha256: string;
  readonly byteLength: number;
}

/**
 * Reachability verdict from the caller's garbage collector. Only the first
 * variant authorises deletion, and it must name what was actually scanned.
 */
export type ArtifactReferenceProof =
  | { readonly state: "ZERO_REFERENCES"; readonly scannedGenerations: readonly string[] }
  | { readonly state: "REFERENCED" }
  | { readonly state: "UNCERTAIN"; readonly reason: string };

export interface ArtifactFailure {
  readonly ok: false;
  readonly code: RunnerArtifactErrorCode;
  readonly message: string;
}

export interface StagedArtifact {
  readonly ok: true;
  readonly ref: ArtifactRef;
  readonly deduplicated: boolean;
}

export type StageArtifactResult = StagedArtifact | ArtifactFailure;
export type VerifyArtifactResult = { readonly ok: true } | ArtifactFailure;
export type DeleteArtifactResult = { readonly ok: true; readonly deleted: boolean } | ArtifactFailure;

export interface ArtifactStoreOptions {
  readonly root: string;
  readonly fs: ArtifactFsPort;
  /** Monotonic counter supplying temp-name entropy; never clock- or random-derived. */
  readonly nextStagingCounter: () => number;
}

export interface ArtifactStore {
  stageArtifact(bytes: Uint8Array): StageArtifactResult;
  verifyArtifact(ref: ArtifactRef): VerifyArtifactResult;
  deleteArtifact(ref: ArtifactRef, proof: ArtifactReferenceProof): DeleteArtifactResult;
  /** Required here, unlike the port method: this store is factory-owned. */
  enumerateArtifacts(): ArtifactEnumerationResult;
}

export const ARTIFACT_ADDRESS_PATTERN = /^[0-9a-f]{64}$/u;

export type Attempt<T> = { readonly ok: true; readonly value: T } | ArtifactFailure;

export function artifactFailure(
  code: RunnerArtifactErrorCode,
  message: string,
): ArtifactFailure {
  return Object.freeze({ ok: false as const, code, message });
}

/** Turns one port call into a coded result so no boundary can throw past the store. */
export function attempt<T>(code: RunnerArtifactErrorCode, action: () => T): Attempt<T> {
  try {
    return { ok: true as const, value: action() };
  } catch (error) {
    return artifactFailure(code, error instanceof Error ? error.message : String(error));
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Guards the address before it is ever joined onto a path. */
export function refRejection(ref: ArtifactRef): string | null {
  if (!ARTIFACT_ADDRESS_PATTERN.test(ref.sha256)) {
    return "artifact sha256 must be lowercase 64-hex";
  }
  if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
    return "artifact byteLength must be a non-negative safe integer";
  }
  return null;
}

export function refMatches(bytes: Uint8Array, ref: ArtifactRef): boolean {
  return bytes.byteLength === ref.byteLength && sha256Hex(bytes) === ref.sha256;
}
