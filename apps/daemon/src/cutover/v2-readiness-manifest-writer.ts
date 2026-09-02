import { createHash } from "node:crypto";

import { SQLITE_SCHEMA_MANIFEST_VERSION } from "@moe/store";
import type { CommitInput, CommitResult } from "@moe/store";

import { readCutoverGenerationSnapshot } from "./cutover-generation-snapshot.js";
import type { CutoverGenerationPorts, CutoverGenerations } from "./cutover-generation-snapshot.js";
import {
  V2_READINESS_MANIFEST_EVENT_TYPE,
  V2_READINESS_MANIFEST_LAYER,
  V2_READINESS_MANIFEST_SCHEMA_VERSION,
  decodeV2ReadinessManifest,
  deriveV2ReadinessManifestAggregateId,
  digestV2ReadinessManifest,
  encodeV2ReadinessManifest,
  readV2ReadinessManifest,
} from "./v2-readiness-manifest.js";
import type { V2ReadinessManifest, V2ReadinessManifestStore } from "./v2-readiness-manifest.js";
import { V2_SURFACE_MANIFEST_SHA256 } from "./v2-surface-manifest.js";

/**
 * THE ONE WRITER of the v2 readiness manifest, and it lives in release tooling
 * rather than in the request plane on purpose. `cutover.activate` reads exactly
 * one immutable readiness event and refuses on drift from it; a request field
 * that could name an evidence digest would let a caller mint the GA gate. So
 * nothing here takes a digest from a caller. Every field is either
 *
 *   - a durable generation, read through the daemon's OWN generation snapshot
 *     reader over the quiesced store (the same reader the activation compares
 *     the activation binding against, so the manifest cannot disagree with it
 *     by construction);
 *   - the sha256 of release-evidence BYTES the tool was handed as files; an
 *     empty file is refused by name, never digested into a "valid" hash of
 *     nothing;
 *   - a static pin this daemon build carries (store schema, surface manifest);
 *   - the source commit, admitted only as a full 40-hex id.
 *
 * ONE MANIFEST PER PROJECT. The aggregate must be empty: an existing manifest,
 * valid or not, is refused rather than superseded, because the marker that
 * `cutover.activate` writes binds the readiness digest AND version 1. After
 * the commit the manifest is read back through the production reader and its
 * digest compared, so the receipt this tool prints is the reader's answer, not
 * the writer's intent.
 */

export const V2_READINESS_EVIDENCE_KINDS = Object.freeze([
  "acceptanceEvidence",
  "backupEvidence",
  "contractSchema",
  "deliveryProfileQualificationEvidence",
  "restoreDrill",
  "securityEvidence",
  "storeMigrationEvidence",
  "windowsPackagingEvidence",
] as const);
export type V2ReadinessEvidenceKind = (typeof V2_READINESS_EVIDENCE_KINDS)[number];

/** The file each evidence kind is read from under the tool's `--evidence-root`. */
export const V2_READINESS_EVIDENCE_FILENAMES: Readonly<Record<V2ReadinessEvidenceKind, string>> =
  Object.freeze({
    acceptanceEvidence: "acceptance-evidence.json",
    backupEvidence: "backup-evidence.json",
    contractSchema: "contract-schema.json",
    deliveryProfileQualificationEvidence: "delivery-profile-qualification-evidence.json",
    restoreDrill: "restore-drill.json",
    securityEvidence: "security-evidence.json",
    storeMigrationEvidence: "store-migration-evidence.json",
    windowsPackagingEvidence: "windows-packaging-evidence.json",
  });

export type V2ReadinessEvidenceBytes = Readonly<Record<V2ReadinessEvidenceKind, Uint8Array>>;

