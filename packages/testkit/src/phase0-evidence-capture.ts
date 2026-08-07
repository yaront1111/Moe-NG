import {
  CANONICAL_JSON_VERSION,
  EVIDENCE_IDENTITY_VERSION,
  PHASE0_EVIDENCE_MANIFEST_VERSION,
  PHASE0_GIT_STATUS_COMMAND,
  PHASE0_ROLE_METADATA,
  PHASE0_SOURCE_REPOSITORY,
  PHASE0_TARGET_REPOSITORY,
  type Phase0EvidenceEntry,
  type Phase0EvidenceManifest,
  type Phase0RepositoryObservation,
} from "@moe/contracts";

import { identifyEvidence } from "./evidence-digest.js";
import {
  captureError,
  equalBytes,
  type Phase0EvidenceCapturePort,
} from "./phase0-evidence-capture-port.js";
import {
  persistAndVerifyObject,
  verifyCompleteObjectSet,
  type ExpectedEvidenceObject,
} from "./phase0-evidence-object-store.js";
import {
  determineSourceState,
  readAndValidateSourceFile,
  readAndVerifyRepositorySnapshot,
  type VerifiedRepositorySnapshot,
} from "./phase0-evidence-source-reader.js";

export type {
  Phase0EvidenceCapturePort,
  Phase0EvidenceObjectLocation,
  Phase0HeadPathIdentity,
  Phase0PathAtCommitObservation,
  Phase0RawEvidenceObject,
  Phase0RawRepositorySnapshot,
  Phase0RawSourceFile,
} from "./phase0-evidence-capture-port.js";

const CANONICAL_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

function validateCaptureTime(capturedAt: string): void {
  if (!CANONICAL_INSTANT_PATTERN.test(capturedAt)) {
    captureError("PHASE0_CAPTURE_TIME_INVALID", capturedAt);
  }
  const parsed = new Date(capturedAt);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== capturedAt) {
    captureError("PHASE0_CAPTURE_TIME_INVALID", capturedAt);
  }
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
