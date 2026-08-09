import {
  byCodeUnit,
  canonicalDigest,
  canonicalJson,
  isPlainRecord,
} from "./canonical-bytes.js";
import {
  DETERMINISTIC_TIME_SENTINEL,
  IMPORT_RECORD_VERSION,
  refuseImport,
} from "./import-contract.js";
import type { ImportProvenance, ImportRefused } from "./import-contract.js";
import type { SourceManifest } from "./source-manifest.js";

/**
 * Canonical derivation (design §21.7) — the heart of DoD 1.
 *
 * Imported ids, ordering, provenance times and canonical payloads all derive from the
 * source digests and the manifest. Nothing here reads a clock, a random source, an
 * environment variable, or the filesystem, so the same bytes produce the same output on
 * every machine and every run. That is what makes "identical bytes produce identical
 * canonical DB/export hashes" a property rather than a hope.
 */

/** One record read out of one source file, before canonicalisation. */
export interface LegacySourceRecord {
  /** The time the SOURCE declared, or null when it declared none. Never a clock read. */
  readonly declaredTime: string | null;
  readonly kind: string;
  readonly legacyId: string;
  readonly payload: Record<string, unknown>;
  readonly sourcePath: string;
}

/**
 * The imported id.
 *
 * Digested over a canonical RECORD rather than a joined string, deliberately. A joined
 * key collides: `kind "a"` + `legacyId "b:c"` and `kind "a:b"` + `legacyId "c"` both
 * render as `a:b:c`, so two distinct legacy records would import onto one id and silently
 * merge. canonicalJson quotes every field, so no such split exists.
 *
 * `manifestDigest` is part of the input so two unrelated legacy projects that both contain
 * `task-1` cannot collide, while re-importing the same tree always reproduces the id.
 */
export function deriveImportedId(manifestDigest: string, record: LegacySourceRecord): string {
  return canonicalDigest({
    kind: record.kind,
    legacyId: record.legacyId,
    manifestDigest,
    sourcePath: record.sourcePath,
    version: IMPORT_RECORD_VERSION,
  });
}

/**
 * §21.3 provenance, bound to the exact source file the manifest hashed.
 *
 * A record naming a path the manifest never hashed is refused rather than given
 * provenance: provenance that points at unhashed bytes is not evidence, and accepting it
 * would let a record enter the import without being covered by the manifest digest.
 */
export function deriveProvenance(
  manifest: SourceManifest,
  record: LegacySourceRecord,
): ImportProvenance | ImportRefused {
  const entry = manifest.entries.find((candidate) => candidate.path === record.sourcePath);
  if (entry === undefined) {
    return refuseImport(
      "IMPORT_RECORD_UNCANONICAL",
      "CANONICAL",
      `record cites ${record.sourcePath}, which the manifest did not hash`,
    );
  }
  const declared = record.declaredTime;
  return Object.freeze({
    manifestDigest: manifest.digest,
    sourceDigest: entry.digest,
    sourcePath: entry.path,
    sourceTime: declared ?? DETERMINISTIC_TIME_SENTINEL,
    timeBasis: declared === null ? "MANIFEST_SENTINEL" : "SOURCE_DECLARED",
  });
}

/**
 * A total order over three stable fields, compared as a TUPLE rather than as a joined
 * key — same collision reasoning as `deriveImportedId`.
 *
 * Insertion order and filesystem order are both excluded by construction: the caller's
 * array is copied before sorting, so ordering cannot depend on how the records were
 * discovered.
 */
function compareRecords(left: LegacySourceRecord, right: LegacySourceRecord): number {
  const byPath = byCodeUnit(left.sourcePath, right.sourcePath);
  if (byPath !== 0) return byPath;
  const byKind = byCodeUnit(left.kind, right.kind);
  if (byKind !== 0) return byKind;
  return byCodeUnit(left.legacyId, right.legacyId);
}

export function orderRecords(
  records: readonly LegacySourceRecord[],
): readonly LegacySourceRecord[] {
  return Object.freeze([...records].sort(compareRecords));
}

/**
 * The canonical payload text a digest is taken over.
 *
 * Refuses rather than digesting anything canonical JSON cannot represent faithfully: a
 * non-safe integer would round, and a Uint8Array would serialise as an index-keyed object
 * that no reader could turn back into bytes. Either would produce a stable-looking digest
 * over a value that had already lost information — the worst kind of pass.
 */
export function canonicalPayload(record: LegacySourceRecord): string | ImportRefused {
  if (!isPlainRecord(record.payload)) {
    return refuseImport(
      "IMPORT_RECORD_UNCANONICAL",
      "CANONICAL",
      `payload of ${record.legacyId} is not a plain record`,
    );
  }
  try {
    return canonicalJson(record.payload);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return refuseImport(
      "IMPORT_RECORD_UNCANONICAL",
      "CANONICAL",
      `payload of ${record.legacyId} is not canonicalisable: ${detail}`,
    );
  }
}
