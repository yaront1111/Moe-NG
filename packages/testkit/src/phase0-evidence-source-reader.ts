import { createHash } from "node:crypto";
import { win32 } from "node:path";

import {
  PHASE0_GIT_STATUS_COMMAND,
  PHASE0_MAX_DOCUMENT_BYTES,
  PHASE0_MAX_STATUS_BYTES,
  PHASE0_SOURCE_REPOSITORY,
  type GitObjectFormat,
  type Phase0SourceState,
} from "@moe/contracts";

import { identifyEvidence, snapshotEvidenceBytes } from "./evidence-digest.js";
import {
  captureError,
  type Phase0EvidenceCapturePort,
  type Phase0HeadPathIdentity,
} from "./phase0-evidence-capture-port.js";
import { persistAndVerifyObject } from "./phase0-evidence-object-store.js";

export interface VerifiedRepositorySnapshot {
  readonly head: string;
  readonly objectFormat: GitObjectFormat;
  readonly statusBytes: Uint8Array;
  readonly statusObjectPath: string;
  readonly statusSha256: string;
}

const GIT_SHA1_PATTERN = /^[0-9a-f]{40}$/;
const GIT_SHA256_PATTERN = /^[0-9a-f]{64}$/;

function expectedOidPattern(format: GitObjectFormat): RegExp {
  return format === "sha1" ? GIT_SHA1_PATTERN : GIT_SHA256_PATTERN;
}

function computeGitBlobOid(bytes: Uint8Array, format: GitObjectFormat): string {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  return createHash(format).update(header).update(bytes).digest("hex");
}

/** Windows path semantics on every host: capture is pinned to a Windows source repository. */
function equalWindowsPaths(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

export async function readAndValidateSourceFile(
  port: Phase0EvidenceCapturePort,
  relativePath: string,
  role: string,
): Promise<Uint8Array> {
  const raw = await port.readSourceFile(PHASE0_SOURCE_REPOSITORY, relativePath);
  const sourceRepository: unknown = raw.sourceRepository;
  const reportedRelativePath: unknown = raw.relativePath;
  const resolvedPath: unknown = raw.resolvedPath;
  const rawBytes: unknown = raw.bytes;
  if (sourceRepository !== PHASE0_SOURCE_REPOSITORY) {
    captureError("PHASE0_SOURCE_REPOSITORY_MISMATCH", role);
  }
  if (reportedRelativePath !== relativePath) {
    captureError("PHASE0_SOURCE_RELATIVE_PATH_MISMATCH", role);
  }
  const expectedPath = win32.join(PHASE0_SOURCE_REPOSITORY, relativePath);
  if (typeof resolvedPath !== "string" || !equalWindowsPaths(resolvedPath, expectedPath)) {
    captureError("PHASE0_SOURCE_PATH_MISMATCH", role);
  }
  let bytes: Uint8Array;
  try {
    bytes = snapshotEvidenceBytes(rawBytes as Uint8Array, PHASE0_MAX_DOCUMENT_BYTES);
  } catch (error) {
    if (error instanceof RangeError) {
      return captureError("PHASE0_SOURCE_FILE_LIMIT_EXCEEDED", role);
    }
    return captureError("PHASE0_SOURCE_BYTES_INVALID", role);
  }
  return bytes;
}

export async function readAndVerifyRepositorySnapshot(
  port: Phase0EvidenceCapturePort,
  label: "before" | "after",
): Promise<VerifiedRepositorySnapshot> {
  const raw = await port.readRepositorySnapshot(
    PHASE0_SOURCE_REPOSITORY,
    PHASE0_GIT_STATUS_COMMAND,
  );
  const objectFormat: unknown = raw.objectFormat;
  const head: unknown = raw.head;
  const sourceRepository: unknown = raw.sourceRepository;
  const statusCommand: unknown = raw.statusCommand;
  const rawStatusBytes: unknown = raw.statusBytes;

  if (sourceRepository !== PHASE0_SOURCE_REPOSITORY) {
    captureError("PHASE0_SOURCE_REPOSITORY_MISMATCH", label);
  }
  if (statusCommand !== PHASE0_GIT_STATUS_COMMAND) {
    captureError("PHASE0_STATUS_COMMAND_MISMATCH", label);
  }
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    captureError("PHASE0_GIT_OBJECT_FORMAT_INVALID", label);
  }
  if (typeof head !== "string" || !expectedOidPattern(objectFormat).test(head)) {
    captureError("PHASE0_REPOSITORY_HEAD_INVALID", label);
  }
  let statusBytes: Uint8Array;
  try {
    statusBytes = snapshotEvidenceBytes(rawStatusBytes as Uint8Array, PHASE0_MAX_STATUS_BYTES);
  } catch (error) {
    if (error instanceof RangeError) {
      return captureError("PHASE0_REPOSITORY_STATUS_LIMIT_EXCEEDED", label);
    }
    captureError("PHASE0_REPOSITORY_STATUS_INVALID", label);
  }
  const statusIdentity = identifyEvidence(statusBytes);
  await persistAndVerifyObject(port, statusIdentity.objectPath, statusBytes, `repository-status-${label}`);

  return {
    head,
    objectFormat,
    statusBytes,
    statusObjectPath: statusIdentity.objectPath,
    statusSha256: statusIdentity.digest,
  };
}

export async function determineSourceState(
  port: Phase0EvidenceCapturePort,
  commit: string,
  relativePath: string,
  role: string,
  bytes: Uint8Array,
  objectFormat: GitObjectFormat,
): Promise<Phase0SourceState> {
  const observation = await port.lookupPathAtCommit(
    PHASE0_SOURCE_REPOSITORY,
    commit,
    relativePath,
  );
  const observedRepository: unknown = observation.sourceRepository;
  const observedCommit: unknown = observation.commit;
  const observedRelativePath: unknown = observation.relativePath;
  const headPath: unknown = observation.identity;
  if (observedRepository !== PHASE0_SOURCE_REPOSITORY) {
    return captureError("PHASE0_SOURCE_REPOSITORY_MISMATCH", role);
  }
  if (observedCommit !== commit) {
    return captureError("PHASE0_COMMIT_LOOKUP_MISMATCH", role);
  }
  if (observedRelativePath !== relativePath) {
    return captureError("PHASE0_PATH_LOOKUP_MISMATCH", role);
  }
  if (headPath === null) {
    return Object.freeze({ blobOid: null, state: "ABSENT_AT_HEAD" });
  }
  if (typeof headPath !== "object") {
    return captureError("PHASE0_GIT_BLOB_MISMATCH", role);
  }
  const identity = headPath as Phase0HeadPathIdentity;
  const objectType: unknown = identity.objectType;
  const oid: unknown = identity.oid;
  if (objectType !== "blob") {
    return captureError("PHASE0_GIT_OBJECT_NOT_BLOB", role);
  }
  if (typeof oid !== "string" || !expectedOidPattern(objectFormat).test(oid)) {
    return captureError("PHASE0_GIT_BLOB_MISMATCH", role);
  }
  const expectedOid = computeGitBlobOid(bytes, objectFormat);
  if (oid !== expectedOid) {
    return captureError("PHASE0_GIT_BLOB_MISMATCH", role);
  }
  return Object.freeze({
    blobOid: oid,
    state: "IDENTICAL_TO_HEAD",
    verifiedAtHead: true,
  });
}
