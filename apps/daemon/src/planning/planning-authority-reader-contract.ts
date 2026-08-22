/**
 * The closed refusal vocabulary of the durable approved-plan / criteria readers (task-47b2dbc6).
 *
 * Split from `planning-authority-reader.ts` so that file stays a chain of checks rather than a
 * chain of checks plus a roster; the two are read for different reasons.
 *
 * Each code names WHICH check answered, and `source` carries the code+layer of a LOWER authority
 * when one answered first — a core body codec or the envelope codec. Restamping their verdicts
 * into this vocabulary would hide which layer refused, so the reader never does it; it only ever
 * says "the bodies did not admit" and hands the real refusal along underneath.
 */
export const PLANNING_AUTHORITY_READER_CODES = Object.freeze([
  "PLANNING_AUTHORITY_READER_APPROVAL_ABSENT",
  "PLANNING_AUTHORITY_READER_APPROVAL_AMBIGUOUS",
  "PLANNING_AUTHORITY_READER_APPROVAL_MALFORMED",
  "PLANNING_AUTHORITY_READER_LEGACY_UNBOUND",
  "PLANNING_AUTHORITY_READER_LOCATOR_MISMATCH",
  "PLANNING_AUTHORITY_READER_PROJECT_MISMATCH",
  "PLANNING_AUTHORITY_READER_GOAL_MISMATCH",
  "PLANNING_AUTHORITY_READER_SEAL_ABSENT",
  "PLANNING_AUTHORITY_READER_SEAL_AMBIGUOUS",
  "PLANNING_AUTHORITY_READER_SEAL_MALFORMED",
  "PLANNING_AUTHORITY_READER_WITNESS_DIGEST_MISMATCH",
  "PLANNING_AUTHORITY_READER_SEAL_DIGEST_MISMATCH",
  "PLANNING_AUTHORITY_READER_BODIES_INVALID",
  "PLANNING_AUTHORITY_READER_ENVELOPE_INVALID",
  "PLANNING_AUTHORITY_READER_ENVELOPE_DIVERGED",
] as const);

export type PlanningAuthorityReaderCode = (typeof PLANNING_AUTHORITY_READER_CODES)[number];

/**
 * MODULE-PRIVATE on purpose, and only the TYPE is exported.
 *
 * `tests/security/boundary-roster.security.ts` scans production sources for column-zero
 * `export const *_LAYER(S)` and makes every exported one owe a hostile BEFORE/AFTER/RACE trio.
 * This seam is a pure read and earns no such trio, so it follows the precedent the
 * planning-authority persistence, envelope and run-binding modules already set.
 */
const LAYER = "PLANNING_AUTHORITY_READER" as const;

export type PlanningAuthorityReaderLayer = typeof LAYER;

/** The code and layer of the authority that answered BELOW this one, carried verbatim. */
export interface PlanningAuthorityReaderSource {
  readonly code: string;
  readonly layer: string;
}

export interface PlanningAuthorityReaderRefusal {
  readonly code: PlanningAuthorityReaderCode;
  /**
   * Which side of a two-sided check answered — `"bodies"` or `"envelope"` — or which flavour of
   * an absent approval. A short closed vocabulary, never a value read out of the store: a
   * refusal that echoed sealed bytes back would turn an error path into a disclosure path.
   */
  readonly detail?: string;
  readonly layer: PlanningAuthorityReaderLayer;
  readonly ok: false;
  readonly source?: PlanningAuthorityReaderSource;
}

export function readerRefusal(
  code: PlanningAuthorityReaderCode, detail?: string,
): PlanningAuthorityReaderRefusal {
  return detail === undefined
    ? Object.freeze({ code, layer: LAYER, ok: false as const })
    : Object.freeze({ code, detail, layer: LAYER, ok: false as const });
}

/**
 * A lower authority's refusal, wrapped rather than restamped. The wrapper says which read failed;
 * `source` says who decided and under what vocabulary.
 */
export function readerPassthrough(
  code: PlanningAuthorityReaderCode, source: { readonly code: string; readonly layer: string },
): PlanningAuthorityReaderRefusal {
  return Object.freeze({
    code,
    layer: LAYER,
    ok: false as const,
    source: Object.freeze({ code: source.code, layer: source.layer }),
  });
}
