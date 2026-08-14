/**
 * Closed vocabulary for the deterministic legacy importer (design §21.2-§21.7).
 *
 * Everything here is frozen data or a type. There is no clock, no random source, no I/O
 * and no logic: a single `Date.now()` anywhere in this package would make §21.7's
 * "identical bytes produce identical canonical hashes" unprovable.
 *
 * Two guarantees are enforced by the TYPES rather than by a runtime check, because a
 * check can be bypassed and a missing arm cannot be constructed at all:
 *   - §21.4 never activate — `ImportedClaimStatus` has no ACTIVE arm.
 *   - §21.5 links are evidence — `LegacyLink.evidenceOnly` is the literal `true`, and no
 *     arm expresses a hard edge, blocker, or hold.
 */

/** Bumped when the manifest's canonical shape changes; it binds every derived id. */
export const SOURCE_MANIFEST_VERSION = "moe-import-source-manifest/1" as const;

/** Bumped when the canonical import record's shape changes. */
export const IMPORT_RECORD_VERSION = "moe-import-record/1" as const;

/**
 * The provenance time used when a source record declares none (§21.7's "manifest-defined
 * deterministic sentinel"). A fixed literal rather than any observed instant, so the same
 * bytes yield the same provenance on every machine and every run.
 */
export const DETERMINISTIC_TIME_SENTINEL = "1970-01-01T00:00:00.000Z" as const;

/**
 * The seven reportable ambiguity classes of design §21.6, in the order the design lists
 * them. Kept as its own frozen list so the "all seven are detected" assertion is pinned
 * against the design rather than against whatever the implementation grew.
 */
export const DESIGN_AMBIGUITY_CLASSES = Object.freeze([
  "COUNT_MISMATCH",
  "UNKNOWN_FIELD",
  "DANGLING_REF",
  "CYCLE",
  "SPLIT_OWNERSHIP",
  "CORRUPT_BYTES",
  "CASE_PATH_CONFLICT",
] as const);

/**
 * The roadmap amendment of 2026-08-07 recorded on this task: copied legacy `.moe/skills`
 * content may be imported only through the versioned skill contract, and malformed,
 * ambiguous, missing-license, unsupported-script and escaping assets must be CLASSIFIED
 * "without blessing or executing them".
 *
 * Separate from the design seven because they come from a different authority; both lists
 * are asserted independently so neither can absorb the other's coverage.
 */
export const SKILL_ASSET_AMBIGUITY_CLASSES = Object.freeze([
  "SKILL_MALFORMED",
  "SKILL_AMBIGUOUS",
  "SKILL_MISSING_LICENSE",
  "SKILL_UNSUPPORTED_SCRIPT",
  "SKILL_ESCAPING_ASSET",
] as const);

/**
 * Derived-identity ambiguity. Its authority is this package's own canonical-derivation
 * contract rather than §21.6's seven or the skill amendment's five: `deriveImportedId`
 * digests only (kind, legacyId, sourcePath) plus the manifest, so two records sharing
 * that tuple with DIFFERENT payloads would import onto one id and silently
 * last-writer-win — a guess §21.6 forbids. A separate frozen list, same as the other two
 * authorities, so none can absorb another's coverage.
 */
export const DERIVED_IDENTITY_AMBIGUITY_CLASSES = Object.freeze(["DUPLICATE_IDENTITY"] as const);

export const AMBIGUITY_CLASSES = Object.freeze([
  ...DESIGN_AMBIGUITY_CLASSES,
  ...SKILL_ASSET_AMBIGUITY_CLASSES,
  ...DERIVED_IDENTITY_AMBIGUITY_CLASSES,
] as const);

export type AmbiguityClass = (typeof AMBIGUITY_CLASSES)[number];

/**
 * §21.6: "Ambiguity becomes NEEDS_RECONCILIATION, never a guess." One outcome, declared
 * once. A second arm here would be a place for a guess to hide.
 */
export const AMBIGUITY_OUTCOME = "NEEDS_RECONCILIATION" as const;

/**
 * Which layer refused. More than one can, so tests must pin which.
 *
 * Listed in pipeline order. DECODE sits between MANIFEST and CANONICAL because a decoder
 * turns manifest-covered bytes into records, so its refusals precede any canonicalisation.
 * SHADOW is last and is ADVISORY: it compares an already-imported projection against a
 * new-side one and can therefore never be on the path that writes anything.
 */
export const IMPORT_REFUSAL_LAYERS = Object.freeze([
  "INPUT",
  "MANIFEST",
  "DECODE",
  "CANONICAL",
  "APPLY",
  "SHADOW",
] as const);

export type ImportRefusalLayer = (typeof IMPORT_REFUSAL_LAYERS)[number];