export const V2_READINESS_WRITER_CODES = Object.freeze([
  "V2_READINESS_WRITER_SOURCE_COMMIT_INVALID",
  "V2_READINESS_WRITER_EVIDENCE_EMPTY",
  "V2_READINESS_WRITER_ALREADY_WRITTEN",
  "V2_READINESS_WRITER_STORE_UNREADABLE",
  "V2_READINESS_WRITER_GENERATION_REFUSED",
  "V2_READINESS_WRITER_COMMIT_REFUSED",
  "V2_READINESS_WRITER_READBACK_DIVERGED",
] as const);
export type V2ReadinessWriterCode = (typeof V2_READINESS_WRITER_CODES)[number];

export interface V2ReadinessWriterStore extends V2ReadinessManifestStore {
  commit(input: CommitInput): CommitResult;
}

export interface V2ReadinessWriterPorts {
  /** ISO instant stamped on the commit; the manifest itself carries no time. */
  readonly clock: () => string;
  /** The daemon's own generation reader, over the SAME store root the daemon reads. */
  readonly generation: CutoverGenerationPorts;
  readonly store: V2ReadinessWriterStore;
}

export interface V2ReadinessWriterInput {
  readonly evidence: V2ReadinessEvidenceBytes;
  readonly projectId: string;
  readonly sourceCommit: string;
}

export interface V2ReadinessWritten {
  readonly aggregateId: string;
  readonly digest: string;
  readonly evidenceDigests: Readonly<Record<V2ReadinessEvidenceKind, string>>;
  readonly generations: CutoverGenerations;
  readonly manifest: V2ReadinessManifest;
  readonly ok: true;
  readonly version: 1;
}

export interface V2ReadinessWriterRefused {
  readonly code: V2ReadinessWriterCode;
  /** What was refused: the evidence kind, the upstream code, or the existing digest. */
  readonly detail: string;
  readonly layer: typeof V2_READINESS_MANIFEST_LAYER;
  readonly ok: false;
  /** The answering authority when this tool forwards rather than decides. */
  readonly upstream: Readonly<{ code: string; layer: string }> | null;
}

export type V2ReadinessWriterResult = V2ReadinessWriterRefused | V2ReadinessWritten;

const COMMIT40 = /^[0-9a-f]{40}$/u;

function refuse(
  code: V2ReadinessWriterCode,
  detail: string,
  upstream: Readonly<{ code: string; layer: string }> | null = null,
): V2ReadinessWriterRefused {
  return Object.freeze({ code, detail, layer: V2_READINESS_MANIFEST_LAYER, ok: false as const, upstream });
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function digestEvidence(
  evidence: V2ReadinessEvidenceBytes,
): Readonly<Record<V2ReadinessEvidenceKind, string>> | V2ReadinessWriterRefused {
  const digests: Partial<Record<V2ReadinessEvidenceKind, string>> = {};
  for (const kind of V2_READINESS_EVIDENCE_KINDS) {
    const bytes = evidence[kind];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      return refuse("V2_READINESS_WRITER_EVIDENCE_EMPTY", kind);
    }
    digests[kind] = sha256Hex(bytes);
  }
  return Object.freeze(digests as Record<V2ReadinessEvidenceKind, string>);
}

