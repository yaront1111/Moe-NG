import type {
  FairnessPriority,
  FairnessResult,
  FairnessState,
  FairnessTicket,
} from "./fairness-model.js";
import {
  deepFreeze,
  fail,
  findTicket,
  isNonEmptyString,
  isRecord,
  makeIssue,
  sortTickets,
} from "./fairness-internal.js";
import {
  BYPASSES_PER_LEVEL,
  DEFAULT_M_D,
  isFairnessPriority,
  isNonNegativeInteger,
  promotedPriority,
} from "./fairness-policy.js";
import { applyRaiseCap } from "./fairness-raise-cap.js";

function ok(state: FairnessState): FairnessResult {
  return deepFreeze({ ok: true, state });
}

/** Empty, frozen state. Caller-supplied `policyMd` is validated in reduceEvents. */
export function emptyFairnessState(policyMd: number = DEFAULT_M_D): FairnessState {
  return deepFreeze({ policyMd, eventSeq: 0, dispatchableCount: 0, tickets: [] });
}

/** Accrue one compatible bypass to a ticket, promoting/forcing as thresholds hit. */
function ageOne(
  ticket: FairnessTicket,
  seq: number,
): { readonly ticket: FairnessTicket; readonly seq: number } {
  if (ticket.forced) {
    return { ticket, seq }; // already terminal for aging
  }
  const next = ticket.bypassesInLevel + 1;
  if (next < BYPASSES_PER_LEVEL) {
    return { ticket: { ...ticket, bypassesInLevel: next }, seq };
  }
  const promoted = promotedPriority(ticket.priority);
  if (promoted !== null) {
    return { ticket: { ...ticket, priority: promoted, bypassesInLevel: 0 }, seq };
  }
  const entry = seq + 1;
  return {
    ticket: { ...ticket, forced: true, bypassesInLevel: 0, forcedCohortEntryEvent: entry },
    seq: entry,
  };
}

function applyAdmit(state: FairnessState, ev: Record<string, unknown>): FairnessResult {
  const { ticketId, workItemId, dimension, startingPriority } = ev;
  if (!isNonEmptyString(ticketId) || !isNonEmptyString(workItemId) || !isNonEmptyString(dimension)) {
    return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "ADMIT requires ticketId, workItemId, dimension"));
  }
  let priority: FairnessPriority = "P3";
  if (startingPriority !== undefined) {
    if (!isFairnessPriority(startingPriority)) {
      return fail(makeIssue("FAIRNESS_INVALID_PRIORITY", "invalid startingPriority", [ticketId]));
    }
    priority = startingPriority;
  }
  // O(1) cap gate BEFORE any element traversal (semantic 7).
  if (state.dispatchableCount >= state.policyMd) {
    return fail(makeIssue("FAIRNESS_TICKET_CAP_EXCEEDED", "dispatchable cap reached", [ticketId]));
  }
  if (findTicket(state.tickets, ticketId) !== undefined) {
    return fail(makeIssue("FAIRNESS_DUPLICATE_TICKET", "ticketId already admitted", [ticketId]));
  }
  // A FairnessState is scoped to a single compatibility dimension; reject an
  // ADMIT that would mix dimensions rather than silently store a decorative one.
  const existingDimension = state.tickets[0]?.dimension;
  if (existingDimension !== undefined && existingDimension !== dimension) {
    return fail(
      makeIssue("FAIRNESS_MALFORMED_EVENT", "ADMIT dimension differs from the state dimension", [ticketId]),
    );
  }
  const seq = state.eventSeq + 1;
  const ticket: FairnessTicket = {
    ticketId,
    workItemId,
    dimension,
    priority,
    bypassesInLevel: 0,
    forced: false,
    forcedCohortEntryEvent: null,
    dispatchable: true,
    continuousEligibilityEvent: seq,
  };
  return ok({
    policyMd: state.policyMd,
    eventSeq: seq,
    dispatchableCount: state.dispatchableCount + 1,
    tickets: sortTickets([...state.tickets, ticket]),
  });
}

function applyDispatch(state: FairnessState, ev: Record<string, unknown>): FairnessResult {
  const winner = ev["winnerTicketId"];
  const bypassed = ev["bypassedTicketIds"];
  if (!isNonEmptyString(winner) || !Array.isArray(bypassed)) {
    return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "COMPATIBLE_DISPATCH shape is malformed"));
  }
  const seen = new Set<string>();
  for (const id of bypassed) {
    if (!isNonEmptyString(id) || id === winner || seen.has(id)) {
      return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "bypassedTicketIds are malformed"));
    }
    seen.add(id);
  }
  const winnerTicket = findTicket(state.tickets, winner);
  if (winnerTicket === undefined) {
    return fail(makeIssue("FAIRNESS_UNKNOWN_TICKET", "unknown dispatch winner", [winner]));
  }
  if (!winnerTicket.dispatchable) {
    return fail(makeIssue("FAIRNESS_STALE_EVENT", "winner is not dispatchable", [winner]));
  }
  for (const id of bypassed) {
    const t = findTicket(state.tickets, id);
    if (t === undefined) {
      return fail(makeIssue("FAIRNESS_UNKNOWN_TICKET", "unknown bypassed ticket", [id]));
    }
    if (!t.dispatchable) {
      return fail(makeIssue("FAIRNESS_STALE_EVENT", "bypassed ticket is not dispatchable", [id]));
    }
  }
  // Age in deterministic (workItemId, ticketId) order so forced entry events are stable.
  const order = [...bypassed].sort((a, b) => {
    const ta = findTicket(state.tickets, a)!;
    const tb = findTicket(state.tickets, b)!;
    return ta.workItemId < tb.workItemId
      ? -1
      : ta.workItemId > tb.workItemId
        ? 1
        : a < b
          ? -1
          : a > b
            ? 1
            : 0;
  });
  let seq = state.eventSeq;
  const aged = new Map<string, FairnessTicket>();
  for (const id of order) {
    const result = ageOne(findTicket(state.tickets, id)!, seq);
    aged.set(id, result.ticket);
    seq = result.seq;
  }
  const tickets = state.tickets
    .filter((t) => t.ticketId !== winner)
    .map((t) => aged.get(t.ticketId) ?? t);
  return ok({
    policyMd: state.policyMd,
    eventSeq: seq,
    dispatchableCount: state.dispatchableCount - 1,
    tickets: sortTickets(tickets),
  });
}

