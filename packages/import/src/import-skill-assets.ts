import { isPlainRecord } from "./canonical-bytes.js";
import { AMBIGUITY_OUTCOME } from "./import-contract.js";
import type { AmbiguityClass, ImportProvenance, ReconciliationFinding } from "./import-contract.js";
import type { LegacySourceRecord } from "./import-canonical.js";

/**
 * Skill-asset classification for the 2026-08-07 roadmap amendment recorded on this task:
 * copied legacy `.moe/skills` content may be imported only through the versioned skill
 * contract, and malformed, ambiguous, missing-license, unsupported-script and escaping
 * assets must be classified "without blessing or executing them".
 *
 * NOTHING HERE EXECUTES ANYTHING. A declared script is evidence to be reported, never a
 * thing to run, and this module holds no spawn, no import(), and no eval. "Without
 * blessing" is equally structural: every outcome is NEEDS_RECONCILIATION, and this module
 * cannot produce an importable skill at all.
 */

/** The key a legacy record uses to carry its skill descriptor. */
export const SKILL_PAYLOAD_KEY = "skill" as const;

export interface SkillIdentity {
  readonly legacyId: string;
  readonly version: string;
}

function finding(
  ambiguityClass: AmbiguityClass,
  provenance: ImportProvenance,
  detail: string,
): ReconciliationFinding {
  return Object.freeze({ ambiguityClass, detail, outcome: AMBIGUITY_OUTCOME, provenance });
}

/**
 * A path escapes when it is absolute, has a drive letter, or contains a `..` SEGMENT.
 *
 * Segment-wise rather than `includes("..")`, because a file legitimately named `..bak`
 * contains the substring without escaping anything, and refusing it would be a false
 * positive on real content.
 */
export function escapesSkillDirectory(assetPath: string): boolean {
  if (assetPath.startsWith("/") || assetPath.startsWith("\\")) return true;
  if (/^[a-zA-Z]:/u.test(assetPath)) return true;
  return assetPath.split(/[\\/]/u).includes("..");
}

/** The skill descriptor, or null when the record does not carry a structured one. */
export function readSkillDescriptor(
  record: LegacySourceRecord,
): Record<string, unknown> | null {
  const descriptor = record.payload[SKILL_PAYLOAD_KEY];
  return isPlainRecord(descriptor) ? descriptor : null;
}

/** The identity two skill assets would collide on, when both declare one. */
export function readSkillIdentity(record: LegacySourceRecord): SkillIdentity | null {
  const descriptor = readSkillDescriptor(record);
  if (descriptor === null) return null;
  const version = descriptor["version"];
  return typeof version === "string" ? { legacyId: record.legacyId, version } : null;
}

/**
 * Per-record skill classification. Cross-record ambiguity (two assets claiming one
 * identity) needs the whole set and is detected by the reconciler instead.
 */
export function classifySkillAsset(
  record: LegacySourceRecord,
  provenance: ImportProvenance,
): readonly ReconciliationFinding[] {
  if (!(SKILL_PAYLOAD_KEY in record.payload)) return [];
  const descriptor = readSkillDescriptor(record);
  if (descriptor === null) {
    return [finding(
      "SKILL_MALFORMED",
      provenance,
      `skill asset ${record.legacyId} does not carry a structured descriptor`,
    )];
  }
  const found: ReconciliationFinding[] = [];
  if (typeof descriptor["license"] !== "string") {
    found.push(finding(
      "SKILL_MISSING_LICENSE",
      provenance,
      `skill asset ${record.legacyId} declares no license`,
    ));
  }
  if (descriptor["script"] !== undefined) {
    found.push(finding(
      "SKILL_UNSUPPORTED_SCRIPT",
      provenance,
      `skill asset ${record.legacyId} declares script ${String(descriptor["script"])}, `
        + "which is reported and never executed",
    ));
  }
  const assets = descriptor["assets"];
  if (Array.isArray(assets)) {
    for (const asset of assets) {
      if (typeof asset === "string" && escapesSkillDirectory(asset)) {
        found.push(finding(
          "SKILL_ESCAPING_ASSET",
          provenance,
          `skill asset ${record.legacyId} references ${asset} outside its directory`,
        ));
      }
    }
  }
  return found;
}
