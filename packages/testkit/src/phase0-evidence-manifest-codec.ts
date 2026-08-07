import {
  CANONICAL_JSON_VERSION,
  EVIDENCE_IDENTITY_VERSION,
  PHASE0_EVIDENCE_MANIFEST_VERSION,
  PHASE0_GIT_STATUS_COMMAND,
  PHASE0_SOURCE_REPOSITORY,
  PHASE0_TARGET_REPOSITORY,
  type GitObjectFormat,
  type Phase0EvidenceManifest,
  type Phase0RepositoryObservation,
} from "@moe/contracts";

import {
  decodeEntries,
  expectedObjectPath,
  gitOidPattern,
} from "./phase0-evidence-entry-codec.js";
import {
  freezeError,
  parseCanonicalJsonRecord,
  requireCanonicalInstant,
  requireExactKeys,
  requireRecord,
  requireSha256,
  requireString,
} from "./phase0-freeze-codec.js";

/** Narrow internal contract: the decoded manifest plus the exact canonical bytes it came from. */
export interface DecodedPhase0EvidenceManifest {
  readonly manifest: Phase0EvidenceManifest;
  readonly manifestBytes: Uint8Array;
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

export function decodeManifest(bytes: Uint8Array): DecodedPhase0EvidenceManifest {
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
