/**
 * DEVELOPMENT_ONLY fixtures for the fairness aging reference tests. Synthetic,
 * `fx-` prefixed; NOT a benchmark corpus and never confirmatory evidence.
 */

import { deepFreeze, sortTickets } from "./fairness-internal.js";
import type {
  FairnessEvent,
  FairnessPriority,
  FairnessState,
  FairnessTicket,
} from "./fairness-model.js";
import { BYPASSES_PER_LEVEL, DEFAULT_M_D } from "./fairness-policy.js";

export function fxAdmit(
  ticketId: string,
  workItemId = `wi-${ticketId}`,
  dimension = "fx-dim",
  startingPriority?: FairnessPriority,
): FairnessEvent {
  return startingPriority === undefined
    ? { kind: "ADMIT", ticketId, workItemId, dimension }
    : { kind: "ADMIT", ticketId, workItemId, dimension, startingPriority };
}

export function fxDispatch(
  winnerTicketId: string,
  bypassedTicketIds: readonly string[],
): FairnessEvent {
  return { kind: "COMPATIBLE_DISPATCH", winnerTicketId, bypassedTicketIds };
}

export function fxLose(ticketId: string): FairnessEvent {
  return { kind: "LOSE_DISPATCHABILITY", ticketId };
}

export function fxRegain(ticketId: string): FairnessEvent {
  return { kind: "REGAIN_DISPATCHABILITY", ticketId };
}

export function fxTerminate(ticketId: string): FairnessEvent {
  return { kind: "TERMINATE", ticketId };
}

export function fxRaiseCap(
  newMd: number,
  migrations?: readonly { readonly ticketId: string; readonly boundAtMost: number }[],
): FairnessEvent {
  return migrations === undefined
    ? { kind: "RAISE_CAP", newMd }
    : { kind: "RAISE_CAP", newMd, migrations };
}

/**
 * Emit the events that accrue `count` compatible bypasses to `targetId`. Each
 * bypass is a compatible dispatch of a fresh disposable pump ticket that lists
 * only `targetId` as bypassed, so nothing else ages.
 */
export function fxBypass(
  targetId: string,
  count: number,
  dimension = "fx-dim",
): FairnessEvent[] {
  const events: FairnessEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    const pump = `fx-pump-${targetId}-${i}`;
    events.push(fxAdmit(pump, `!${pump}`, dimension, "P0"));
    events.push(fxDispatch(pump, [targetId]));
  }
  return events;
}

/** Events that drive a fresh P3 target all the way into the forced cohort. */
export function fxForce(targetId: string, dimension = "fx-dim"): FairnessEvent[] {
  return fxBypass(targetId, BYPASSES_PER_LEVEL * 4, dimension);
}

/**
 * Build a state with exactly `n` dispatchable P3 tickets directly (O(n), no
 * per-event folding), for cap-boundary tests. `dispatchableCount` is set to `n`
 * so the admission cap check is exercised without traversal.
 */
export function fxStateWithNDispatchable(n: number, policyMd: number): FairnessState {
  const tickets: FairnessTicket[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `fx-t-${String(i).padStart(6, "0")}`;
    tickets.push({
      ticketId: id,
      workItemId: `wi-${id}`,
      dimension: "fx-dim",
      priority: "P3",
      bypassesInLevel: 0,
      forced: false,
      forcedCohortEntryEvent: null,
      dispatchable: true,
      continuousEligibilityEvent: i,
      migratedBoundAtMost: null,
    });
  }
  return deepFreeze({
    dimension: "fx-dim",
    projectCeilingMd: DEFAULT_M_D,
    policyMd,
    eventSeq: n,
    dispatchableCount: n,
    tickets,
  });
}

/**
 * Build a state whose active forced cohort is exactly `entries` (all P0, forced,
 * dispatchable), so a test can pin selection/FIFO order — including the
 * `workItemId` tie-break when two share a `forcedCohortEntryEvent`. Reducer
 * events cannot produce a shared entry event (it is monotonic), so this direct
 * builder is the only way to exercise the tie-break.
 */
export function fxForcedCohortState(
  entries: readonly {
    readonly ticketId: string;
    readonly workItemId: string;
    readonly forcedCohortEntryEvent: number;
  }[],
): FairnessState {
  const tickets: FairnessTicket[] = entries.map((e) => ({
    ticketId: e.ticketId,
    workItemId: e.workItemId,
    dimension: "fx-dim",
    priority: "P0",
    bypassesInLevel: 0,
    forced: true,
    forcedCohortEntryEvent: e.forcedCohortEntryEvent,
    dispatchable: true,
    continuousEligibilityEvent: e.forcedCohortEntryEvent,
    migratedBoundAtMost: null,
  }));
  let maxSeq = 0;
  for (const e of entries) {
    if (e.forcedCohortEntryEvent > maxSeq) {
      maxSeq = e.forcedCohortEntryEvent;
    }
  }
  return deepFreeze({
    dimension: "fx-dim",
    projectCeilingMd: DEFAULT_M_D,
    policyMd: DEFAULT_M_D,
    eventSeq: maxSeq + 1,
    dispatchableCount: tickets.length,
    tickets: sortTickets(tickets),
  });
}
