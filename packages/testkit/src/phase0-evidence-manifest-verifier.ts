import { createHash } from "node:crypto";

import {
  CANONICAL_JSON_VERSION,
  EVIDENCE_IDENTITY_VERSION,
  PHASE0_EVIDENCE_MANIFEST_VERSION,
  PHASE0_GIT_STATUS_COMMAND,
  PHASE0_MAX_DOCUMENT_BYTES,
  PHASE0_MAX_STATUS_BYTES,
  PHASE0_ROLE_METADATA,
  PHASE0_SOURCE_REPOSITORY,
  PHASE0_TARGET_REPOSITORY,
  type GitObjectFormat,
  type Phase0EvidenceEntry,
  type Phase0EvidenceManifest,
  type Phase0EvidenceRole,
  type Phase0RepositoryObservation,
  type Phase0SourceState,
} from "@moe/contracts";

import { identifyEvidence, snapshotEvidenceBytes, type EvidenceIdentity } from "./evidence-digest.js";
import {
  countLines,
  freezeError,
  parseCanonicalJsonRecord,
  requireCanonicalInstant,
  requireExactKeys,
  requireRecord,
  requireSafeNonnegativeInteger,
  requireSha256,
  requireString,
} from "./phase0-freeze-codec.js";

const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface Phase0FreezeObjectReader {
  readEvidenceObject(
    targetRepository: string,
    objectPath: string,
  ): Promise<{
    readonly bytes: Uint8Array;
    readonly objectPath: string;
    readonly targetRepository: string;
  }>;
}

export interface VerifiedPhase0EvidenceManifest {
  readonly identity: EvidenceIdentity;
  readonly manifest: Phase0EvidenceManifest;
  readonly manifestJson: string;
  readEvidence(role: Phase0EvidenceRole): Uint8Array;
}

function gitOidPattern(format: GitObjectFormat): RegExp {
  return format === "sha1" ? SHA1_PATTERN : SHA256_PATTERN;
}

function computeGitBlobOid(bytes: Uint8Array, format: GitObjectFormat): string {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  return createHash(format).update(header).update(bytes).digest("hex");
}

function expectedObjectPath(digest: string): string {
  return `objects/sha256/${digest.slice(0, 2)}/${digest}`;
}

function decodeObservation(
  value: unknown,
  format: GitObjectFormat,
  label: "sourceBefore" | "sourceAfter",
): Phase0RepositoryObservation {
  const record = requireRecord(value, "PHASE0_MANIFEST_OBSERVATION_INVALID", label);
  requireExactKeys(
    record,
    ["head", "statusObjectPath", "statusSha256"],
    "PHASE0_MANIFEST_OBSERVATION_INVALID",
    label,
  );
  const head = requireString(record.head, "PHASE0_MANIFEST_OBSERVATION_INVALID", `${label}.head`);
  if (!gitOidPattern(format).test(head)) {
    freezeError("PHASE0_MANIFEST_OBSERVATION_INVALID", `${label}.head`);
  }
  const statusSha256 = requireSha256(
    record.statusSha256,
    "PHASE0_MANIFEST_OBSERVATION_INVALID",
    `${label}.statusSha256`,
  );
  const statusObjectPath = requireString(
    record.statusObjectPath,
    "PHASE0_MANIFEST_OBSERVATION_INVALID",
    `${label}.statusObjectPath`,
  );
  if (statusObjectPath !== expectedObjectPath(statusSha256)) {
    freezeError("PHASE0_MANIFEST_OBSERVATION_INVALID", `${label}.statusObjectPath`);
  }
  return Object.freeze({ head, statusObjectPath, statusSha256 });
}

function decodeSourceState(
  value: unknown,
  format: GitObjectFormat,
  role: Phase0EvidenceRole,
): Phase0SourceState {
  const record = requireRecord(value, "PHASE0_MANIFEST_ENTRY_INVALID", `${role}.sourceState`);
  if (record.state === "ABSENT_AT_HEAD") {
    requireExactKeys(
      record,
      ["blobOid", "state"],
      "PHASE0_MANIFEST_ENTRY_INVALID",
      `${role}.sourceState`,
    );
    if (record.blobOid !== null) {
      freezeError("PHASE0_MANIFEST_ENTRY_INVALID", `${role}.blobOid`);
    }
    return Object.freeze({ blobOid: null, state: "ABSENT_AT_HEAD" });
  }
  if (record.state === "IDENTICAL_TO_HEAD") {
    requireExactKeys(
      record,
      ["blobOid", "state", "verifiedAtHead"],
      "PHASE0_MANIFEST_ENTRY_INVALID",
      `${role}.sourceState`,
    );
    const blobOid = requireString(
      record.blobOid,
      "PHASE0_MANIFEST_ENTRY_INVALID",
      `${role}.blobOid`,
    );
    if (!gitOidPattern(format).test(blobOid) || record.verifiedAtHead !== true) {
      freezeError("PHASE0_MANIFEST_ENTRY_INVALID", `${role}.sourceState`);
    }
    return Object.freeze({ blobOid, state: "IDENTICAL_TO_HEAD", verifiedAtHead: true });
  }
  return freezeError("PHASE0_MANIFEST_ENTRY_INVALID", `${role}.sourceState`);
}

