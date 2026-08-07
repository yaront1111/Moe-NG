import { createHash } from "node:crypto";

import {
  PHASE0_MAX_STATUS_BYTES,
  PHASE0_TARGET_REPOSITORY,
  type GitObjectFormat,
  type Phase0EvidenceEntry,
  type Phase0RepositoryObservation,
} from "@moe/contracts";

import { identifyEvidence, snapshotEvidenceBytes } from "./evidence-digest.js";
import { countLines, freezeError } from "./phase0-freeze-codec.js";

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

function computeGitBlobOid(bytes: Uint8Array, format: GitObjectFormat): string {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  return createHash(format).update(header).update(bytes).digest("hex");
}

/** Failure precedence: read -> location -> bounded bytes -> digest/path/byte-length identity. */
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

export async function readVerifiedStatusObject(
  reader: Phase0FreezeObjectReader,
  observation: Phase0RepositoryObservation,
): Promise<Uint8Array> {
  const statusBytes = await readVerifiedObject(
    reader,
    observation.statusObjectPath,
    observation.statusSha256,
    null,
    "repository-status",
  );
  if (statusBytes.byteLength > PHASE0_MAX_STATUS_BYTES) {
    freezeError("PHASE0_MANIFEST_STATUS_LIMIT_EXCEEDED", String(statusBytes.byteLength));
  }
  return statusBytes;
}

/** Identity first, then the LF line count, then the Git blob OID for head-identical entries. */
export async function readVerifiedEntryObject(
  reader: Phase0FreezeObjectReader,
  entry: Phase0EvidenceEntry,
  format: GitObjectFormat,
): Promise<Uint8Array> {
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
    computeGitBlobOid(bytes, format) !== entry.sourceState.blobOid
  ) {
    freezeError("PHASE0_MANIFEST_GIT_BLOB_MISMATCH", entry.role);
  }
  return bytes;
}
