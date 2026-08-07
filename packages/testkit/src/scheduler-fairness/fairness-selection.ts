import type {
  FairnessBound,
  FairnessState,
  FairnessTicket,
  SelectedTicket,
} from "./fairness-model.js";
import { compareStrings, deepFreeze } from "./fairness-internal.js";
import { BYPASSES_PER_LEVEL, PRIORITY_LADDER, bucketsToForced } from "./fairness-policy.js";

function priorityRank(priority: FairnessTicket["priority"]): number {
  return PRIORITY_LADDER.indexOf(priority);
}

/** FIFO by immutable entry event, then workItemId, then ticketId (total order). */
function compareForced(a: FairnessTicket, b: FairnessTicket): number {
  const ae = a.forcedCohortEntryEvent ?? 0;
  const be = b.forcedCohortEntryEvent ?? 0;
  if (ae !== be) {
    return ae - be;
  }
  return (
    compareStrings(a.workItemId, b.workItemId) ||
    compareStrings(a.ticketId, b.ticketId)
  );
}

/** Ordinary stand-in order: highest priority, then workItemId, then ticketId. */
function compareOrdinary(a: FairnessTicket, b: FairnessTicket): number {
  const ra = priorityRank(a.priority);
  const rb = priorityRank(b.priority);
  if (ra !== rb) {
    return ra - rb;
  }
  return (
    compareStrings(a.workItemId, b.workItemId) ||
    compareStrings(a.ticketId, b.ticketId)
  );
}

/** The active forced cohort (forced AND currently dispatchable), FIFO-ordered. */
export function forcedCohortOrder(state: FairnessState): readonly FairnessTicket[] {
  const active = state.tickets.filter(
    (t) => t.forced && t.dispatchable && t.forcedCohortEntryEvent !== null,
  );
  return deepFreeze([...active].sort(compareForced));
}

/**
 * The next ticket to serve: the head of the forced cohort if any, else the
 * documented ordinary stand-in (priority-then-workItemId). Null if nothing is
 * dispatchable. Never infers readiness — it only reads confirmed state.
 */
export function selectNext(state: FairnessState): SelectedTicket | null {
  const forced = forcedCohortOrder(state);
  if (forced.length > 0) {
    const head = forced[0]!;
    return deepFreeze({
      ticketId: head.ticketId,
      workItemId: head.workItemId,
      lane: "FORCED",
    });
  }
  const ordinary = state.tickets.filter((t) => t.dispatchable && !t.forced);
  if (ordinary.length === 0) {
    return null;
  }
  const head = [...ordinary].sort(compareOrdinary)[0]!;
  return deepFreeze({
    ticketId: head.ticketId,
    workItemId: head.workItemId,
    lane: "ORDINARY",
  });
}

/**
 * Bound evidence for a dispatchable ticket:
 * - forced: exact remainder `F_ahead + 1` (F_ahead = forced tickets strictly ahead).
 * - otherwise: conservative `8·c + M_d`, c = whole buckets to forced.
 * Null for an unknown or non-dispatchable ticket. Never a wall-clock time.
 */
export function boundFor(
  state: FairnessState,
  ticketId: string,
): FairnessBound | null {
  const ticket = state.tickets.find((t) => t.ticketId === ticketId);
  if (ticket === undefined || !ticket.dispatchable) {
    return null;
  }
  if (ticket.forced) {
    const order = forcedCohortOrder(state);
    const fAhead = order.findIndex((t) => t.ticketId === ticketId);
    const derived = fAhead + 1;
    const value = ticket.migratedBoundAtMost === null
      ? derived
      : Math.min(derived, ticket.migratedBoundAtMost);
    return deepFreeze({ ticketId, kind: "EXACT_FORCED", value });
  }
  const buckets = bucketsToForced(ticket.priority, false);
  const derived = BYPASSES_PER_LEVEL * buckets + state.policyMd;
  const value = ticket.migratedBoundAtMost === null
    ? derived
    : Math.min(derived, ticket.migratedBoundAtMost);
  return deepFreeze({
    ticketId,
    kind: "CONSERVATIVE",
    value,
  });
}
