import { canonicalize } from "../canonical-json.js";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import {
  FAIRNESS_REFERENCE_KIND,
  type FairnessResult,
  type FairnessState,
  type FairnessTicket,
} from "./fairness-model.js";
import {
  deepFreeze,
  fail,
  isRecord,
  makeIssue,
  sortTickets,
} from "./fairness-internal.js";
import { hasExactKeys, isFairnessId } from "./fairness-input.js";
import {
  BYPASSES_PER_LEVEL,
  DEFAULT_M_D,
  isFairnessPriority,
  isNonNegativeInteger,
} from "./fairness-policy.js";

const encoder = new TextEncoder();

const TICKET_KEYS = [
  "ticketId",
  "workItemId",
  "dimension",
  "priority",
  "bypassesInLevel",
  "forced",
  "forcedCohortEntryEvent",
  "dispatchable",
  "continuousEligibilityEvent",
  "migratedBoundAtMost",
] as const;
const STATE_KEYS = [
  "kind",
  "dimension",
  "projectCeilingMd",
  "policyMd",
  "eventSeq",
  "dispatchableCount",
  "tickets",
] as const;

/** Canonical, deterministic serialization of a reduced state (restart evidence). */
export function toCanonicalBytes(state: FairnessState): Uint8Array {
  return encoder.encode(canonicalize({
    kind: FAIRNESS_REFERENCE_KIND,
    dimension: state.dimension,
    projectCeilingMd: state.projectCeilingMd,
    policyMd: state.policyMd,
    eventSeq: state.eventSeq,
    dispatchableCount: state.dispatchableCount,
    tickets: sortTickets(state.tickets),
  }));
}

/** Read one ticket, returning a normalized frozen ticket or null when malformed. */
function readTicket(raw: unknown): FairnessTicket | null {
  if (!isRecord(raw) || !hasExactKeys(raw, TICKET_KEYS)) {
    return null;
  }
  const {
    ticketId,
    workItemId,
    dimension,
    priority,
    bypassesInLevel,
    forced,
    forcedCohortEntryEvent,
    dispatchable,
    continuousEligibilityEvent,
    migratedBoundAtMost,
  } = raw;
  if (
    !isFairnessId(ticketId) ||
    !isFairnessId(workItemId) ||
    !isFairnessId(dimension) ||
    !isFairnessPriority(priority) ||
    !isNonNegativeInteger(bypassesInLevel) ||
    bypassesInLevel >= BYPASSES_PER_LEVEL ||
    typeof forced !== "boolean" ||
    typeof dispatchable !== "boolean" ||
    !isNonNegativeInteger(continuousEligibilityEvent) ||
    !(forcedCohortEntryEvent === null || isNonNegativeInteger(forcedCohortEntryEvent)) ||
    !(migratedBoundAtMost === null || isNonNegativeInteger(migratedBoundAtMost))
  ) {
    return null;
  }
  // Active-cohort invariant: an entry event exists iff forced AND dispatchable.
  const inActiveCohort = forced && dispatchable;
  if (inActiveCohort !== (forcedCohortEntryEvent !== null)) {
    return null;
  }
  // Forced tickets are only ever reached at P0 with a reset counter; reject any
  // snapshot claiming a forced ticket the reducer could never have produced.
  if (forced && (priority !== "P0" || bypassesInLevel !== 0)) {
    return null;
  }
  return {
    ticketId,
    workItemId,
    dimension,
    priority,
    bypassesInLevel,
    forced,
    forcedCohortEntryEvent,
    dispatchable,
    continuousEligibilityEvent,
    migratedBoundAtMost,
  };
}

/** Strict, fail-closed reconstruction; round-trips to byte-identical output. */
export function fromCanonicalBytes(input: unknown): FairnessResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) {
    return fail(makeIssue("FAIRNESS_MALFORMED_STATE", `bounded JSON rejected: ${decoded.code}`));
  }
  let snapshot: Uint8Array;
  try {
    snapshot = Reflect.apply(Uint8Array.prototype.slice, input, []) as Uint8Array;
  } catch {
    return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "input is not stable canonical bytes"));
  }
  const canonicalInput = encoder.encode(canonicalize(decoded.value));
  if (
    snapshot.byteLength !== canonicalInput.byteLength ||
    snapshot.some((byte, index) => byte !== canonicalInput[index])
  ) {
    return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "input is not canonical JSON bytes"));
  }
  const parsed: unknown = decoded.value;
  if (!isRecord(parsed) || !hasExactKeys(parsed, STATE_KEYS)) {
    return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "payload must be an object with exactly the state keys"));
  }
  const {
    kind,
    dimension: stateDimension,
    projectCeilingMd,
    policyMd,
    eventSeq,
    dispatchableCount,
    tickets,
  } = parsed;
  if (kind !== FAIRNESS_REFERENCE_KIND) {
    return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "unexpected or missing kind tag"));
  }
  if (
    !(stateDimension === null || isFairnessId(stateDimension)) ||
    projectCeilingMd !== DEFAULT_M_D ||
    !isNonNegativeInteger(policyMd) ||
    policyMd < 1 ||
    policyMd > projectCeilingMd ||
    !isNonNegativeInteger(eventSeq) ||
    !isNonNegativeInteger(dispatchableCount) ||
    !Array.isArray(tickets)
  ) {
    return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "top-level fields are malformed"));
  }
  const normalized: FairnessTicket[] = [];
  const ids = new Set<string>();
  let live = 0;
  let dimension: string | undefined;
  let maxEvent = 0;
  for (const raw of tickets) {
    const ticket = readTicket(raw);
    if (ticket === null) {
      return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "a ticket is malformed"));
    }
    if (ids.has(ticket.ticketId)) {
      return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "duplicate ticketId", [ticket.ticketId]));
    }
    ids.add(ticket.ticketId);
    // A state is scoped to one persisted compatibility dimension.
    if (dimension === undefined) {
      dimension = ticket.dimension;
    } else if (ticket.dimension !== dimension) {
      return fail(
        makeIssue("FAIRNESS_MALFORMED_STATE", "tickets span multiple dimensions", [ticket.ticketId]),
      );
    }
    const event = Math.max(ticket.continuousEligibilityEvent, ticket.forcedCohortEntryEvent ?? 0);
    if (event > maxEvent) {
      maxEvent = event;
    }
    if (ticket.dispatchable) {
      live += 1;
    }
    normalized.push(ticket);
  }
  if ((dimension !== undefined && dimension !== stateDimension) || (dimension !== undefined && stateDimension === null)) {
    return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "ticket dimension differs from state identity"));
  }
  if (live !== dispatchableCount || dispatchableCount > policyMd) {
    return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "dispatchableCount is inconsistent"));
  }
  // eventSeq is a monotonic high-water mark; a snapshot claiming a smaller value
  // than a ticket's own events could let a resumed forced ticket overtake an
  // earlier one, breaking the FIFO starvation order. Reject it.
  if (eventSeq < maxEvent) {
    return fail(makeIssue("FAIRNESS_MALFORMED_STATE", "eventSeq is below a ticket event"));
  }
  return deepFreeze({
    ok: true,
    state: {
      dimension: stateDimension,
      projectCeilingMd,
      policyMd,
      eventSeq,
      dispatchableCount,
      tickets: sortTickets(normalized),
    },
  });
}
