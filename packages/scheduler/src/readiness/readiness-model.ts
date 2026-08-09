/**
 * Readiness vocabulary for design 8.2. TYPES AND CONSTANTS ONLY — nothing here
 * derives readiness, classifies a node, or reads a caller fact. Derivation
 * lives in ./readiness-facts.ts and ./readiness-projection.ts; classification
 * lives in ./readiness-explanation.ts.
 *
 * Reused, never redeclared: `BlockedReason` / `BlockedNode` /
 * `BlockedReasonCode` come from ../graph-model.js and `DependencyFactBinding`
 * (the exact source-ref/version/digest provenance triple) from
 * ../dependencies/dependency-contract.js. Both modules are outside this task's
 * owned path and are never edited from here.
 */
import type { DependencyFactBinding } from "../dependencies/dependency-contract.js";
import type { BlockedReasonCode, GraphIssueCode, GraphKey } from "../graph-model.js";

/**
 * Design 8.2's explanation classes. Only a DISPATCHABLE node is `READY_NOW`.
 * `UNBLOCK_NEXT` requires exactly one outstanding confirmation AND a known
 * producer/recovery command. `INTENTIONAL_WAIT` requires a CURRENT wait record.
 * Everything missing, stale, incompatible or unresolvable is
 * `UNSAFE_OR_UNKNOWN` — the conservative bucket, which also absorbs a node
 * with more than one outstanding confirmation, because "UI optimism cannot
 * place it nearer to ready".
 */
export const READINESS_CLASSES = Object.freeze([
  "READY_NOW",
  "UNBLOCK_NEXT",
  "INTENTIONAL_WAIT",
  "UNSAFE_OR_UNKNOWN",
] as const);
export type ReadinessClass = (typeof READINESS_CLASSES)[number];

/**
 * Presentation order, ascending. Lower sorts nearer to ready. A multi-predicate
 * node lands in UNSAFE_OR_UNKNOWN and therefore can never be ordered ahead of a
 * genuine one-step (`UNBLOCK_NEXT`) item.
 */
export const READINESS_CLASS_RANK: Readonly<Record<ReadinessClass, number>> =
  Object.freeze({
    READY_NOW: 0,
    UNBLOCK_NEXT: 1,
    INTENTIONAL_WAIT: 2,
    UNSAFE_OR_UNKNOWN: 3,
  });

/** The three predicates of design 8.2, never collapsed into one bit. */
export const READINESS_LAYERS = Object.freeze([
  "LOGICAL",
  "ADMISSION",
  "DISPATCH",
] as const);
export type ReadinessLayer = (typeof READINESS_LAYERS)[number];

/**
 * Three arms, never a boolean. graph-model.ts:256 states that `false` must
 * never encode UNKNOWN; with a boolean that is a convention someone has to
 * remember, with three arms it is a type error. `CONFIRMED_FALSE` is a positive
 * claim the caller made; absent/malformed/stale truth is `UNKNOWN`.
 */
export const FACT_CONFIDENCES = Object.freeze([
  "CONFIRMED_TRUE",
  "CONFIRMED_FALSE",
  "UNKNOWN",
] as const);
export type FactConfidence = (typeof FACT_CONFIDENCES)[number];

/** Design 8.2 admission inputs: what must permit a claim. */
export const ADMISSION_REASON_CODES = Object.freeze([
  "READINESS_PHASE_OWNERSHIP",
  "READINESS_EXACT_PLAN",
  "READINESS_INPUT_MANIFEST",
  "READINESS_CONTEXT",
  "READINESS_DOWNSTREAM_PROOF_BUDGET",
  "READINESS_CAPABILITY",
  "READINESS_RISK_POLICY",
] as const);

/** Design 8.2 dispatch inputs: resources, one slot, and the four holds. */
export const DISPATCH_REASON_CODES = Object.freeze([
  "READINESS_RESOURCE_CONFIRMED_ACTIVE",
  "READINESS_PROVIDER_SLOT_RESERVABLE",
  "READINESS_NO_ACTIVE_LEASE",
  "READINESS_NO_PAUSE",
  "READINESS_NO_SUPERSESSION",
  "READINESS_NO_RECONCILIATION_HOLD",
] as const);

/**
 * Structural readiness codes this engine emits itself rather than reading from
 * a caller fact. `READINESS_NOT_EXECUTION_BEARING` records that an advisory or
 * organizational node has NO execution authority (design 8.3 rule 5). Logical-
 * layer blockers keep their landed `BlockedReasonCode` and are never re-coded
 * under a readiness synonym.
 */
