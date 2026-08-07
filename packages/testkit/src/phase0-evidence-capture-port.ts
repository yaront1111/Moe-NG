import type { GitObjectFormat } from "@moe/contracts";

export interface Phase0RawRepositorySnapshot {
  readonly head: string;
  readonly objectFormat: GitObjectFormat;
  readonly sourceRepository: string;
  readonly statusCommand: string;
  readonly statusBytes: Uint8Array;
}

export interface Phase0HeadPathIdentity {
  readonly objectType: string;
  readonly oid: string;
}

export interface Phase0PathAtCommitObservation {
  readonly commit: string;
  readonly identity: Phase0HeadPathIdentity | null;
  readonly relativePath: string;
  readonly sourceRepository: string;
}

export interface Phase0EvidenceObjectLocation {
  readonly objectPath: string;
  readonly targetRepository: string;
}

export interface Phase0RawEvidenceObject extends Phase0EvidenceObjectLocation {
  readonly bytes: Uint8Array;
}

export interface Phase0RawSourceFile {
  readonly bytes: Uint8Array;
  readonly relativePath: string;
  /** OS-canonical absolute path for these bytes after resolving every symlink/reparse point. */
  readonly resolvedPath: string;
  readonly sourceRepository: string;
}

export interface Phase0EvidenceCapturePort {
  lookupPathAtCommit(
    sourceRepository: string,
    commit: string,
    relativePath: string,
  ): Promise<Phase0PathAtCommitObservation>;
  now(): string;
  readEvidenceObject(
    targetRepository: string,
    objectPath: string,
  ): Promise<Phase0RawEvidenceObject>;
  readRepositorySnapshot(
    sourceRepository: string,
    statusCommand: string,
  ): Promise<Phase0RawRepositorySnapshot>;
  readSourceFile(
    sourceRepository: string,
    relativePath: string,
  ): Promise<Phase0RawSourceFile>;
  writeEvidenceObject(
    targetRepository: string,
    objectPath: string,
    bytes: Uint8Array,
  ): Promise<Phase0EvidenceObjectLocation>;
}

/** Every capture-boundary failure surfaces as this exact stable `CODE: detail` text. */
export function captureError(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
