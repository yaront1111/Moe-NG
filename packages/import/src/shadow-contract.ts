import type { ImportRefused, ImportedClaim, LegacyLink } from "./import-contract.js";

/**
 * The versioned shadow projection (design §21.8): compare what the legacy project SAYS
 * against what the new side shows, and report the differences. Advisory only.
 *
 * WHY THIS DECLARES ITS OWN TARGET VOCABULARY. The obvious reading of "the frozen new
 * projection vocabulary" is the daemon's BoardProjection, and importing it was rejected
 * deliberately: @moe/import declares zero dependencies and is a pure leaf, while
 * apps/daemon sits at the top of the graph with eight workspace dependencies of its own.
 * Depending on it would invert the graph and create a cycle the moment the daemon wants
 * to consume the importer. So the target vocabulary is declared HERE and VERSIONED, and
 * the comparison runs over plain data both sides supply. Drift from the real projection
 * therefore surfaces as a visible version mismatch at the consumer rather than as a
 * silent disagreement — and a comparator that takes data cannot reach an authority-
 * bearing store by construction.
 *
 * NOTHING HERE ACTIVATES ANYTHING. Every mismatch is disposed NEEDS_RECONCILIATION or
 * UNKNOWN, and the disposition vocabulary has no third arm to widen into. There is no
 * clock and no random source, and the mismatch order is total, so two runs over identical
 * input produce byte-identical output.
 */


/** Bumped when the target vocabulary or the mismatch shape changes. */
export const SHADOW_PROJECTION_VERSION = "moe-shadow-projection/1" as const;

/** The new-side entity kinds this version maps legacy facts onto. */
export const SHADOW_ENTITY_KINDS = Object.freeze(["BLOCKER", "CLAIM", "LINK"] as const);

export type ShadowEntityKind = (typeof SHADOW_ENTITY_KINDS)[number];

/**
 * The fields each kind may carry. A field outside this vocabulary is REPORTED as
 * unmapped rather than compared: comparing a field neither side's contract declares
 * would manufacture agreement out of two unrelated values.
 */
export const SHADOW_ENTITY_FIELDS = Object.freeze({
  BLOCKER: Object.freeze(["basis", "holder"] as const),
  CLAIM: Object.freeze(["principal", "sourcePath", "status"] as const),
  LINK: Object.freeze(["evidenceOnly", "from", "kind", "to"] as const),
});

/** The field name an entity-level mismatch carries, so every mismatch is keyed alike. */
export const SHADOW_WHOLE_ENTITY_FIELD = "*" as const;

export const SHADOW_MISMATCH_KINDS = Object.freeze([
  "ENTITY_ABSENT_ON_CURRENT",
  "ENTITY_ABSENT_ON_LEGACY",
  "FIELD_ABSENT_ON_CURRENT",
  "FIELD_ABSENT_ON_LEGACY",
  "FIELD_DIFFERS",
  "FIELD_UNMAPPED",
] as const);

export type ShadowMismatchKind = (typeof SHADOW_MISMATCH_KINDS)[number];

/** Two arms, and neither one activates. There is deliberately no RESOLVED or ACCEPTED. */
export const SHADOW_DISPOSITIONS = Object.freeze(["NEEDS_RECONCILIATION", "UNKNOWN"] as const);

export type ShadowDisposition = (typeof SHADOW_DISPOSITIONS)[number];

/**
 * Which disposition each mismatch kind carries, declared once as data.
 *
 * A fact the legacy project asserted and the new side lacks NEEDS_RECONCILIATION. A fact
 * only the new side has is UNKNOWN to this comparison rather than a legacy defect.
 */
export const SHADOW_MISMATCH_DISPOSITIONS: Readonly<Record<ShadowMismatchKind, ShadowDisposition>> =
  Object.freeze({
    ENTITY_ABSENT_ON_CURRENT: "NEEDS_RECONCILIATION",
    ENTITY_ABSENT_ON_LEGACY: "UNKNOWN",
    FIELD_ABSENT_ON_CURRENT: "NEEDS_RECONCILIATION",
    FIELD_ABSENT_ON_LEGACY: "UNKNOWN",
    FIELD_DIFFERS: "NEEDS_RECONCILIATION",
    FIELD_UNMAPPED: "UNKNOWN",
  });

/** Field values are canonical TEXT on both sides, so a comparison never coerces. */
export interface ShadowEntity {
  readonly fields: Readonly<Record<string, string>>;
  readonly id: string;
  readonly kind: ShadowEntityKind;
}

export interface ShadowProjection {
  readonly entities: readonly ShadowEntity[];
  readonly version: typeof SHADOW_PROJECTION_VERSION;
}

export interface ShadowMismatch {
  readonly currentValue: string | null;
  readonly disposition: ShadowDisposition;
  readonly entityId: string;
  readonly entityKind: string;
  readonly field: string;
  readonly legacyValue: string | null;
  readonly mismatchKind: ShadowMismatchKind;
}

export interface ShadowComparison {
  readonly mismatches: readonly ShadowMismatch[];
  /** One typed refusal per unmapped field, so the code and layer are never inferred. */
  readonly refusals: readonly ImportRefused[];
  readonly version: typeof SHADOW_PROJECTION_VERSION;
}

export interface LegacyImportFacts {
  readonly claims: readonly ImportedClaim[];
  readonly links: readonly LegacyLink[];
}
