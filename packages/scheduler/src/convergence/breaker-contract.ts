/**
 * Vocabulary and shapes for the same-bug circuit breaker. No logic, no I/O.
 *
 * Split from `breaker.ts` for the reason the neighbouring scheduler modules
 * split their contracts: the decision module, the fingerprint module and the
 * tests all import this one, so there is a single vocabulary and no second
 * copy that can drift from it.
 */
import type {
  DeadEndJournalEntry,
  FactPredicate,
  RetryUnlockResult,
} from "@moe/context";

export const CONVERGENCE_BREAKER_SCHEMA_VERSION = 1;

export const CONVERGENCE_BREAKER_LAYER = "CONVERGENCE_BREAKER";

/**
 * Exactly the stable codes this module can answer. A hold or refusal carrying
 * any other code is a defect, not a new case.
 */
export const CONVERGENCE_BREAKER_CODES = Object.freeze([
  "BREAKER_HOLDS_EXHAUSTED",
  "BREAKER_INPUT_INVALID",
  "RETRY_PREDICATE_UNCHANGED_HOLD",
  "SAME_BUG_HOLD_ACTIVE",
] as const);

export type ConvergenceBreakerCode = (typeof CONVERGENCE_BREAKER_CODES)[number];

/**
 * Ceiling on simultaneously tracked holds. A hold is otherwise permanent state
 * inserted on any novel fingerprint — and fingerprints span the recipe, base
 * and environment digests, so a base rotation mints novel fingerprints while
 * stranding the old ones forever. At the cap a NEW hold is refused with
 * `BREAKER_HOLDS_EXHAUSTED`; requests on an already-held fingerprint keep
 * converging, unlocking and releasing. `retainHolds` is the consumer's
 * eviction lever for holds a rotation has stranded.
 */
export const MAX_ACTIVE_HOLDS = 4096;

/**
 * Ceiling on the entry ids one hold accumulates. Ids are free-form caller
 * strings — the only unbounded value a hold carries — and every sibling join
 * appends one, so a convergence storm would grow a single record without
 * limit. The window DROPS THE OLDEST id first: ids are provenance breadcrumbs,
 * not authority, and the newest arrivals are the ones an operator inspecting a
 * live hold needs. An id evicted from the window re-appends as newest if it is
 * ever reported again.
 */
export const MAX_HOLD_ENTRY_IDS = 64;

/**
 * Hold reasons are a closed vocabulary rather than prose. An explanation
 * assembled from caller text is how unbounded caller data reaches scheduler
 * state, so the only free-form value a hold ever carries is an entry id.
 */
export const CONVERGENCE_HOLD_REASONS = Object.freeze([
  "RETRY_PREDICATE_UNMOVED",
  "SAME_BUG_CONVERGENCE",
] as const);

export type ConvergenceHoldReason = (typeof CONVERGENCE_HOLD_REASONS)[number];

declare const failureFingerprintBrand: unique symbol;

/**
 * Opaque digest of a failure's TYPED facts. Branded so a caller cannot pass an
 * arbitrary string where a computed fingerprint is required.
 */
export type FailureFingerprint = string & {
  readonly [failureFingerprintBrand]: "FAILURE_FINGERPRINT";
};

/**
 * The bounded hold, and simultaneously its explanation: it names the
 * fingerprint being held, the sibling entries that converged onto it, why it
 * holds, and the authoritative predicate whose movement would release it.
 * `entryIds` is a WINDOW, not a full census: at most `MAX_HOLD_ENTRY_IDS`
 * breadcrumbs in arrival order, oldest dropped first.
 */
export interface HoldRecord {
  readonly fingerprint: FailureFingerprint;
  readonly entryIds: readonly string[];
  readonly reason: ConvergenceHoldReason;
  readonly awaitedPredicate: FactPredicate;
}

export type ActiveHolds = ReadonlyMap<FailureFingerprint, HoldRecord>;

/**
 * The upstream refusal, bound to `@moe/context`'s own type rather than
 * restated here. If `evaluateRetryUnlock` ever changes its code or layer, this
 * type changes with it and the assertions that pin them fail loudly.
 */
export type RetryPredicateRefusal = Extract<RetryUnlockResult, { kind: "REFUSED" }>;