/**
 * Every code has a planned emitter; an unreachable code is a claim no test can pin.
 *
 * The four DECODE codes are deliberately distinct rather than one "bad file" code. They
 * answer different operator questions and must never be able to stand in for each other:
 * MALFORMED means the bytes are not the shape they claim, UNSUPPORTED means this decoder
 * version knowingly declines a real shape, AMBIGUOUS means the bytes admit more than one
 * reading (§21.6's "never a guess"), and DIGEST_MISMATCH means the file changed after the
 * manifest hashed it — the one case where the bytes are fine and the evidence is not.
 */
export const IMPORT_REFUSAL_CODES = Object.freeze([
  "IMPORT_COMMIT_FAILED",
  "IMPORT_MANIFEST_EMPTY",
  "IMPORT_RECORD_UNCANONICAL",
  "IMPORT_ROOT_INVALID",
  "IMPORT_SHADOW_FIELD_UNMAPPED",
  "IMPORT_SOURCE_AMBIGUOUS",
  "IMPORT_SOURCE_DIGEST_MISMATCH",
  "IMPORT_SOURCE_MALFORMED",
  "IMPORT_SOURCE_UNREADABLE",
  "IMPORT_SOURCE_UNSUPPORTED",
  "IMPORT_TOO_LARGE_FOR_ONE_COMMIT",
] as const);

export type ImportRefusalCode = (typeof IMPORT_REFUSAL_CODES)[number];

export interface ImportRefused {
  readonly code: ImportRefusalCode;
  readonly detail: string;
  readonly layer: ImportRefusalLayer;
  readonly outcome: "REFUSED";
}

export function refuseImport(
  code: ImportRefusalCode,
  layer: ImportRefusalLayer,
  detail: string,
): ImportRefused {
  return Object.freeze({ code, detail, layer, outcome: "REFUSED" as const });
}

/** Whether a provenance time is the source's own or the deterministic sentinel. */
export const TIME_BASES = Object.freeze(["SOURCE_DECLARED", "MANIFEST_SENTINEL"] as const);

export type TimeBasis = (typeof TIME_BASES)[number];

/**
 * §21.3: raw source digest and import provenance are preserved for every imported record.
 * `manifestDigest` binds the record to the exact source tree it came from, which is what
 * makes a re-import of identical bytes provably the same import rather than a coincidence.
 */
export interface ImportProvenance {
  readonly manifestDigest: string;
  readonly sourceDigest: string;
  readonly sourcePath: string;
  readonly sourceTime: string;
  readonly timeBasis: TimeBasis;
}

/**
 * §21.4: "Never activate a legacy assignment/resource claim. Import it as
 * historical/suspended and require an authenticated new lease."
 *
 * There is deliberately NO ACTIVE arm. `never activate` is therefore not a rule this
 * package remembers to apply — it is a state the type cannot express.
 */
export const IMPORTED_CLAIM_STATUSES = Object.freeze(["HISTORICAL", "SUSPENDED"] as const);

export type ImportedClaimStatus = (typeof IMPORTED_CLAIM_STATUSES)[number];

export interface ImportedClaim {
  readonly claimId: string;
  readonly principal: string;
  readonly provenance: ImportProvenance;
  readonly status: ImportedClaimStatus;
}

/**
 * §21.5: legacy containment and dependsOn-style links import ONLY as historical
 * CONTAINS|RELATED evidence, and "none becomes a hard edge, blocker, or hold without a
 * new typed DependencyContract and the current approval path".
 *
 * `evidenceOnly` is the literal `true`, not `boolean`, so no call site can construct a
 * link that claims to be anything stronger.
 */
export const LEGACY_LINK_KINDS = Object.freeze(["CONTAINS", "RELATED"] as const);

export type LegacyLinkKind = (typeof LEGACY_LINK_KINDS)[number];

export interface LegacyLink {
  readonly evidenceOnly: true;
  readonly from: string;
  readonly kind: LegacyLinkKind;
  readonly provenance: ImportProvenance;
  readonly to: string;
}

/** One record the importer could not import unambiguously. Never dropped, never guessed. */
export interface ReconciliationFinding {
  readonly ambiguityClass: AmbiguityClass;
  readonly detail: string;
  readonly outcome: typeof AMBIGUITY_OUTCOME;
  readonly provenance: ImportProvenance;
}

/** §21.6's "report exact counts". Every number is a safe integer. */
export interface ImportCounts {
  readonly claims: number;
  readonly links: number;
  readonly reconciliations: number;
  readonly sourceFiles: number;
}

export interface ImportReport {
  readonly claims: readonly ImportedClaim[];
  readonly counts: ImportCounts;
  readonly links: readonly LegacyLink[];
  readonly manifestDigest: string;
  readonly reconciliations: readonly ReconciliationFinding[];
  readonly recordVersion: typeof IMPORT_RECORD_VERSION;
}
