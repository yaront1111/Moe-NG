import { createHash } from "node:crypto";
import { win32 } from "node:path";

import {
  CANONICAL_JSON_VERSION,
  EVIDENCE_IDENTITY_VERSION,
  PHASE0_EVIDENCE_MANIFEST_VERSION,
  PHASE0_GIT_STATUS_COMMAND,
  PHASE0_ROLE_METADATA,
  PHASE0_SOURCE_REPOSITORY,
  PHASE0_TARGET_REPOSITORY,
  type GitObjectFormat,
  type Phase0EvidenceEntry,
  type Phase0EvidenceManifest,
  type Phase0RepositoryObservation,
  type Phase0SourceState,
} from "@moe/contracts";

import { identifyEvidence, snapshotEvidenceBytes } from "./evidence-digest.js";

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

interface VerifiedRepositorySnapshot {
  readonly head: string;
  readonly objectFormat: GitObjectFormat;
  readonly statusBytes: Uint8Array;
  readonly statusObjectPath: string;
  readonly statusSha256: string;
}

interface ExpectedEvidenceObject {
  readonly bytes: Uint8Array;
  readonly detail: string;
}

const GIT_SHA1_PATTERN = /^[0-9a-f]{40}$/;
const GIT_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function captureError(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
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

function countLines(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) {
    return 0;
  }
  let lineFeeds = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      lineFeeds += 1;
    }
  }
  return bytes[bytes.byteLength - 1] === 0x0a ? lineFeeds : lineFeeds + 1;
}

function expectedOidPattern(format: GitObjectFormat): RegExp {
  return format === "sha1" ? GIT_SHA1_PATTERN : GIT_SHA256_PATTERN;
}

function computeGitBlobOid(bytes: Uint8Array, format: GitObjectFormat): string {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  return createHash(format).update(header).update(bytes).digest("hex");
}

function validateCaptureTime(capturedAt: string): void {
  if (!CANONICAL_INSTANT_PATTERN.test(capturedAt)) {
    captureError("PHASE0_CAPTURE_TIME_INVALID", capturedAt);
  }
  const parsed = new Date(capturedAt);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== capturedAt) {
    captureError("PHASE0_CAPTURE_TIME_INVALID", capturedAt);
  }
}

