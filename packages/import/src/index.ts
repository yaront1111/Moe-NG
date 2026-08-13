/**
 * @moe/import — deterministic, read-only importer for frozen legacy Moe projects
 * (design §21.2-§21.7).
 *
 * The package is a pure function from frozen source bytes to a canonical import: ids,
 * ordering, provenance times and canonical payloads all derive from source digests and
 * the manifest, never from wall-clock import time. There is no clock and no random source
 * anywhere in it, because either one makes §21.7's "identical bytes produce identical
 * canonical hashes" unprovable.
 *
 * Out of scope by design: live legacy reads, write-back, dual write, and every cutover
 * step (§21.9-§21.13). Nothing imported is ever active — `ImportedClaimStatus` has no
 * ACTIVE arm, and `LegacyLink.evidenceOnly` is the literal `true`.
 *
 * Curated named exports only, so the published seam stays a reviewed decision rather than
 * whatever the modules happen to export next week.
 */

export { applyImport } from "./import-apply.js";
export type {
  ApplyImportInput,
  ApplyImportResult,
  ImportCommitInput,
  ImportCommitOutcome,
  ImportEventDraft,
  ImportStorePort,
} from "./import-apply.js";

export {
  canonicalPayload,
  deriveImportedId,
  deriveProvenance,
  orderRecords,
} from "./import-canonical.js";
export type { LegacySourceRecord } from "./import-canonical.js";

export {
  AMBIGUITY_CLASSES,
  AMBIGUITY_OUTCOME,
  DERIVED_IDENTITY_AMBIGUITY_CLASSES,
  DESIGN_AMBIGUITY_CLASSES,
  DETERMINISTIC_TIME_SENTINEL,
  IMPORTED_CLAIM_STATUSES,
  IMPORT_RECORD_VERSION,
  IMPORT_REFUSAL_CODES,
  IMPORT_REFUSAL_LAYERS,
  LEGACY_LINK_KINDS,
  SKILL_ASSET_AMBIGUITY_CLASSES,
  SOURCE_MANIFEST_VERSION,
  TIME_BASES,
  refuseImport,
} from "./import-contract.js";
export type {
  AmbiguityClass,
  ImportCounts,
  ImportProvenance,
  ImportRefusalCode,
  ImportRefusalLayer,
  ImportRefused,
  ImportReport,
  ImportedClaim,
  ImportedClaimStatus,
  LegacyLink,
  LegacyLinkKind,
  ReconciliationFinding,
  TimeBasis,
} from "./import-contract.js";

export { reconcileImport } from "./import-reconcile.js";
export type { ReconcileEntry, ReconcileInput, ReconcileReport } from "./import-reconcile.js";

export { buildSourceManifest } from "./source-manifest.js";
export type { SourceFileEntry, SourceManifest, SourceManifestResult } from "./source-manifest.js";