function decodeEntries(value: unknown, format: GitObjectFormat): readonly Phase0EvidenceEntry[] {
  if (!Array.isArray(value) || value.length !== PHASE0_ROLE_METADATA.length) {
    return freezeError("PHASE0_MANIFEST_ROLE_SET_INVALID", "entry count");
  }
  const entries: Phase0EvidenceEntry[] = [];
  const seenDigests = new Set<string>();

  for (let index = 0; index < PHASE0_ROLE_METADATA.length; index += 1) {
    const metadata = PHASE0_ROLE_METADATA[index]!;
    const record = requireRecord(value[index], "PHASE0_MANIFEST_ENTRY_INVALID", metadata.role);
    requireExactKeys(
      record,
      [
        "byteLength",
        "lineCount",
        "objectPath",
        "owner",
        "relativePath",
        "role",
        "sha256",
        "sourceState",
      ],
      "PHASE0_MANIFEST_ENTRY_INVALID",
      metadata.role,
    );
    if (
      record.role !== metadata.role ||
      record.owner !== metadata.owner ||
      record.relativePath !== metadata.relativePath
    ) {
      freezeError("PHASE0_MANIFEST_ROLE_SET_INVALID", `entry ${index}`);
    }
    const byteLength = requireSafeNonnegativeInteger(
      record.byteLength,
      "PHASE0_MANIFEST_ENTRY_INVALID",
      `${metadata.role}.byteLength`,
    );
    if (byteLength > PHASE0_MAX_DOCUMENT_BYTES) {
      freezeError("PHASE0_MANIFEST_DOCUMENT_LIMIT_EXCEEDED", metadata.role);
    }
    const lineCount = requireSafeNonnegativeInteger(
      record.lineCount,
      "PHASE0_MANIFEST_ENTRY_INVALID",
      `${metadata.role}.lineCount`,
    );
    const sha256 = requireSha256(
      record.sha256,
      "PHASE0_MANIFEST_ENTRY_INVALID",
      `${metadata.role}.sha256`,
    );
    const objectPath = requireString(
      record.objectPath,
      "PHASE0_MANIFEST_ENTRY_INVALID",
      `${metadata.role}.objectPath`,
    );
    if (objectPath !== expectedObjectPath(sha256)) {
      freezeError("PHASE0_MANIFEST_ENTRY_INVALID", `${metadata.role}.objectPath`);
    }
    if (seenDigests.has(sha256)) {
      freezeError("PHASE0_MANIFEST_DUPLICATE_DOCUMENT_BYTES", metadata.role);
    }
    seenDigests.add(sha256);
    entries.push(
      Object.freeze({
        byteLength,
        lineCount,
        objectPath,
        owner: metadata.owner,
        relativePath: metadata.relativePath,
        role: metadata.role,
        sha256,
        sourceState: decodeSourceState(record.sourceState, format, metadata.role),
      }),
    );
  }
  return Object.freeze(entries);
}

function decodeManifest(bytes: Uint8Array): {
  readonly manifest: Phase0EvidenceManifest;
  readonly manifestBytes: Uint8Array;
} {
  const parsed = parseCanonicalJsonRecord(bytes, "manifest");
  const record = parsed.record;
  requireExactKeys(
    record,
    [
      "canonicalizerVersion",
      "captureStatus",
      "capturedAt",
      "entries",
      "evidenceIdentityVersion",
      "gitObjectFormat",
      "schemaVersion",
      "sourceAfter",
      "sourceBefore",
      "sourceRepository",
      "statusCommand",
      "targetRepository",
    ],
    "PHASE0_MANIFEST_SHAPE_INVALID",
    "keys",
  );
  if (
    record.canonicalizerVersion !== CANONICAL_JSON_VERSION ||
    record.captureStatus !== "VERIFIED" ||
    record.evidenceIdentityVersion !== EVIDENCE_IDENTITY_VERSION ||
    record.schemaVersion !== PHASE0_EVIDENCE_MANIFEST_VERSION ||
    record.sourceRepository !== PHASE0_SOURCE_REPOSITORY ||
    record.statusCommand !== PHASE0_GIT_STATUS_COMMAND
  ) {
    freezeError("PHASE0_MANIFEST_SHAPE_INVALID", "fixed fields");
  }
  if (record.targetRepository !== PHASE0_TARGET_REPOSITORY) {
    freezeError("PHASE0_TARGET_REPOSITORY_MISMATCH", "manifest");
  }
  if (record.gitObjectFormat !== "sha1" && record.gitObjectFormat !== "sha256") {
    freezeError("PHASE0_MANIFEST_SHAPE_INVALID", "gitObjectFormat");
  }
  const format = record.gitObjectFormat;
  const sourceBefore = decodeObservation(record.sourceBefore, format, "sourceBefore");
  const sourceAfter = decodeObservation(record.sourceAfter, format, "sourceAfter");
  if (
    sourceBefore.head !== sourceAfter.head ||
    sourceBefore.statusObjectPath !== sourceAfter.statusObjectPath ||
    sourceBefore.statusSha256 !== sourceAfter.statusSha256
  ) {
    freezeError("PHASE0_MANIFEST_REPOSITORY_CHANGED", "before/after");
  }
  return Object.freeze({
    manifest: Object.freeze({
      canonicalizerVersion: CANONICAL_JSON_VERSION,
      captureStatus: "VERIFIED",
      capturedAt: requireCanonicalInstant(
        record.capturedAt,
        "PHASE0_MANIFEST_CAPTURE_TIME_INVALID",
        "capturedAt",
      ),
      entries: decodeEntries(record.entries, format),
      evidenceIdentityVersion: EVIDENCE_IDENTITY_VERSION,
      gitObjectFormat: format,
      schemaVersion: PHASE0_EVIDENCE_MANIFEST_VERSION,
      sourceAfter,
      sourceBefore,
      sourceRepository: PHASE0_SOURCE_REPOSITORY,
      statusCommand: PHASE0_GIT_STATUS_COMMAND,
      targetRepository: PHASE0_TARGET_REPOSITORY,
    }),
    manifestBytes: parsed.bytes,
  });
}

