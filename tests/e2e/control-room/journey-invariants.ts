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
 * with the browser tests that prove it named by exact file and title, or UNKNOWN with its cause,
 * missing input and owner. Deleting an invariant, or deleting the test that proves
 * one, now fails loudly instead of quietly shrinking the claim.
 *
 * THE LIST IS HAND-WRITTEN AND SO ARE THE TEST DECLARATIONS. Neither can be derived from
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
  /** Exact browser declarations that prove it; both file and title are load-bearing. */
  readonly provenBy: readonly Readonly<{ file: string; title: string }>[];
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
 * All seven, in DoD 2's order. Read the statuses as written. The production cutover
 * removed the development fixture witness; an invariant stays COVERED only where
 * Cordum v2 supplies a non-vacuous production or real-daemon browser witness.
 *
 * Two of the UNKNOWNs DERIVE from the single record that owns each in
 * `journey-coverage.ts` rather than restating it. Two hand-copies of one fact drift,
 * and a drifted honesty record is worse than a single one, because both then look
 * authoritative. `provenBy` names whole files and test titles rather than line numbers,
 * which drift for an unrelated reason every time a test above them grows.
 */
export const DOD2_INVARIANTS: readonly InvariantRecord[] = Object.freeze([
  Object.freeze({
    bar: "A real daemon-backed goal renders its attached identity fact with the exact "
      + "truth class projected from its durable GoalCreated witness.",
    id: "TRUTH",
    provenBy: Object.freeze([Object.freeze({
      file: "tests/e2e/control-room/prd-to-approval.spec.ts",
      title: "v2: pairs by handshake, reads the sealed plan, and never fabricates approval",
    })]),
    status: "COVERED",
  } as const),
  Object.freeze({
    bar: "The attached goal fact opens a proof inspector whose rows name the exact "
      + "authenticated POST /goals/read boundary and durable goal identity.",
    id: "PROVENANCE",
    provenBy: Object.freeze([Object.freeze({
      file: "tests/e2e/control-room/prd-to-approval.spec.ts",
      title: "v2: pairs by handshake, reads the sealed plan, and never fabricates approval",
    })]),
    status: "COVERED",
  } as const),
  Object.freeze({
    bar: "Enter opens the attached fact's proof, focus moves to its heading, and Escape "
      + "closes it and returns focus to the invoking chip.",
    id: "KEYBOARD",
    provenBy: Object.freeze([Object.freeze({
      file: "tests/e2e/control-room/prd-to-approval.spec.ts",
      title: "v2: pairs by handshake, reads the sealed plan, and never fabricates approval",
    })]),
    status: "COVERED",
  } as const),
  Object.freeze({
    bar: "At the narrow breakpoint the action set matches the wide one — parity, not mere "
      + "presence, so an action cannot quietly disappear on a small viewport.",
    id: "NARROW_WINDOW",
    provenBy: Object.freeze([Object.freeze({
      file: "tests/e2e/control-room/journeys.spec.ts",
      title: "the narrow layout keeps action parity with the wide one",
    })]),
    status: "COVERED",
  } as const),
  Object.freeze({
    cause: LOADING_RECORD.cause,
    id: "LOADING",
    missingInput: LOADING_RECORD.missingInput,
    owner: LOADING_RECORD.owner,
    // Derived, NOT the literal "UNKNOWN". A mutation drill caught the difference:
    // with the status hand-written here, flipping LOADING_RECORD to COVERED left this
    // ledger still calling it UNKNOWN — two sources of truth for one fact, which is
    // the drift this module's doc comment claims to avoid. Derived, the flip cannot
    // be half-applied: `status` narrows to "COVERED", the object stops satisfying
    // UnknownInvariant, and tsc refuses it for want of a `bar` and `provenBy`.
    status: LOADING_RECORD.status,
  } as const),
  Object.freeze({
    cause: "NO_ABSENT_FACT_IN_PRODUCTION_STATIC_LANE",
    id: "DEGRADED",
    missingInput: "Cordum v2 proves the disconnected banner disables a real mutation, but the "
      + "daemonless page supplies no absent fact/value cell; the full degraded invariant is partial.",
    owner: "Cordum v2 needs a reachable absent-fact production state",
    status: "UNKNOWN",
  } as const),
  Object.freeze({
    cause: LATENCY_RECORD.cause,
    id: "LATENCY",
    missingInput: LATENCY_RECORD.missingInput,
    owner: LATENCY_RECORD.owner,
    status: LATENCY_RECORD.status,
  } as const),
]);

export const isCoveredInvariant = (record: InvariantRecord): record is CoveredInvariant =>
  record.status === "COVERED";

export const coveredInvariants = (): readonly CoveredInvariant[] =>
  DOD2_INVARIANTS.filter(isCoveredInvariant);

export const unknownInvariants = (): readonly UnknownInvariant[] =>
  DOD2_INVARIANTS.filter((record): record is UnknownInvariant => record.status === "UNKNOWN");
