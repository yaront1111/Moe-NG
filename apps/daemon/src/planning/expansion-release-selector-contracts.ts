/**
 * THE SERVER-OWNED QUERY, CODES AND RESULT SHAPES for selecting the durable released
 * Foundation attempt behind an expansion parent (task-671cdd10).
 *
 * THE CALLER NAMES SUBJECTS, NEVER EVIDENCE. Four plain data keys — goal, parent node,
 * parent run, project — are admitted BEFORE any store read, and a fifth key is REFUSED
 * rather than ignored: `attemptRef`, `release` and `decisionTrace` are exactly the
 * surrogates a caller could otherwise smuggle in, and a dropped claim is
 * indistinguishable from an honoured one at the call site.
 *
 * THE LAYER CONSTANT STAYS MODULE-PRIVATE. A column-zero `export const *_LAYER` is a
 * DECLARED BOUNDARY the security roster demands a hostile before/after/race trio for
 * (tests/security/boundary-roster.security.ts:455). This module's refusals are already
 * driven by the focused suite's 33-case roster, so only the TYPE and a `*_ROSTER`
 * listing escape.
 *
 * EVERY REFUSAL KEEPS THE ANSWERING LAYER. `code`/`layer` are this module's own when it
 * decided; `sourceCode`/`sourceLayer` carry the upstream authority's verbatim when one
 * did. Restamping an upstream refusal as a local one would name the wrong repair.
 */

import type { ExpansionHandoffBinding, ExpansionReleaseEvidence } from "@moe/core";

/** MODULE-PRIVATE by design; see the header. Only `ExpansionReleaseSelectorLayer` escapes. */
const LAYER = "DAEMON_EXPANSION_RELEASE_SELECTOR";

/** The four subject keys, in the order the admission pins them. */
export const EXPANSION_RELEASE_SELECTOR_QUERY_KEYS = Object.freeze([
  "goalRef", "parentNodeRef", "parentRunRef", "projectId",
] as const);

export type ExpansionReleaseSelectorQueryKey =
  (typeof EXPANSION_RELEASE_SELECTOR_QUERY_KEYS)[number];

/**
 * SIXTEEN MEMBERS, each naming a DIFFERENT repair. Grouped by the leg that answers:
 * request, store, parent authority, approved plan, locator scan, attempt cardinality,
 * activation, release, currentness.
 */
export const EXPANSION_RELEASE_SELECTOR_CODES = Object.freeze([
  "EXPANSION_RELEASE_SELECTOR_REQUEST_INVALID",
  "EXPANSION_RELEASE_SELECTOR_STORE_UNAVAILABLE",
  "EXPANSION_RELEASE_SELECTOR_STORE_PROJECT_MISMATCH",
  "EXPANSION_RELEASE_SELECTOR_PARENT_AUTHORITY_UNAVAILABLE",
  "EXPANSION_RELEASE_SELECTOR_APPROVED_RUN_UNAVAILABLE",
  "EXPANSION_RELEASE_SELECTOR_PARENT_RUN_MISMATCH",
  "EXPANSION_RELEASE_SELECTOR_GRAPH_BINDING_MISMATCH",
  "EXPANSION_RELEASE_SELECTOR_LOCATOR_SCAN_INCOMPLETE",
  "EXPANSION_RELEASE_SELECTOR_LOCATOR_EVIDENCE_UNREADABLE",
  "EXPANSION_RELEASE_SELECTOR_LOCATOR_BINDING_MISMATCH",
  "EXPANSION_RELEASE_SELECTOR_ATTEMPT_ABSENT",
  "EXPANSION_RELEASE_SELECTOR_ATTEMPT_AMBIGUOUS",
  "EXPANSION_RELEASE_SELECTOR_ACTIVATION_UNAVAILABLE",
  "EXPANSION_RELEASE_SELECTOR_ACTIVATION_MISMATCH",
  "EXPANSION_RELEASE_SELECTOR_RELEASE_UNAVAILABLE",
  "EXPANSION_RELEASE_SELECTOR_CURRENTNESS_MOVED",
] as const);

export type ExpansionReleaseSelectorCode = (typeof EXPANSION_RELEASE_SELECTOR_CODES)[number];
export type ExpansionReleaseSelectorLayer = typeof LAYER;

