import { byCodeUnit } from "./canonical-bytes.js";
import { canonicalPayload } from "./import-canonical.js";
import type { LegacySourceRecord } from "./import-canonical.js";
import { AMBIGUITY_OUTCOME, DETERMINISTIC_TIME_SENTINEL } from "./import-contract.js";
import type { AmbiguityClass, ImportProvenance, ReconciliationFinding } from "./import-contract.js";
import { duplicateIdentityFindings } from "./import-duplicate-identity.js";
import { graphFindings } from "./import-reconcile-graph.js";
import { SKILL_PAYLOAD_KEY, classifySkillAsset, readSkillIdentity } from "./import-skill-assets.js";

/**
 * Ambiguity classification (design §21.6, plus this task's roadmap amendment).
 *
 * §21.6: "Report exact counts, unknown fields, dangling refs, cycles, split ownership,
 * corrupt/invalid bytes, and case/path conflicts. Ambiguity becomes NEEDS_RECONCILIATION,
 * never a guess."
 *
 * This module NEVER THROWS and never drops a record. An ambiguous record is reported and
 * the import still completes, because an importer that aborts on the first oddity cannot
 * tell an operator how much of their legacy project is importable.
 */

export interface ReconcileEntry {
  readonly provenance: ImportProvenance;
  readonly record: LegacySourceRecord;
}

export interface ReconcileInput {
  /** What the source itself claimed it contained, or null when it claimed nothing. */
  readonly declaredRecordCount: number | null;
  readonly entries: readonly ReconcileEntry[];
  readonly knownFields: readonly string[];
  /** Every path in the manifest, so a conflict between two files is visible here. */
  readonly sourcePaths: readonly string[];
}

export interface ReconcileReport {
  readonly findings: readonly ReconciliationFinding[];
}

function finding(
  ambiguityClass: AmbiguityClass,
  provenance: ImportProvenance,
  detail: string,
): ReconciliationFinding {
  return Object.freeze({ ambiguityClass, detail, outcome: AMBIGUITY_OUTCOME, provenance });
}

/**
 * Skill payloads carry their descriptor under `skill`, which is not a task field. Adding
 * it to the allowed set for that kind keeps the check honest rather than exempting skill
 * records from unknown-field detection entirely.
 */
function allowedFields(record: LegacySourceRecord, known: readonly string[]): readonly string[] {
  return SKILL_PAYLOAD_KEY in record.payload ? [...known, SKILL_PAYLOAD_KEY] : known;
}

function unknownFieldFindings(entry: ReconcileEntry, known: readonly string[]): ReconciliationFinding[] {
  const allowed = allowedFields(entry.record, known);
  return Object.keys(entry.record.payload)
    .filter((field) => !allowed.includes(field))
    .sort(byCodeUnit)
    .map((field) => finding(
      "UNKNOWN_FIELD",
      entry.provenance,
      `record ${entry.record.legacyId} carries unknown field ${field}`,
    ));
}

function corruptByteFindings(entry: ReconcileEntry): readonly ReconciliationFinding[] {
  const canonical = canonicalPayload(entry.record);
  if (typeof canonical === "string") return [];
  return [finding("CORRUPT_BYTES", entry.provenance, canonical.detail)];
}

/** Two paths that differ only by case cannot coexist on NTFS; one would overwrite the other. */
function casePathFindings(
  sourcePaths: readonly string[],
  provenance: ImportProvenance,
): readonly ReconciliationFinding[] {
  const seen = new Map<string, string>();
  const found: ReconciliationFinding[] = [];
  for (const path of [...sourcePaths].sort(byCodeUnit)) {
    const folded = path.toLowerCase();
    const first = seen.get(folded);
    if (first !== undefined && first !== path) {
      found.push(finding(
        "CASE_PATH_CONFLICT",
        provenance,
        `${first} and ${path} differ only by case and cannot coexist on a case-insensitive filesystem`,
      ));
      continue;
    }
    if (first === undefined) seen.set(folded, path);
  }
  return found;
}