export const STRUCTURAL_REASON_CODES = Object.freeze([
  "READINESS_NOT_EXECUTION_BEARING",
] as const);

/** The closed typed-reason vocabulary. Every member must stay reachable. */
export const READINESS_REASON_CODES = Object.freeze([
  ...ADMISSION_REASON_CODES,
  ...DISPATCH_REASON_CODES,
  ...STRUCTURAL_REASON_CODES,
] as const);
export type ReadinessReasonCode = (typeof READINESS_REASON_CODES)[number];

/** Single source of truth for which layer owns each code. */
export const READINESS_REASON_LAYERS: Readonly<
  Record<ReadinessReasonCode, ReadinessLayer>
> = Object.freeze({
  READINESS_PHASE_OWNERSHIP: "ADMISSION",
  READINESS_EXACT_PLAN: "ADMISSION",
  READINESS_INPUT_MANIFEST: "ADMISSION",
  READINESS_CONTEXT: "ADMISSION",
  READINESS_DOWNSTREAM_PROOF_BUDGET: "ADMISSION",
  READINESS_CAPABILITY: "ADMISSION",
  READINESS_RISK_POLICY: "ADMISSION",
  READINESS_RESOURCE_CONFIRMED_ACTIVE: "DISPATCH",
  READINESS_PROVIDER_SLOT_RESERVABLE: "DISPATCH",
  READINESS_NO_ACTIVE_LEASE: "DISPATCH",
  READINESS_NO_PAUSE: "DISPATCH",
  READINESS_NO_SUPERSESSION: "DISPATCH",
  READINESS_NO_RECONCILIATION_HOLD: "DISPATCH",
  READINESS_NOT_EXECUTION_BEARING: "LOGICAL",
});

/**
 * Which supplied fact backed this reason. `null` is the honest answer when no
 * fact was supplied at all — an absent fact has no ref, version or digest, and
 * inventing one would be the same error as encoding UNKNOWN as `false`.
 */
export type ReadinessProvenance = DependencyFactBinding | null;

/**
 * One typed reason with its provenance. `confidence` distinguishes "the caller
 * confirmed this predicate false" from "nobody knows" — a consumer that only
 * saw the code could not tell not-ready from not-known.
 */
export interface ReadinessReason {
  readonly code: ReadinessReasonCode | BlockedReasonCode;
  readonly layer: ReadinessLayer;
  readonly confidence: FactConfidence;
  readonly nodeKey: GraphKey;
  /** The offending HARD edge, when the reason is a logical-layer blocker. */
  readonly edgeKey: GraphKey | null;
  readonly provenance: ReadinessProvenance;
  /** Producer node or recovery command; `null` means it is not known. */
  readonly recoveryRef: string | null;
}

/**
 * Design 8.2's legal choices when a predecessor failed. Recorded for review;
 * this engine performs none of them.
 */
export const LEGAL_CHOICES = Object.freeze([
  "RETRY_PREDECESSOR",
  "SUBSTITUTE_COMPATIBLE_APPROVED_RESULT",
  "PROPOSE_SUPERSEDING_REWIRE",
  "CANCEL",
] as const);
export type LegalChoice = (typeof LEGAL_CHOICES)[number];

/** Stable refusal codes for a structurally unusable readiness input. */
export const READINESS_ISSUE_CODES = Object.freeze([
  "READINESS_INPUT_MALFORMED",
  "READINESS_NODE_FACTS_MISSING",
  "READINESS_NODE_FACTS_DUPLICATE",
  "READINESS_NODE_FACTS_UNKNOWN_NODE",
] as const);
export type ReadinessIssueCode = (typeof READINESS_ISSUE_CODES)[number];

export interface ReadinessIssue {
  /**
   * A readiness-local code, or a landed `GRAPH_*`/`FRONTIER_*` code passed
   * through unchanged. A structural refusal is NEVER re-coded under a
   * readiness synonym, following the admission-model precedent.
   */
  readonly code: ReadinessIssueCode | GraphIssueCode;
  readonly message: string;
  readonly nodeKeys: readonly GraphKey[];
}

/** Why the three-layer partition was withheld, per graph-model.ts:252-260. */
export type ReadinessWithholdReason = "AVAILABILITY_UNKNOWN";

/**
 * The caller-supplied predicate set: every admission and dispatch input of
 * design 8.2. Structural codes are excluded because this engine emits them
 * itself and a caller may not assert one.
 */
export const CALLER_FACT_CODES = Object.freeze([
  ...ADMISSION_REASON_CODES,
  ...DISPATCH_REASON_CODES,
] as const);
export type CallerFactCode = (typeof CALLER_FACT_CODES)[number];
