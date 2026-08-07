import type { FairnessResult, FairnessState, FairnessTicket } from "./fairness-model.js";
import { deepFreeze, fail, findTicket, makeIssue, sortTickets } from "./fairness-internal.js";
import { hasExactKeys, isFairnessId } from "./fairness-input.js";

const TICKET_EVENT_KEYS = ["kind", "ticketId"] as const;

function okWithTicket(
  state: FairnessState,
  ticketId: string,
  next: FairnessTicket,
  dispatchableDelta: number,
  eventSeq: number,
): FairnessResult {
  const tickets = state.tickets.map((ticket) => (ticket.ticketId === ticketId ? next : ticket));
  return deepFreeze({
    ok: true,
    state: {
      ...state,
      eventSeq,
      dispatchableCount: state.dispatchableCount + dispatchableDelta,
      tickets: sortTickets(tickets),
    },
  });
}

export function applyLose(state: FairnessState, event: Record<string, unknown>): FairnessResult {
  const ticketId = event["ticketId"];
  if (!hasExactKeys(event, TICKET_EVENT_KEYS) || !isFairnessId(ticketId)) {
    return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "LOSE_DISPATCHABILITY requires ticketId"));
  }
  const ticket = findTicket(state.tickets, ticketId);
  if (ticket === undefined) return fail(makeIssue("FAIRNESS_UNKNOWN_TICKET", "unknown ticket", [ticketId]));
  if (!ticket.dispatchable) {
    return fail(makeIssue("FAIRNESS_STALE_EVENT", "ticket already non-dispatchable", [ticketId]));
  }
  return okWithTicket(
    state,
    ticketId,
    { ...ticket, dispatchable: false, forcedCohortEntryEvent: null },
    -1,
    state.eventSeq,
  );
}

export function applyRegain(state: FairnessState, event: Record<string, unknown>): FairnessResult {
  const ticketId = event["ticketId"];
  if (!hasExactKeys(event, TICKET_EVENT_KEYS) || !isFairnessId(ticketId)) {
    return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "REGAIN_DISPATCHABILITY requires ticketId"));
  }
  const ticket = findTicket(state.tickets, ticketId);
  if (ticket === undefined) return fail(makeIssue("FAIRNESS_UNKNOWN_TICKET", "unknown ticket", [ticketId]));
  if (ticket.dispatchable) {
    return fail(makeIssue("FAIRNESS_STALE_EVENT", "ticket already dispatchable", [ticketId]));
  }
  if (state.dispatchableCount >= state.policyMd) {
    return fail(makeIssue("FAIRNESS_TICKET_CAP_EXCEEDED", "dispatchable cap reached", [ticketId]));
  }
  if (state.eventSeq > Number.MAX_SAFE_INTEGER - (ticket.forced ? 2 : 1)) {
    return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "eventSeq cannot be incremented safely"));
  }
  const eligibility = state.eventSeq + 1;
  const entry = ticket.forced ? eligibility + 1 : null;
  return okWithTicket(
    state,
    ticketId,
    {
      ...ticket,
      dispatchable: true,
      continuousEligibilityEvent: eligibility,
      forcedCohortEntryEvent: entry,
    },
    1,
    entry ?? eligibility,
  );
}

export function applyTerminate(state: FairnessState, event: Record<string, unknown>): FairnessResult {
  const ticketId = event["ticketId"];
  if (!hasExactKeys(event, TICKET_EVENT_KEYS) || !isFairnessId(ticketId)) {
    return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "TERMINATE requires ticketId"));
  }
  const ticket = findTicket(state.tickets, ticketId);
  if (ticket === undefined) return fail(makeIssue("FAIRNESS_UNKNOWN_TICKET", "unknown ticket", [ticketId]));
  return deepFreeze({
    ok: true,
    state: {
      ...state,
      dispatchableCount: state.dispatchableCount - (ticket.dispatchable ? 1 : 0),
      tickets: sortTickets(state.tickets.filter((candidate) => candidate.ticketId !== ticketId)),
    },
  });
}