function splitOwnershipFindings(entries: readonly ReconcileEntry[]): readonly ReconciliationFinding[] {
  const owners = new Map<string, Map<string, ImportProvenance>>();
  for (const entry of entries) {
    const owner = entry.record.payload["owner"];
    if (typeof owner !== "string") continue;
    const byOwner = owners.get(entry.record.legacyId) ?? new Map<string, ImportProvenance>();
    if (!byOwner.has(owner)) byOwner.set(owner, entry.provenance);
    owners.set(entry.record.legacyId, byOwner);
  }
  const found: ReconciliationFinding[] = [];
  for (const legacyId of [...owners.keys()].sort(byCodeUnit)) {
    const byOwner = owners.get(legacyId);
    if (byOwner === undefined || byOwner.size < 2) continue;
    const names = [...byOwner.keys()].sort(byCodeUnit);
    const provenance = byOwner.get(names[0] ?? "");
    if (provenance === undefined) continue;
    found.push(finding(
      "SPLIT_OWNERSHIP",
      provenance,
      `record ${legacyId} is claimed by ${names.join(" and ")}`,
    ));
  }
  return found;
}

function skillAmbiguityFindings(entries: readonly ReconcileEntry[]): readonly ReconciliationFinding[] {
  const seen = new Map<string, ImportProvenance>();
  const found: ReconciliationFinding[] = [];
  for (const entry of entries) {
    const identity = readSkillIdentity(entry.record);
    if (identity === null) continue;
    const key = `${identity.legacyId}@${identity.version}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, entry.provenance);
      continue;
    }
    found.push(finding(
      "SKILL_AMBIGUOUS",
      entry.provenance,
      `skill ${key} is declared by both ${first.sourcePath} and ${entry.provenance.sourcePath}`,
    ));
  }
  return found;
}

/**
 * Provenance for the one finding no read record can lend it to: the source declared
 * records and ZERO were read. There is no source file to cite, so every field is an
 * explicit empty/sentinel value rather than fabricated evidence — an empty digest can
 * never match a real hash, and the sentinel time keeps the finding deterministic.
 */
const NO_RECORDS_PROVENANCE: ImportProvenance = Object.freeze({
  manifestDigest: "",
  sourceDigest: "",
  sourcePath: "",
  sourceTime: DETERMINISTIC_TIME_SENTINEL,
  timeBasis: "MANIFEST_SENTINEL",
});

function countFindings(input: ReconcileInput): readonly ReconciliationFinding[] {
  const { declaredRecordCount, entries } = input;
  if (declaredRecordCount === null || declaredRecordCount === entries.length) return [];
  // Zero entries is the TOTAL-LOSS mismatch — every declared record dropped upstream —
  // which is the one count mismatch that must never be swallowed for lack of an entry.
  return [finding(
    "COUNT_MISMATCH",
    entries[0]?.provenance ?? NO_RECORDS_PROVENANCE,
    `source declared ${String(declaredRecordCount)} records; ${String(entries.length)} were read`,
  )];
}

/** Stable output order, so two runs over the same source report findings identically. */
function compareFindings(left: ReconciliationFinding, right: ReconciliationFinding): number {
  const byPath = byCodeUnit(left.provenance.sourcePath, right.provenance.sourcePath);
  if (byPath !== 0) return byPath;
  const byClass = byCodeUnit(left.ambiguityClass, right.ambiguityClass);
  if (byClass !== 0) return byClass;
  return byCodeUnit(left.detail, right.detail);
}

export function reconcileImport(input: ReconcileInput): ReconcileReport {
  const { entries, knownFields, sourcePaths } = input;
  const first = entries[0];
  const found: ReconciliationFinding[] = [...countFindings(input)];
  for (const entry of entries) {
    found.push(...unknownFieldFindings(entry, knownFields));
    found.push(...corruptByteFindings(entry));
    found.push(...classifySkillAsset(entry.record, entry.provenance));
  }
  found.push(...splitOwnershipFindings(entries));
  found.push(...duplicateIdentityFindings(entries));
  found.push(...skillAmbiguityFindings(entries));
  found.push(...graphFindings(entries));
  if (first !== undefined) {
    found.push(...casePathFindings(sourcePaths, first.provenance));
  }
  return Object.freeze({ findings: Object.freeze(found.sort(compareFindings)) });
}
