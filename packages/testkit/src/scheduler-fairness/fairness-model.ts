/**
 * DEVELOPMENT_ONLY / NOT_CONFIRMATORY scheduler-fairness aging reference model.
 *
 * This is an executable specification of design §8.4's compatible-opportunity
 * aging and forced-cohort starvation prevention. It is NOT the production
 * scheduler, NOT a benchmark fixture, and NOT confirmatory benchmark evidence.
 * It adds no dependency and no public package export; only its own tests import
 * it. All state is caller-confirmed — the model never infers readiness,
 * compatibility, capacity, or authority.
 */

export const FAIRNESS_REFERENCE_KIND = "DEVELOPMENT_ONLY/NOT_CONFIRMATORY" as const;

/** Ordinary user priority classes; P0 is highest, P3 lowest. */
export type FairnessPriority = "P0" | "P1" | "P2" | "P3";

/**
 * One durable fairness ticket for a continuously-dispatchable work item bound to
 * a single compatibility dimension `d`. Aging history (priority, bypass counter,
 * forced status) survives loss of dispatchability; only the *active* forced
 * cohort membership toggles with dispatchability.
 */
export interface FairnessTicket {
  readonly ticketId: string;
  readonly workItemId: string;
  readonly dimension: string;
  readonly priority: FairnessPriority;
  /** Compatible bypasses accrued toward the next promotion (0..7). */
  readonly bypassesInLevel: number;
  /** True once eight bypasses accrued at P0 (durable; survives churn). */
  readonly forced: boolean;
  /** Monotonic entry event iff currently in the ACTIVE forced cohort, else null. */
  readonly forcedCohortEntryEvent: number | null;
  /** Caller-confirmed continuous dispatchability now. */
  readonly dispatchable: boolean;
  /** Display-only continuous-eligibility event; never a selection key. */
  readonly continuousEligibilityEvent: number;
}

export interface FairnessState {
  readonly policyMd: number;
  /** Monotonic counter for eligibility / forced-entry events. */
  readonly eventSeq: number;
  /**
   * Maintained count of continuously-dispatchable tickets (the `M_d` admission
   * unit). Kept in state so the cap check is O(1) — rejected before any element
   * traversal — and is exactly reconstructed by the canonical round-trip.
   */
  readonly dispatchableCount: number;
  /** Tickets sorted by ticketId for deterministic output. */
  readonly tickets: readonly FairnessTicket[];
}

// --- Events (all caller-confirmed facts) ---

export interface AdmitEvent {
  readonly kind: "ADMIT";
  readonly ticketId: string;
  readonly workItemId: string;
  readonly dimension: string;
  readonly startingPriority?: FairnessPriority;
}

export interface CompatibleDispatchEvent {
  readonly kind: "COMPATIBLE_DISPATCH";
  readonly winnerTicketId: string;
  /** Caller-confirmed set of other dispatchable, compatible tickets bypassed. */
  readonly bypassedTicketIds: readonly string[];
}

export interface LoseDispatchabilityEvent {
  readonly kind: "LOSE_DISPATCHABILITY";
  readonly ticketId: string;
}

export interface RegainDispatchabilityEvent {
  readonly kind: "REGAIN_DISPATCHABILITY";
  readonly ticketId: string;
}

export interface TerminateEvent {
  readonly kind: "TERMINATE";
  readonly ticketId: string;
}

/** A per-ticket migration bound (opportunity count) for a cap raise. */
export interface CapMigration {
  readonly ticketId: string;
  /** Equal-or-tighter bound: must be <= the ticket's current bound. */
  readonly boundAtMost: number;
}

export interface RaiseCapEvent {
  readonly kind: "RAISE_CAP";
  readonly newMd: number;
  readonly migrations?: readonly CapMigration[];
}

export type FairnessEvent =
  | AdmitEvent
  | CompatibleDispatchEvent
  | LoseDispatchabilityEvent
  | RegainDispatchabilityEvent
  | TerminateEvent
  | RaiseCapEvent;

// --- Results ---

export type FairnessReasonCode =
  | "FAIRNESS_MALFORMED_EVENT"
  | "FAIRNESS_MALFORMED_STATE"
  | "FAIRNESS_DUPLICATE_TICKET"
  | "FAIRNESS_UNKNOWN_TICKET"
  | "FAIRNESS_STALE_EVENT"
  | "FAIRNESS_INVALID_PRIORITY"
  | "FAIRNESS_TICKET_CAP_EXCEEDED"
  | "CAP_RAISE_REQUIRES_DRAIN_OR_TIGHTER_MIGRATION";

export interface FairnessIssue {
  readonly code: FairnessReasonCode;
  readonly message: string;
  readonly ticketIds: readonly string[];
}

export interface FairnessOk {
  readonly ok: true;
  readonly state: FairnessState;
}

export interface FairnessError {
  readonly ok: false;
  readonly issues: readonly FairnessIssue[];
}

export type FairnessResult = FairnessOk | FairnessError;

// --- Selection + bound evidence ---

export interface SelectedTicket {
  readonly ticketId: string;
  readonly workItemId: string;
  /** "FORCED" if drawn from the forced cohort, else "ORDINARY". */
  readonly lane: "FORCED" | "ORDINARY";
}

/** Bound evidence for a ticket: a conservative pre-forced count or exact forced remainder. */
export interface FairnessBound {
  readonly ticketId: string;
  readonly kind: "CONSERVATIVE" | "EXACT_FORCED";
  /** Opportunity/selection count; never a wall-clock time. */
  readonly value: number;
}