function withTicket(
  state: FairnessState,
  ticketId: string,
  next: FairnessTicket,
  dispatchableDelta: number,
  eventSeq: number,
): FairnessResult {
  const tickets = state.tickets.map((t) => (t.ticketId === ticketId ? next : t));
  return ok({
    policyMd: state.policyMd,
    eventSeq,
    dispatchableCount: state.dispatchableCount + dispatchableDelta,
    tickets: sortTickets(tickets),
  });
}

function applyLose(state: FairnessState, ev: Record<string, unknown>): FairnessResult {
  const ticketId = ev["ticketId"];
  if (!isNonEmptyString(ticketId)) {
    return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "LOSE_DISPATCHABILITY requires ticketId"));
  }
  const ticket = findTicket(state.tickets, ticketId);
  if (ticket === undefined) {
    return fail(makeIssue("FAIRNESS_UNKNOWN_TICKET", "unknown ticket", [ticketId]));
  }
  if (!ticket.dispatchable) {
    return fail(makeIssue("FAIRNESS_STALE_EVENT", "ticket already non-dispatchable", [ticketId]));
  }
  const next: FairnessTicket = { ...ticket, dispatchable: false, forcedCohortEntryEvent: null };
  return withTicket(state, ticketId, next, -1, state.eventSeq);
}

function applyRegain(state: FairnessState, ev: Record<string, unknown>): FairnessResult {
  const ticketId = ev["ticketId"];
  if (!isNonEmptyString(ticketId)) {
    return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "REGAIN_DISPATCHABILITY requires ticketId"));
  }
  const ticket = findTicket(state.tickets, ticketId);
  if (ticket === undefined) {
    return fail(makeIssue("FAIRNESS_UNKNOWN_TICKET", "unknown ticket", [ticketId]));
  }
  if (ticket.dispatchable) {
    return fail(makeIssue("FAIRNESS_STALE_EVENT", "ticket already dispatchable", [ticketId]));
  }
  if (state.dispatchableCount >= state.policyMd) {
    return fail(makeIssue("FAIRNESS_TICKET_CAP_EXCEEDED", "dispatchable cap reached", [ticketId]));
  }
  const eligibility = state.eventSeq + 1;
  const entry = ticket.forced ? eligibility + 1 : null;
  const next: FairnessTicket = {
    ...ticket,
    dispatchable: true,
    continuousEligibilityEvent: eligibility,
    forcedCohortEntryEvent: entry,
  };
  return withTicket(state, ticketId, next, 1, entry ?? eligibility);
}

function applyTerminate(state: FairnessState, ev: Record<string, unknown>): FairnessResult {
  const ticketId = ev["ticketId"];
  if (!isNonEmptyString(ticketId)) {
    return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "TERMINATE requires ticketId"));
  }
  const ticket = findTicket(state.tickets, ticketId);
  if (ticket === undefined) {
    return fail(makeIssue("FAIRNESS_UNKNOWN_TICKET", "unknown ticket", [ticketId]));
  }
  return ok({
    policyMd: state.policyMd,
    eventSeq: state.eventSeq,
    dispatchableCount: state.dispatchableCount - (ticket.dispatchable ? 1 : 0),
    tickets: sortTickets(state.tickets.filter((t) => t.ticketId !== ticketId)),
  });
}

/** Apply one caller-confirmed event to a frozen state; never mutates the input. */
export function applyEvent(state: FairnessState, event: unknown): FairnessResult {
  if (!isRecord(event) || typeof event["kind"] !== "string") {
    return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "event must be a record with a string kind"));
  }
  switch (event["kind"]) {
    case "ADMIT":
      return applyAdmit(state, event);
    case "COMPATIBLE_DISPATCH":
      return applyDispatch(state, event);
    case "LOSE_DISPATCHABILITY":
      return applyLose(state, event);
    case "REGAIN_DISPATCHABILITY":
      return applyRegain(state, event);
    case "TERMINATE":
      return applyTerminate(state, event);
    case "RAISE_CAP":
      return applyRaiseCap(state, event);
    default:
      return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", `unknown event kind: ${String(event["kind"])}`));
  }
}

/** Fold an event stream from a fresh state; fail-closed on the first bad event. */
export function reduceEvents(events: unknown, policyMd?: number): FairnessResult {
  if (!Array.isArray(events)) {
    return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "events must be an array"));
  }
  if (policyMd !== undefined && (!isNonNegativeInteger(policyMd) || policyMd < 1)) {
    return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "policyMd must be a positive integer"));
  }
  let state = emptyFairnessState(policyMd);
  for (const event of events) {
    const result = applyEvent(state, event);
    if (!result.ok) {
      return result;
    }
    state = result.state;
  }
  return ok(state);
}
