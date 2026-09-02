import { MAX_JSON_BODY_BYTES } from "@moe/contracts";

export const SOURCE_SNAPSHOT_VERSION = "moe-source-snapshot/1" as const;
export const SOURCE_SNAPSHOT_DIGEST_DOMAIN = "moe-source-snapshot-digest/1" as const;
export const SOURCE_SNAPSHOT_CODES = Object.freeze([
  "SOURCE_SNAPSHOT_MALFORMED",
  "SOURCE_SNAPSHOT_VERSION_UNSUPPORTED",
  "SOURCE_SNAPSHOT_LIMIT_EXCEEDED",
  "SOURCE_SNAPSHOT_BYTES_INVALID",
  "SOURCE_SNAPSHOT_DUPLICATE_KEY",
  "SOURCE_SNAPSHOT_NONCANONICAL",
  "SOURCE_SNAPSHOT_DIGEST_MISMATCH",
] as const);
export const SOURCE_SNAPSHOT_LAYERS = Object.freeze([
  "SOURCE_SNAPSHOT_ADMISSION",
  "SOURCE_SNAPSHOT_VERSION",
  "SOURCE_SNAPSHOT_LIMITS",
  "SOURCE_SNAPSHOT_CODEC",
  "SOURCE_SNAPSHOT_CANONICALIZATION",
  "SOURCE_SNAPSHOT_DIGEST",
] as const);
export const SOURCE_SNAPSHOT_LIMITS = Object.freeze({
  maxBytes: MAX_JSON_BODY_BYTES,
  maxRefCodeUnits: 256,
});
export const SOURCE_SNAPSHOT_REF_KEYS = Object.freeze([
  "projectId", "sourceSnapshotDigest",
] as const);
export const SOURCE_SNAPSHOT_DRAFT_KEYS = Object.freeze([
  "baseRevisionHash", "projectId", "repositoryBaseTree", "repositoryRef", "scopeRef",
] as const);
export const SOURCE_SNAPSHOT_KEYS = Object.freeze([
  ...SOURCE_SNAPSHOT_DRAFT_KEYS, "sourceSnapshotDigest", "version",
] as const);

export type SourceSnapshotCode = (typeof SOURCE_SNAPSHOT_CODES)[number];
export type SourceSnapshotLayer = (typeof SOURCE_SNAPSHOT_LAYERS)[number];

export interface SourceSnapshotDraft {
  readonly baseRevisionHash: string;
  readonly projectId: string;
  readonly repositoryBaseTree: string;
  readonly repositoryRef: string;
  readonly scopeRef: string;
}
/** Content identity only; the later publisher proves these values came from Git. */
export interface SourceSnapshot extends SourceSnapshotDraft {
  readonly sourceSnapshotDigest: string;
  readonly version: typeof SOURCE_SNAPSHOT_VERSION;
}
export interface SourceSnapshotRef {
  readonly projectId: string;
  readonly sourceSnapshotDigest: string;
}
export interface SourceSnapshotRefusal {
  readonly code: SourceSnapshotCode;
  readonly layer: SourceSnapshotLayer;
  readonly ok: false;
}
export type SourceSnapshotDraftAdmission =
  | Readonly<{ draft: SourceSnapshotDraft; ok: true }> | SourceSnapshotRefusal;
export type SourceSnapshotAdmission =
  | Readonly<{ ok: true; snapshot: SourceSnapshot }> | SourceSnapshotRefusal;
export type SourceSnapshotRefAdmission =
  | Readonly<{ ok: true; ref: SourceSnapshotRef }> | SourceSnapshotRefusal;

export function sourceSnapshotRefusal(
  code: SourceSnapshotCode,
  layer: SourceSnapshotLayer,
): SourceSnapshotRefusal {
  return Object.freeze({ code, layer, ok: false as const });
}