/**
 * A permitted human decision. Explicit and typed on purpose: if a release
 * could be inferred from a flag on an entry or from a predicate that merely
 * differs, DoD 2's two unlock conditions would collapse into one.
 */
export interface HumanRelease {
  readonly kind: "HUMAN_RELEASE";
  readonly decisionId: string;
  readonly fingerprint: FailureFingerprint;
}

export interface BreakerRequest {
  readonly entry: DeadEndJournalEntry;
  /** The predicate a retry claims has moved. `null` when this is a first report. */
  readonly candidatePredicate: FactPredicate | null;
  readonly humanRelease: HumanRelease | null;
}

export interface BreakerAdmission {
  readonly ok: true;
  readonly decision: "ADMIT";
  readonly fingerprint: FailureFingerprint;
}

export interface SameBugHold {
  readonly ok: false;
  readonly decision: "HOLD";
  readonly truth: "UNKNOWN";
  readonly layer: typeof CONVERGENCE_BREAKER_LAYER;
  readonly code: "SAME_BUG_HOLD_ACTIVE";
  readonly refusedBy: null;
  readonly hold: HoldRecord;
}

/**
 * `refusedBy` carries `evaluateRetryUnlock`'s refusal VERBATIM, keeping its own
 * code and its `RETRY_PREDICATE` layer visible. Flattening it into `code`
 * alone would erase which layer actually said no, and a test written against
 * the local code would stay green after the upstream gate was removed.
 */
export interface RetryPredicateHold {
  readonly ok: false;
  readonly decision: "HOLD";
  readonly truth: "UNKNOWN";
  readonly layer: typeof CONVERGENCE_BREAKER_LAYER;
  readonly code: "RETRY_PREDICATE_UNCHANGED_HOLD";
  readonly refusedBy: RetryPredicateRefusal;
  readonly hold: HoldRecord;
}

export interface BreakerInputRefusal {
  readonly ok: false;
  readonly decision: "REFUSE";
  readonly truth: "UNKNOWN";
  readonly layer: typeof CONVERGENCE_BREAKER_LAYER;
  readonly code: "BREAKER_INPUT_INVALID";
  readonly refusedBy: null;
}

/**
 * The ledger is full and the request's fingerprint is not among the tracked
 * ones. Refusing is the only bounded answer: admitting untracked would break
 * "admitted ⇒ convergence is being watched", and inserting would grow state
 * without bound under fingerprint churn.
 */
export interface BreakerHoldsExhaustedRefusal {
  readonly ok: false;
  readonly decision: "REFUSE";
  readonly truth: "UNKNOWN";
  readonly layer: typeof CONVERGENCE_BREAKER_LAYER;
  readonly code: "BREAKER_HOLDS_EXHAUSTED";
  readonly refusedBy: null;
}

export type BreakerHold = RetryPredicateHold | SameBugHold;

export type BreakerOutcome =
  | BreakerAdmission
  | BreakerHold
  | BreakerInputRefusal
  | BreakerHoldsExhaustedRefusal;

/**
 * The decision plus the hold state it produces. Returning the next state is
 * what makes convergence observable: "the sibling joined the existing hold
 * instead of opening a second one" is a fact about `holds`, not about prose.
 */
export interface BreakerTransition {
  readonly outcome: BreakerOutcome;
  readonly holds: ActiveHolds;
}

/**
 * A fixed module constant. Nothing observed at a failure site — no caught
 * message, no offending value — can reach a caller through this refusal.
 */
export const BREAKER_INPUT_INVALID_REFUSAL: BreakerInputRefusal = Object.freeze({
  ok: false,
  decision: "REFUSE",
  truth: "UNKNOWN",
  layer: CONVERGENCE_BREAKER_LAYER,
  code: "BREAKER_INPUT_INVALID",
  refusedBy: null,
});

export const BREAKER_HOLDS_EXHAUSTED_REFUSAL: BreakerHoldsExhaustedRefusal = Object.freeze({
  ok: false,
  decision: "REFUSE",
  truth: "UNKNOWN",
  layer: CONVERGENCE_BREAKER_LAYER,
  code: "BREAKER_HOLDS_EXHAUSTED",
  refusedBy: null,
});
