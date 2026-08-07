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
}

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
