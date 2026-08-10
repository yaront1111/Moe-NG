/**
 * The DoD 2 invariant ledger — the SECOND axis of this gate, and the one whose
 * absence produced the defect that reopened this task.
 *
 * WHY THIS FILE EXISTS, stated plainly because it is the whole point. DoD 2 names
 * seven invariants: truth, provenance, keyboard, narrow-window, loading, degraded,
 * latency. The first pass of this gate asserted five of them in `journeys.spec.ts`,
 * recorded latency as a typed UNKNOWN because it arrived as an inherited obligation,
 * and said NOTHING AT ALL about loading. Nothing caught it, because until this file
 * existed there was no list for an invariant to be missing FROM. `journey-coverage.ts`
 * enumerates spec section 12's twenty SCENARIOS, which is a different axis entirely,
 * and loading fell through the gap between the two.
 *
 * A silent omission inside an honesty artifact reads exactly like coverage. So the
 * seven are enumerated here, the count is asserted, and every entry is either COVERED
 * with the browser tests that prove it named by title, or UNKNOWN with its cause,
 * missing input and owner. Deleting an invariant, or deleting the test that proves
 * one, now fails loudly instead of quietly shrinking the claim.
 *
 * THE LIST IS HAND-WRITTEN AND SO ARE THE TEST TITLES. Neither can be derived from
 * the other, so the binding in `journey-coverage.test.ts` cannot pass vacuously —
 * the same reason `journeys.spec.ts` hand-writes its own EXERCISED_SCENARIOS.
 */

import { LATENCY_RECORD, LOADING_RECORD } from "./journey-coverage.js";

/** Exactly the seven DoD 2 names, in the order the definition of done lists them. */
export type InvariantId =
  | "TRUTH" | "PROVENANCE" | "KEYBOARD" | "NARROW_WINDOW" | "LOADING" | "DEGRADED" | "LATENCY";

/** DoD 2's own count. Hand-transcribed from the task's definition of done. */
export const DECLARED_INVARIANT_COUNT = 7;

export interface CoveredInvariant {
  readonly id: InvariantId;
  readonly status: "COVERED";
  /** What the browser actually asserts. Non-empty for every covered invariant. */
  readonly bar: string;
  /**
   * Titles of the `journeys.spec.ts` tests that prove it, matched against that file.
   * This is the load-bearing binding: delete a proving test and the ledger goes RED
   * rather than continuing to claim the invariant holds.
   */
  readonly provenBy: readonly string[];
}

export interface UnknownInvariant {
  readonly id: InvariantId;
  readonly status: "UNKNOWN";
  readonly cause: string;
  readonly missingInput: string;
  readonly owner: string;
}

export type InvariantRecord = CoveredInvariant | UnknownInvariant;

/**
 * All seven, in DoD 2's order. Read the statuses as written: five COVERED by a real
 * browser against the real built bundle, two UNKNOWN and saying exactly what is
 * missing and who owns it.
 *
 * The two UNKNOWNs DERIVE from the single record that owns each in
 * `journey-coverage.ts` rather than restating it. Two hand-copies of one fact drift,
 * and a drifted honesty record is worse than a single one, because both then look
 * authoritative. `provenBy` names whole test titles rather than line numbers, which
 * drift for an unrelated reason every time a test above them grows.
 */
export const DOD2_INVARIANTS: readonly InvariantRecord[] = Object.freeze([
  Object.freeze({
    bar: "Every displayed fact carries a truth chip on every workspace, and the five truth "
      + "classes stay pairwise-distinct by glyph, short label and border without colour.",
    id: "TRUTH",
    provenBy: Object.freeze([
      "every displayed fact carries a truth chip, on every workspace",
      "CR-A11Y-001: five truth classes stay distinct without colour",
    ]),
    status: "COVERED",
  } as const),
  Object.freeze({
    bar: "A focused truth chip drills to its provenance and returns focus, so provenance is "
      + "reachable from the fact itself rather than merely present somewhere on the page.",
    id: "PROVENANCE",
    provenBy: Object.freeze([
      "a focused truth chip drills to provenance by keyboard and gets focus back",
    ]),
    status: "COVERED",
  } as const),
  Object.freeze({
    bar: "The provenance drill is performed by keyboard alone and focus is asserted to MOVE "
      + "and come back — an assertion that a handler exists would not survive this.",
    id: "KEYBOARD",
    provenBy: Object.freeze([
      "a focused truth chip drills to provenance by keyboard and gets focus back",
    ]),
    status: "COVERED",
  } as const),
  Object.freeze({
    bar: "At the narrow breakpoint the action set matches the wide one — parity, not mere "
      + "presence, so an action cannot quietly disappear on a small viewport.",
    id: "NARROW_WINDOW",
    provenBy: Object.freeze(["the narrow layout keeps action parity with the wide one"]),
    status: "COVERED",
  } as const),
  Object.freeze({
    cause: LOADING_RECORD.cause,
    id: "LOADING",
    missingInput: LOADING_RECORD.missingInput,
    owner: LOADING_RECORD.owner,
    status: "UNKNOWN",
  } as const),
  Object.freeze({
    bar: "An absent fact renders AS UNKNOWN — dashed border, UNK short label, a non-blank "
      + "value cell — and the disconnected banner never coexists with an enabled action.",
    id: "DEGRADED",
    provenBy: Object.freeze([
      "an UNKNOWN fact renders as UNKNOWN and never as a blank or confident cell",
      "the disconnected banner never coexists with an enabled action",
    ]),
    status: "COVERED",
  } as const),
  Object.freeze({
    cause: LATENCY_RECORD.cause,
    id: "LATENCY",
    missingInput: LATENCY_RECORD.missingInput,
    owner: LATENCY_RECORD.owner,
    status: "UNKNOWN",
  } as const),
]);

export const isCoveredInvariant = (record: InvariantRecord): record is CoveredInvariant =>
  record.status === "COVERED";

export const coveredInvariants = (): readonly CoveredInvariant[] =>
  DOD2_INVARIANTS.filter(isCoveredInvariant);

export const unknownInvariants = (): readonly UnknownInvariant[] =>
  DOD2_INVARIANTS.filter((record): record is UnknownInvariant => record.status === "UNKNOWN");
