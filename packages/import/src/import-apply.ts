import { canonicalDigest } from "./canonical-bytes.js";
import {
  canonicalPayload,
  deriveImportedId,
  deriveProvenance,
  orderRecords,
} from "./import-canonical.js";
import type { LegacySourceRecord } from "./import-canonical.js";
import { IMPORT_RECORD_VERSION, refuseImport } from "./import-contract.js";
import type {
  ImportCounts,
  ImportProvenance,
  ImportRefused,
  ImportReport,
  ImportedClaim,
  LegacyLink,
} from "./import-contract.js";
import { reconcileImport } from "./import-reconcile.js";
import type { ReconcileEntry } from "./import-reconcile.js";
import type { SourceManifest } from "./source-manifest.js";

/**
 * Atomic application (design §21.7): "an interrupted import commits wholly or not at all".
 *
 * The whole import is ONE commit. The store already commits all-or-nothing under
 * BEGIN IMMEDIATE, with crash behaviour drilled by the projection rebuild work, so this
 * module COMPOSES that seam instead of inventing a second transaction discipline. If the
 * import does not fit in one commit it is REFUSED rather than split: splitting would
 * silently trade atomicity for capacity, and a half-imported project that reports success
 * is the exact failure §21.7 forbids.
 *
 * The port is declared structurally rather than imported from @moe/store. Keeping this
 * package dependency-free means the loadability gate has nothing to resolve, and the
 * migration suite still wires the REAL SqliteEventStore in, so the seam is exercised for
 * real rather than against a restatement of it.
 */

export interface ImportEventDraft {
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Uint8Array;
}

export interface ImportCommitInput {
  readonly aggregateId: string;
  readonly commandBytes: Uint8Array;
  readonly commandId: string;
  /** Deterministic, derived from the manifest. Never a clock read. */
  readonly committedAt: string;
  readonly events: readonly ImportEventDraft[];
  readonly expectedVersion: number;
}

export interface ImportCommitOutcome {
  readonly currentVersion: number;
}

export interface ImportStorePort {
  commit(input: ImportCommitInput): ImportCommitOutcome;
}

export interface ApplyImportInput {
  readonly declaredRecordCount: number | null;
  readonly knownFields: readonly string[];
  readonly manifest: SourceManifest;
  readonly maxEventsPerCommit: number;
  readonly records: readonly LegacySourceRecord[];
  readonly store: ImportStorePort;
}

export type ApplyImportResult = ImportRefused | ImportReport;

const ENCODER = new TextEncoder();

/** §21.4: a claim imports HISTORICAL, or SUSPENDED when the source said it was held. */
function claimFrom(record: LegacySourceRecord, provenance: ImportProvenance): ImportedClaim {
  const held = record.payload["held"] === true;
  return Object.freeze({
    claimId: deriveImportedId(provenance.manifestDigest, record),
    principal: typeof record.payload["owner"] === "string" ? record.payload["owner"] : "UNKNOWN",
    provenance,
    status: held ? "SUSPENDED" : "HISTORICAL",
  });
}

/** §21.5: containment and dependsOn import as evidence only, never as a hard edge. */
function linksFrom(
  record: LegacySourceRecord,
  provenance: ImportProvenance,
): readonly LegacyLink[] {
  const declared = record.payload["dependsOn"];
  const refs = Array.isArray(declared)
    ? declared.filter((value): value is string => typeof value === "string")
    : [];
  const contains = typeof record.payload["parent"] === "string"
    ? [Object.freeze({
        evidenceOnly: true as const,
        from: record.payload["parent"],
        kind: "CONTAINS" as const,
        provenance,
        to: record.legacyId,
      })]
    : [];
  return Object.freeze([
    ...contains,
    ...refs.map((ref) => Object.freeze({
      evidenceOnly: true as const,
      from: record.legacyId,
      kind: "RELATED" as const,
      provenance,
      to: ref,
    })),
  ]);
}

function eventFor(
  record: LegacySourceRecord,
  provenance: ImportProvenance,
  canonical: string,
): ImportEventDraft {
  return {
    eventId: deriveImportedId(provenance.manifestDigest, record),
    eventType: `legacy.${record.kind}.imported`,
    payload: ENCODER.encode(canonical),
  };
}

interface Resolved {
  readonly entries: readonly ReconcileEntry[];
  readonly events: readonly ImportEventDraft[];
}

/** Resolves provenance and canonical payload for every record, in canonical order. */
function resolve(input: ApplyImportInput): Resolved | ImportRefused {
  const entries: ReconcileEntry[] = [];
  const events: ImportEventDraft[] = [];
  for (const record of orderRecords(input.records)) {
    const provenance = deriveProvenance(input.manifest, record);
    if ("outcome" in provenance) return provenance;
    entries.push({ provenance, record });
    const canonical = canonicalPayload(record);
    // A record whose payload cannot be canonicalised is REPORTED by the reconciler as
    // CORRUPT_BYTES and carries no event; it is never guessed at and never dropped.
    if (typeof canonical === "string") {
      events.push(eventFor(record, provenance, canonical));
    }
  }
  return { entries, events };
}

/**
 * Runs the import as a single commit and returns the canonical report.
 *
 * `committedAt` is the manifest-bound provenance time of the import, so two runs over the
 * same bytes produce the same commit — a clock here would make every re-import differ.
 */
export function applyImport(input: ApplyImportInput): ApplyImportResult {
  const resolved = resolve(input);
  if ("outcome" in resolved) return resolved;
  const { entries, events } = resolved;
  if (events.length > input.maxEventsPerCommit) {
    return refuseImport(
      "IMPORT_TOO_LARGE_FOR_ONE_COMMIT",
      "APPLY",
      `${String(events.length)} events exceed the ${String(input.maxEventsPerCommit)} `
        + "per-commit bound; splitting would trade atomicity for capacity",
    );
  }
  const report = reconcileImport({
    declaredRecordCount: input.declaredRecordCount,
    entries,
    knownFields: input.knownFields,
    sourcePaths: input.manifest.entries.map((entry) => entry.path),
  });
  const claims = entries.map((entry) => claimFrom(entry.record, entry.provenance));
  const links = entries.flatMap((entry) => linksFrom(entry.record, entry.provenance));
  const counts: ImportCounts = Object.freeze({
    claims: claims.length,
    links: links.length,
    reconciliations: report.findings.length,
    sourceFiles: input.manifest.entries.length,
  });
  try {
    input.store.commit({
      aggregateId: `legacy-import:${input.manifest.digest}`,
      commandBytes: ENCODER.encode(canonicalDigest({ counts, manifest: input.manifest.digest })),
      commandId: canonicalDigest({ manifest: input.manifest.digest, version: IMPORT_RECORD_VERSION }),
      committedAt: importCommittedAt(entries),
      events,
      expectedVersion: 0,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return refuseImport("IMPORT_COMMIT_FAILED", "APPLY", detail);
  }
  return Object.freeze({
    claims: Object.freeze(claims),
    counts,
    links: Object.freeze(links),
    manifestDigest: input.manifest.digest,
    reconciliations: report.findings,
    recordVersion: IMPORT_RECORD_VERSION,
  });
}

/** The latest source-declared time, or the sentinel. Deterministic either way. */
function importCommittedAt(entries: readonly ReconcileEntry[]): string {
  let latest = "";
  for (const entry of entries) {
    if (entry.provenance.sourceTime > latest) latest = entry.provenance.sourceTime;
  }
  return latest === "" ? "1970-01-01T00:00:00.000Z" : latest;
}
