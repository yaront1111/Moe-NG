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
  makeIssue,
  sortTickets,
} from "./fairness-internal.js";
import {
  arrayLengthExceeds,
  hasExactKeys,
  isFairnessId,
  readDataArray,
  readDataRecord,
} from "./fairness-input.js";
import {
  BYPASSES_PER_LEVEL,
  DEFAULT_M_D,
  MAX_FAIRNESS_EVENTS_PER_REDUCTION,
  isFairnessPriority,
  isNonNegativeInteger,
  promotedPriority,
} from "./fairness-policy.js";
import { applyRaiseCap } from "./fairness-raise-cap.js";
import { applyLose, applyRegain, applyTerminate } from "./fairness-lifecycle.js";
import { selectNext } from "./fairness-selection.js";

const ADMIT_KEYS = ["kind", "ticketId", "workItemId", "dimension"] as const;
const ADMIT_PRIORITY_KEYS = [...ADMIT_KEYS, "startingPriority"] as const;
const DISPATCH_KEYS = ["kind", "winnerTicketId", "bypassedTicketIds"] as const;
const RAISE_CAP_KEYS = ["kind", "newMd"] as const;
const RAISE_CAP_MIGRATION_KEYS = [...RAISE_CAP_KEYS, "migrations"] as const;

function ok(state: FairnessState): FairnessResult {
  return deepFreeze({ ok: true, state });
}

/** Empty, frozen state. Caller-supplied `policyMd` is validated in reduceEvents. */
export function emptyFairnessState(policyMd: number = DEFAULT_M_D): FairnessState {
  return deepFreeze({
    dimension: null,
    projectCeilingMd: DEFAULT_M_D,
    policyMd,
    eventSeq: 0,
    dispatchableCount: 0,
    tickets: [],
  });
}

/** Accrue one compatible bypass to a ticket, promoting/forcing as thresholds hit. */
function ageOne(
  ticket: FairnessTicket,
  seq: number,
): { readonly ticket: FairnessTicket; readonly seq: number } | null {
  const migratedBoundAtMost = ticket.migratedBoundAtMost === null
    ? null
    : Math.max(0, ticket.migratedBoundAtMost - 1);
  if (ticket.forced) {
    return { ticket: { ...ticket, migratedBoundAtMost }, seq };
  }
  const next = ticket.bypassesInLevel + 1;
  if (next < BYPASSES_PER_LEVEL) {
    return { ticket: { ...ticket, bypassesInLevel: next, migratedBoundAtMost }, seq };
  }
  const promoted = promotedPriority(ticket.priority);
  if (promoted !== null) {
    return {
      ticket: { ...ticket, priority: promoted, bypassesInLevel: 0, migratedBoundAtMost },
      seq,
    };
  }
  if (seq >= Number.MAX_SAFE_INTEGER) return null;
  const entry = seq + 1;
  return {
    ticket: {
      ...ticket,
      forced: true,
      bypassesInLevel: 0,
      forcedCohortEntryEvent: entry,
      migratedBoundAtMost,
    },
    seq: entry,
  };
}

function applyAdmit(state: FairnessState, ev: Record<string, unknown>): FairnessResult {
  const { ticketId, workItemId, dimension, startingPriority } = ev;
  if (
    !(hasExactKeys(ev, ADMIT_KEYS) || hasExactKeys(ev, ADMIT_PRIORITY_KEYS)) ||
    !isFairnessId(ticketId) ||
    !isFairnessId(workItemId) ||
    !isFairnessId(dimension)
  ) {
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
  if (state.dimension !== null && state.dimension !== dimension) {
    return fail(
      makeIssue("FAIRNESS_DIMENSION_MISMATCH", "ADMIT dimension differs from the state dimension", [ticketId]),
    );
  }
  if (state.eventSeq >= Number.MAX_SAFE_INTEGER) {
    return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "eventSeq cannot be incremented safely"));
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
    migratedBoundAtMost: null,
  };
  return ok({
    ...state,
    dimension: state.dimension ?? dimension,
    policyMd: state.policyMd,
    eventSeq: seq,
    dispatchableCount: state.dispatchableCount + 1,
    tickets: sortTickets([...state.tickets, ticket]),
  });
}