async function readVerifiedObject(
  reader: Phase0FreezeObjectReader,
  objectPath: string,
  expectedDigest: string,
  expectedByteLength: number | null,
  detail: string,
): Promise<Uint8Array> {
  let raw: Awaited<ReturnType<Phase0FreezeObjectReader["readEvidenceObject"]>>;
  try {
    raw = await reader.readEvidenceObject(PHASE0_TARGET_REPOSITORY, objectPath);
  } catch {
    return freezeError("PHASE0_EVIDENCE_OBJECT_READ_FAILED", detail);
  }
  if (raw.targetRepository !== PHASE0_TARGET_REPOSITORY || raw.objectPath !== objectPath) {
    return freezeError("PHASE0_EVIDENCE_OBJECT_LOCATION_MISMATCH", detail);
  }
  let bytes: Uint8Array;
  try {
    bytes = snapshotEvidenceBytes(
      raw.bytes,
      expectedByteLength ?? PHASE0_MAX_STATUS_BYTES,
    );
  } catch {
    return freezeError("PHASE0_EVIDENCE_OBJECT_MISMATCH", detail);
  }
  const identity = identifyEvidence(bytes);
  if (
    identity.digest !== expectedDigest ||
    identity.objectPath !== objectPath ||
    (expectedByteLength !== null && identity.byteLength !== expectedByteLength)
  ) {
    freezeError("PHASE0_EVIDENCE_OBJECT_MISMATCH", detail);
  }
  return bytes;
}

export async function verifyPhase0EvidenceManifest(
  manifestInput: Uint8Array,
  reader: Phase0FreezeObjectReader,
): Promise<VerifiedPhase0EvidenceManifest> {
  const decoded = decodeManifest(manifestInput);
  const manifestIdentity = identifyEvidence(decoded.manifestBytes);
  const statusBytes = await readVerifiedObject(
    reader,
    decoded.manifest.sourceBefore.statusObjectPath,
    decoded.manifest.sourceBefore.statusSha256,
    null,
    "repository-status",
  );
  if (statusBytes.byteLength > PHASE0_MAX_STATUS_BYTES) {
    freezeError("PHASE0_MANIFEST_STATUS_LIMIT_EXCEEDED", String(statusBytes.byteLength));
  }

  const evidenceByRole = new Map<Phase0EvidenceRole, Uint8Array>();
  for (const entry of decoded.manifest.entries) {
    const bytes = await readVerifiedObject(
      reader,
      entry.objectPath,
      entry.sha256,
      entry.byteLength,
      entry.role,
    );
    if (countLines(bytes) !== entry.lineCount) {
      freezeError("PHASE0_MANIFEST_ENTRY_LINE_COUNT_MISMATCH", entry.role);
    }
    if (
      entry.sourceState.state === "IDENTICAL_TO_HEAD" &&
      computeGitBlobOid(bytes, decoded.manifest.gitObjectFormat) !== entry.sourceState.blobOid
    ) {
      freezeError("PHASE0_MANIFEST_GIT_BLOB_MISMATCH", entry.role);
    }
    evidenceByRole.set(entry.role, bytes);
  }

  return Object.freeze({
    identity: Object.freeze({ ...manifestIdentity }),
    manifest: decoded.manifest,
    manifestJson: new TextDecoder().decode(decoded.manifestBytes),
    readEvidence(role: Phase0EvidenceRole): Uint8Array {
      const bytes = evidenceByRole.get(role);
      if (bytes === undefined) {
        return freezeError("PHASE0_MANIFEST_ROLE_SET_INVALID", role);
      }
      return bytes.slice();
    },
  });
}