/** The one layer this module ever stamps, published as a LIST so a caller can assert
 *  membership without the constant becoming a declared boundary of its own. */
export const EXPANSION_RELEASE_SELECTOR_LAYER_ROSTER = Object.freeze([LAYER] as const);

/** Identity ONLY. A ref, a release or a trace would be an answer, not a question. */
export interface ExpansionReleaseSelectorQuery {
  readonly goalRef: string;
  readonly parentNodeRef: string;
  readonly parentRunRef: string;
  readonly projectId: string;
}

/** `sourceCode`/`sourceLayer` are `null` when THIS module decided, never omitted: an
 *  absent key and a null one read the same at a call site that uses `?.`, and the
 *  difference is "no upstream" versus "upstream we forgot to carry". */
export interface ExpansionReleaseSelectorRefused {
  readonly code: ExpansionReleaseSelectorCode;
  readonly layer: ExpansionReleaseSelectorLayer;
  readonly ok: false;
  readonly sourceCode: string | null;
  readonly sourceLayer: string | null;
}

/** The final answer, and the ONLY place `attemptRef` is ever spoken aloud — as an
 *  OUTPUT the server derived, never an input a caller supplied. */
export interface ExpansionReleaseSelectorBound {
  readonly attemptRef: string;
  readonly ok: true;
  readonly release: ExpansionReleaseEvidence;
  /** The SAME immutable value as `release.handoff`: core compares the two. */
  readonly workerHandoff: ExpansionHandoffBinding;
}

export type ExpansionReleaseSelectorOutcome =
  | ExpansionReleaseSelectorBound
  | ExpansionReleaseSelectorRefused;

/** Bounded, non-empty text. The ceiling matches the release authority's own `MAX_TEXT`
 *  so a ref this selector admits cannot be one task-e62e3828's reader would refuse. */
const MAX_TEXT = 256;
export const isSelectorText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;

export function refuseExpansionReleaseSelection(
  code: ExpansionReleaseSelectorCode,
  sourceCode: string | null = null,
  sourceLayer: string | null = null,
): ExpansionReleaseSelectorRefused {
  return Object.freeze({ code, layer: LAYER, ok: false as const, sourceCode, sourceLayer });
}

/** An upstream verdict carried through under THIS module's local code, with the
 *  refusing authority's own code and layer preserved beside it. */
export function carryExpansionReleaseRefusal(
  code: ExpansionReleaseSelectorCode,
  source: { readonly code?: unknown; readonly layer?: unknown },
): ExpansionReleaseSelectorRefused {
  return refuseExpansionReleaseSelection(
    code,
    typeof source.code === "string" ? source.code : null,
    typeof source.layer === "string" ? source.layer : null,
  );
}

export function deepFreezeSelection<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreezeSelection((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * THE ONLY THING A CALLER MAY SAY: four own plain enumerable DATA properties, whose
 * NAMES are pinned as well as their arity. An accessor is refused rather than invoked,
 * so a getter cannot answer one value to the guard and another to the derivation, and
 * four unrelated own keys cannot fall through to a PROTOTYPE accessor.
 */
export function admitExpansionReleaseSelectorQuery(
  query: unknown,
): ExpansionReleaseSelectorQuery | null {
  if (query === null || typeof query !== "object" || Array.isArray(query)) return null;
  const keys = Reflect.ownKeys(query);
  if (keys.length !== EXPANSION_RELEASE_SELECTOR_QUERY_KEYS.length) return null;
  const roster: readonly string[] = EXPANSION_RELEASE_SELECTOR_QUERY_KEYS;
  for (const key of keys) {
    if (typeof key !== "string" || !roster.includes(key)) return null;
    const property = Object.getOwnPropertyDescriptor(query, key);
    if (property === undefined || !property.enumerable || !("value" in property)) return null;
  }
  const { goalRef, parentNodeRef, parentRunRef, projectId } = query as Record<string, unknown>;
  if (!isSelectorText(goalRef) || !isSelectorText(parentNodeRef)) return null;
  if (!isSelectorText(parentRunRef) || !isSelectorText(projectId)) return null;
  return { goalRef, parentNodeRef, parentRunRef, projectId };
}