export function writeV2ReadinessManifest(
  ports: V2ReadinessWriterPorts,
  input: V2ReadinessWriterInput,
): V2ReadinessWriterResult {
  if (!COMMIT40.test(input.sourceCommit)) {
    return refuse("V2_READINESS_WRITER_SOURCE_COMMIT_INVALID", input.sourceCommit.slice(0, 64));
  }
  const evidenceDigests = digestEvidence(input.evidence);
  if ("ok" in evidenceDigests) return evidenceDigests;

  // Empty aggregate or nothing: the marker binds version 1 of exactly one event.
  const existing = readV2ReadinessManifest(ports.store, { projectId: input.projectId });
  if (existing.ok) return refuse("V2_READINESS_WRITER_ALREADY_WRITTEN", existing.digest);
  if (existing.code === "V2_READINESS_MANIFEST_UNREADABLE") {
    return refuse("V2_READINESS_WRITER_STORE_UNREADABLE", existing.code, existing);
  }
  if (existing.code !== "V2_READINESS_MANIFEST_ABSENT") {
    return refuse("V2_READINESS_WRITER_ALREADY_WRITTEN", existing.code, existing);
  }

  // The four generations come from the daemon's own fenced snapshot, never from input.
  const snapshot = readCutoverGenerationSnapshot(ports.generation, { projectId: input.projectId });
  if (!snapshot.ok) {
    return refuse("V2_READINESS_WRITER_GENERATION_REFUSED", snapshot.code, snapshot);
  }

  const manifest: V2ReadinessManifest = Object.freeze({
    acceptanceEvidenceSha256: evidenceDigests.acceptanceEvidence,
    backupEvidenceSha256: evidenceDigests.backupEvidence,
    backupGenerationDigest: snapshot.generations.backupGenerationDigest,
    contractSchemaSha256: evidenceDigests.contractSchema,
    deliveryProfileQualificationEvidenceSha256: evidenceDigests.deliveryProfileQualificationEvidence,
    distributionManifestSha256: snapshot.generations.distributionManifestSha256,
    importGenerationSha256: snapshot.generations.importGenerationSha256,
    quiesceRecordSha256: snapshot.generations.quiesceRecordSha256,
    restoreDrillSha256: evidenceDigests.restoreDrill,
    schemaVersion: V2_READINESS_MANIFEST_SCHEMA_VERSION,
    securityEvidenceSha256: evidenceDigests.securityEvidence,
    sourceCommit: input.sourceCommit,
    storeMigrationEvidenceSha256: evidenceDigests.storeMigrationEvidence,
    storeSchemaVersion: SQLITE_SCHEMA_MANIFEST_VERSION,
    surfaceManifestSha256: V2_SURFACE_MANIFEST_SHA256,
    windowsPackagingEvidenceSha256: evidenceDigests.windowsPackagingEvidence,
  });
  const payload = encodeV2ReadinessManifest(manifest);
  // The production decoder is the admission: bytes this tool cannot read back
  // canonically are never committed.
  const admitted = decodeV2ReadinessManifest(payload);
  if (!admitted.ok) return refuse("V2_READINESS_WRITER_COMMIT_REFUSED", admitted.code, admitted);
  const digest = digestV2ReadinessManifest(manifest);
  const aggregateId = deriveV2ReadinessManifestAggregateId(input.projectId);

  let committed: CommitResult;
  try {
    committed = ports.store.commit({
      aggregateId,
      commandBytes: payload,
      commandId: `v2-readiness-manifest:${digest}`,
      committedAt: ports.clock(),
      events: [{
        domainSchemaVersion: V2_READINESS_MANIFEST_SCHEMA_VERSION,
        eventId: `v2-readiness-manifest:${digest}`,
        eventType: V2_READINESS_MANIFEST_EVENT_TYPE,
        payload,
      }],
      expectedVersion: 0,
    });
  } catch (error) {
    return refuse("V2_READINESS_WRITER_COMMIT_REFUSED", error instanceof Error ? error.message : String(error));
  }
  if (committed.disposition !== "COMMITTED" || committed.currentVersion !== 1) {
    return refuse("V2_READINESS_WRITER_COMMIT_REFUSED",
      `${committed.disposition}@${String(committed.currentVersion)}`);
  }

  // The receipt is the READER's answer over the durable bytes, not this tool's intent.
  const readBack = readV2ReadinessManifest(ports.store, { projectId: input.projectId });
  if (!readBack.ok) {
    return refuse("V2_READINESS_WRITER_READBACK_DIVERGED", readBack.code, readBack);
  }
  if (readBack.digest !== digest || readBack.version !== 1) {
    return refuse("V2_READINESS_WRITER_READBACK_DIVERGED",
      `${readBack.digest}@${String(readBack.version)}`);
  }
  return Object.freeze({
    aggregateId,
    digest,
    evidenceDigests,
    generations: snapshot.generations,
    manifest,
    ok: true as const,
    version: 1 as const,
  });
}