function equalWindowsPaths(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

async function readAndValidateSourceFile(
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
  try {
    return snapshotEvidenceBytes(rawBytes as Uint8Array);
  } catch {
    return captureError("PHASE0_SOURCE_BYTES_INVALID", role);
  }
}

function validateEvidenceObjectLocation(
  location: Phase0EvidenceObjectLocation,
  expectedObjectPath: string,
  errorDetail: string,
): void {
  const targetRepository: unknown = location.targetRepository;
  const objectPath: unknown = location.objectPath;
  if (targetRepository !== PHASE0_TARGET_REPOSITORY) {
    captureError("PHASE0_TARGET_REPOSITORY_MISMATCH", errorDetail);
  }
  if (objectPath !== expectedObjectPath) {
    captureError("PHASE0_OBJECT_STORE_PATH_MISMATCH", errorDetail);
  }
}

async function readAndValidateEvidenceObject(
  port: Phase0EvidenceCapturePort,
  objectPath: string,
  errorDetail: string,
): Promise<Uint8Array> {
  let raw: Phase0RawEvidenceObject;
  try {
    raw = await port.readEvidenceObject(PHASE0_TARGET_REPOSITORY, objectPath);
  } catch {
    return captureError("PHASE0_OBJECT_STORE_VERIFY_FAILED", errorDetail);
  }

  const targetRepository: unknown = raw.targetRepository;
  const reportedObjectPath: unknown = raw.objectPath;
  const rawBytes: unknown = raw.bytes;
  validateEvidenceObjectLocation(
    { targetRepository: targetRepository as string, objectPath: reportedObjectPath as string },
    objectPath,
    errorDetail,
  );
  try {
    return snapshotEvidenceBytes(rawBytes as Uint8Array);
  } catch {
    return captureError("PHASE0_OBJECT_STORE_VERIFY_FAILED", errorDetail);
  }
}

async function persistAndVerifyObject(
  port: Phase0EvidenceCapturePort,
  objectPath: string,
  bytes: Uint8Array,
  errorDetail: string,
): Promise<void> {
  let receipt: Phase0EvidenceObjectLocation;
  try {
    receipt = await port.writeEvidenceObject(
      PHASE0_TARGET_REPOSITORY,
      objectPath,
      bytes.slice(),
    );
  } catch {
    return captureError("PHASE0_OBJECT_STORE_VERIFY_FAILED", errorDetail);
  }
  validateEvidenceObjectLocation(receipt, objectPath, errorDetail);
  const stored = await readAndValidateEvidenceObject(port, objectPath, errorDetail);
  if (!equalBytes(bytes, stored)) {
    captureError("PHASE0_OBJECT_STORE_VERIFY_FAILED", errorDetail);
  }
  const storedIdentity = identifyEvidence(stored);
  if (storedIdentity.objectPath !== objectPath) {
    captureError("PHASE0_OBJECT_STORE_VERIFY_FAILED", errorDetail);
  }
}

async function readAndVerifyRepositorySnapshot(
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
    statusBytes = snapshotEvidenceBytes(rawStatusBytes as Uint8Array);
  } catch {
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

async function determineSourceState(
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

function rememberExpectedObject(
  expectedObjects: Map<string, ExpectedEvidenceObject>,
  objectPath: string,
  bytes: Uint8Array,
  detail: string,
): void {
  const existing = expectedObjects.get(objectPath);
  if (existing !== undefined) {
    if (!equalBytes(existing.bytes, bytes)) {
      captureError("PHASE0_OBJECT_IDENTITY_COLLISION", detail);
    }
    return;
  }
  expectedObjects.set(
    objectPath,
    Object.freeze({ bytes: bytes.slice(), detail }),
  );
}

async function verifyCompleteObjectSet(
  port: Phase0EvidenceCapturePort,
  expectedObjects: ReadonlyMap<string, ExpectedEvidenceObject>,
): Promise<void> {
  for (const [objectPath, expected] of expectedObjects) {
    const stored = await readAndValidateEvidenceObject(
      port,
      objectPath,
      `final-${expected.detail}`,
    );
    if (!equalBytes(expected.bytes, stored)) {
      captureError("PHASE0_OBJECT_STORE_VERIFY_FAILED", `final-${expected.detail}`);
    }
    const storedIdentity = identifyEvidence(stored);
    if (storedIdentity.objectPath !== objectPath) {
      captureError("PHASE0_OBJECT_STORE_VERIFY_FAILED", `final-${expected.detail}`);
    }
  }
}

function repositoryObservation(
  snapshot: VerifiedRepositorySnapshot,
): Phase0RepositoryObservation {
  return Object.freeze({
    head: snapshot.head,
    statusObjectPath: snapshot.statusObjectPath,
    statusSha256: snapshot.statusSha256,
  });
}

function assertRepositoryUnchanged(
  before: VerifiedRepositorySnapshot,
  after: VerifiedRepositorySnapshot,
): void {
  if (before.objectFormat !== after.objectFormat) {
    captureError("PHASE0_REPOSITORY_CHANGED_DURING_CAPTURE", "object-format");
  }
  if (before.head !== after.head) {
    captureError("PHASE0_REPOSITORY_CHANGED_DURING_CAPTURE", "HEAD");
  }
  if (!equalBytes(before.statusBytes, after.statusBytes)) {
    captureError("PHASE0_REPOSITORY_CHANGED_DURING_CAPTURE", "status");
  }
}

export async function capturePhase0Evidence(
  port: Phase0EvidenceCapturePort,
): Promise<Phase0EvidenceManifest> {
  const before = await readAndVerifyRepositorySnapshot(port, "before");
  const entries: Phase0EvidenceEntry[] = [];
  const expectedObjects = new Map<string, ExpectedEvidenceObject>();
  const sourceBytes = new Map<string, Uint8Array>();
  const seenDigests = new Set<string>();

  rememberExpectedObject(
    expectedObjects,
    before.statusObjectPath,
    before.statusBytes,
    "repository-status-before",
  );

  for (const metadata of PHASE0_ROLE_METADATA) {
    const bytes = await readAndValidateSourceFile(port, metadata.relativePath, metadata.role);
    const identity = identifyEvidence(bytes);
    if (seenDigests.has(identity.digest)) {
      captureError("PHASE0_DUPLICATE_DOCUMENT_BYTES", metadata.role);
    }
    seenDigests.add(identity.digest);
    sourceBytes.set(metadata.role, bytes);

    const sourceState = await determineSourceState(
      port,
      before.head,
      metadata.relativePath,
      metadata.role,
      bytes,
      before.objectFormat,
    );
    await persistAndVerifyObject(port, identity.objectPath, bytes, metadata.role);
    rememberExpectedObject(expectedObjects, identity.objectPath, bytes, metadata.role);

    entries.push(
      Object.freeze({
        byteLength: identity.byteLength,
        lineCount: countLines(bytes),
        objectPath: identity.objectPath,
        owner: metadata.owner,
        relativePath: metadata.relativePath,
        role: metadata.role,
        sha256: identity.digest,
        sourceState,
      }),
    );
  }

  for (const metadata of PHASE0_ROLE_METADATA) {
    const reread = await readAndValidateSourceFile(
      port,
      metadata.relativePath,
      metadata.role,
    );
    const original = sourceBytes.get(metadata.role);
    if (original === undefined || !equalBytes(original, reread)) {
      captureError("PHASE0_SOURCE_CHANGED_DURING_CAPTURE", metadata.role);
    }
  }

  const after = await readAndVerifyRepositorySnapshot(port, "after");
  assertRepositoryUnchanged(before, after);
  rememberExpectedObject(
    expectedObjects,
    after.statusObjectPath,
    after.statusBytes,
    "repository-status-after",
  );
  const capturedAt = port.now();
  validateCaptureTime(capturedAt);
  await verifyCompleteObjectSet(port, expectedObjects);

  return Object.freeze({
    canonicalizerVersion: CANONICAL_JSON_VERSION,
    captureStatus: "VERIFIED",
    capturedAt,
    entries: Object.freeze(entries),
    evidenceIdentityVersion: EVIDENCE_IDENTITY_VERSION,
    gitObjectFormat: before.objectFormat,
    schemaVersion: PHASE0_EVIDENCE_MANIFEST_VERSION,
    sourceAfter: repositoryObservation(after),
    sourceBefore: repositoryObservation(before),
    sourceRepository: PHASE0_SOURCE_REPOSITORY,
    statusCommand: PHASE0_GIT_STATUS_COMMAND,
    targetRepository: PHASE0_TARGET_REPOSITORY,
  });
}
