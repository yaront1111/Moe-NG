import {
  PHASE0_MAX_DOCUMENT_BYTES,
  PHASE0_ROLE_METADATA,
  type GitObjectFormat,
  type Phase0EvidenceEntry,
  type Phase0EvidenceRole,
  type Phase0SourceState,
} from "@moe/contracts";

import {
  freezeError,
  requireExactKeys,
  requireRecord,
  requireSafeNonnegativeInteger,
  requireSha256,
  requireString,
} from "./phase0-freeze-codec.js";

const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function gitOidPattern(format: GitObjectFormat): RegExp {
  return format === "sha1" ? SHA1_PATTERN : SHA256_PATTERN;
}

export function expectedObjectPath(digest: string): string {
  return `objects/sha256/${digest.slice(0, 2)}/${digest}`;
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

export function decodeEntries(
  value: unknown,
  format: GitObjectFormat,
): readonly Phase0EvidenceEntry[] {
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