function applyDispatch(state: FairnessState, ev: Record<string, unknown>): FairnessResult {
  if (!hasExactKeys(ev, DISPATCH_KEYS)) {
    return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "COMPATIBLE_DISPATCH shape is malformed"));
  }
  const winner = ev["winnerTicketId"];
  const rawBypassed = ev["bypassedTicketIds"];
  if (arrayLengthExceeds(rawBypassed, DEFAULT_M_D)) {
    return fail(makeIssue("FAIRNESS_EVENT_LIMIT_EXCEEDED", "dispatch evidence exceeds the project ceiling"));
  }
  const bypassed = readDataArray(rawBypassed, DEFAULT_M_D);
  if (!isFairnessId(winner) || bypassed === null) {
    return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "COMPATIBLE_DISPATCH shape is malformed"));
  }
  const seen = new Set<string>();
  const bypassedIds: string[] = [];
  for (const id of bypassed) {
    if (!isFairnessId(id) || id === winner || seen.has(id)) {
      return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "bypassedTicketIds are malformed"));
    }
    seen.add(id);
    bypassedIds.push(id);
  }
  const ticketsById = new Map(state.tickets.map((ticket) => [ticket.ticketId, ticket]));
  const winnerTicket = ticketsById.get(winner);
  if (winnerTicket === undefined) {
    return fail(makeIssue("FAIRNESS_UNKNOWN_TICKET", "unknown dispatch winner", [winner]));
  }
  if (!winnerTicket.dispatchable) {
    return fail(makeIssue("FAIRNESS_STALE_EVENT", "winner is not dispatchable", [winner]));
  }
  const selected = selectNext(state);
  if (selected === null || selected.ticketId !== winner) {
    return fail(
      makeIssue(
        "FAIRNESS_DISPATCH_ORDER_VIOLATION",
        "dispatch winner is not the selected ticket",
        [winner, ...(selected === null ? [] : [selected.ticketId])],
      ),
    );
  }
  for (const id of bypassedIds) {
    const t = ticketsById.get(id);
    if (t === undefined) {
      return fail(makeIssue("FAIRNESS_UNKNOWN_TICKET", "unknown bypassed ticket", [id]));
    }
    if (!t.dispatchable) {
      return fail(makeIssue("FAIRNESS_STALE_EVENT", "bypassed ticket is not dispatchable", [id]));
    }
  }
  if (bypassedIds.length > Math.max(0, state.dispatchableCount - 1)) {
    return fail(makeIssue("FAIRNESS_EVENT_LIMIT_EXCEEDED", "dispatch evidence exceeds live cardinality"));
  }
  // Age in deterministic (workItemId, ticketId) order so forced entry events are stable.
  const order = [...bypassedIds].sort((a, b) => {
    const ta = ticketsById.get(a)!;
    const tb = ticketsById.get(b)!;
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
    const result = ageOne(ticketsById.get(id)!, seq);
    if (result === null) {
      return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "eventSeq cannot be incremented safely"));
    }
    aged.set(id, result.ticket);
    seq = result.seq;
  }
  const tickets = state.tickets
    .filter((t) => t.ticketId !== winner)
    .map((t) => aged.get(t.ticketId) ?? t);
  return ok({
    ...state,
    policyMd: state.policyMd,
    eventSeq: seq,
    dispatchableCount: state.dispatchableCount - 1,
    tickets: sortTickets(tickets),
  });
}

/** Apply one caller-confirmed event to a frozen state; never mutates the input. */
export function applyEvent(state: FairnessState, event: unknown): FairnessResult {
  const safeEvent = readDataRecord(event);
  if (safeEvent === null || typeof safeEvent["kind"] !== "string") {
    return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "event must be a record with a string kind"));
  }
  try {
    if (
      state.projectCeilingMd !== DEFAULT_M_D ||
      !isNonNegativeInteger(state.policyMd) ||
      state.policyMd < 1 ||
      state.policyMd > state.projectCeilingMd ||
      !isNonNegativeInteger(state.eventSeq) ||
      !isNonNegativeInteger(state.dispatchableCount) ||
      state.dispatchableCount > state.policyMd ||
      !(state.dimension === null || isFairnessId(state.dimension)) ||
      !Array.isArray(state.tickets) ||
      state.tickets.length > MAX_FAIRNESS_EVENTS_PER_REDUCTION
    ) {
      return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "state header is malformed"));
    }
    switch (safeEvent["kind"]) {
      case "ADMIT":
        return applyAdmit(state, safeEvent);
      case "COMPATIBLE_DISPATCH":
        return applyDispatch(state, safeEvent);
      case "LOSE_DISPATCHABILITY":
        return applyLose(state, safeEvent);
      case "REGAIN_DISPATCHABILITY":
        return applyRegain(state, safeEvent);
      case "TERMINATE":
        return applyTerminate(state, safeEvent);
      case "RAISE_CAP":
        if (!(hasExactKeys(safeEvent, RAISE_CAP_KEYS) || hasExactKeys(safeEvent, RAISE_CAP_MIGRATION_KEYS))) {
          return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "RAISE_CAP shape is malformed"));
        }
        return applyRaiseCap(state, safeEvent);
      default:
        return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "unknown event kind"));
    }
  } catch {
    return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "state could not be read safely"));
  }
}

/** Fold an event stream from a fresh state; fail-closed on the first bad event. */
export function reduceEvents(events: unknown, policyMd?: number): FairnessResult {
  if (arrayLengthExceeds(events, MAX_FAIRNESS_EVENTS_PER_REDUCTION)) {
    return fail(makeIssue("FAIRNESS_EVENT_LIMIT_EXCEEDED", "event stream exceeds the reduction limit"));
  }
  const safeEvents = readDataArray(events, MAX_FAIRNESS_EVENTS_PER_REDUCTION);
  if (safeEvents === null) {
    return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "events must be an array"));
  }
  if (policyMd !== undefined && (!isNonNegativeInteger(policyMd) || policyMd < 1)) {
    return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "policyMd must be a positive integer"));
  }
  if (policyMd !== undefined && policyMd > DEFAULT_M_D) {
    return fail(makeIssue("FAIRNESS_PROJECT_CEILING_EXCEEDED", "policyMd exceeds the project ceiling"));
  }
  let state = emptyFairnessState(policyMd);
  for (const event of safeEvents) {
    const result = applyEvent(state, event);
    if (!result.ok) {
      return result;
    }
    state = result.state;
  }
  return ok(state);
}
