import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

/**
 * The goal's CURRENT planning run (task-3780109).
 *
 * The durable goal record carries ONE immutable `planningRunRef`, so every reader that starts at
 * the goal — the offer ladder, the board, the activity feed — lands on the run the goal was
 * created with. Once that run is REJECTED its successor is the run that matters, and the
 * successor id lives on the REJECTION EVENT (`rejectRun`, packages/core planning-results.ts) and
 * NOT on the run's state, so following the chain is a read over the run aggregate's own history
 * and needs no new durable write anywhere.
 *
 * IT NEVER THROWS AND NEVER LOOPS. This resolver sits under read paths that must answer even when
 * the store is mid-write or a payload is malformed, so every failure degrades to the LAST GOOD id
 * with `unreadable: true` rather than propagating: a read path that throws takes a whole screen
 * down, while a read path that answers the last known run is merely stale. The walk is bounded by
 * {@link CURRENT_RUN_HOP_LIMIT} and by a seen-set, so neither a long chain nor a cycle — which a
 * hand-written or restored aggregate could produce — can spin.
 */

/** Bounded so a corrupt or hostile chain costs a constant number of reads. */
export const CURRENT_RUN_HOP_LIMIT = 16;

const REJECTED_EVENT_KIND = "PlanningRunRejected";

export interface RejectedRunHop {
  readonly runId: string;
  readonly successorRunId: string;
}

export interface CurrentPlanningRun {
  readonly hops: number;
  readonly rejected: readonly RejectedRunHop[];
  readonly runId: string;
  /** True when the walk stopped early: a cycle, an undecodable payload, or a failing read. */
  readonly unreadable: boolean;
}

/** Reads one aggregate's history, or `null` when it cannot be read at all. */
export type PlanningRunEventReader = (runId: string) => readonly StoredEvent[] | null;

const own = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};

/**
 * `hops` counts the moves this walk actually MADE, which is not always the number of rejections
 * it OBSERVED: a cycle's closing rejection is reported in `rejected` and deliberately not
 * followed, so the two differ by one exactly when the walk stopped on it.
 */
const answer = (
  runId: string, hops: number, rejected: readonly RejectedRunHop[], unreadable: boolean,
): CurrentPlanningRun => Object.freeze({
  hops,
  rejected: Object.freeze([...rejected]),
  runId,
  unreadable,
});

/**
 * The successor named by an aggregate's LAST event, or `null` when that event is not a rejection.
 *
 * The LAST event is what decides: an earlier rejection on the same aggregate would be a run that
 * was rejected and then written to again, and honouring the earlier hop would walk away from
 * whatever the newer writer established. `undefined` distinguishes "cannot be read" from "not a
 * rejection", because only the former makes the answer stale.
 */
function successorOf(events: readonly StoredEvent[]): string | null | undefined {
  const last = events[events.length - 1];
  if (last === undefined) return null;
  const decoded = decodeBoundedJsonBytes(last.payload);
  if (!decoded.ok) return undefined;
  if (own(decoded.value, "kind") !== REJECTED_EVENT_KIND) return null;
  const successorRunId = own(decoded.value, "successorRunId");
  return typeof successorRunId === "string" && successorRunId.length > 0
    ? successorRunId
    : undefined;
}

/**
 * The pure walk, over any reader. The store-backed variant below is a thin binding of it, so the
 * hop, cycle and decode rules are exercised without a database.
 */
export function foldCurrentRun(
  readEvents: PlanningRunEventReader,
  planningRunRef: string,
): CurrentPlanningRun {
  const rejected: RejectedRunHop[] = [];
  const seen = new Set<string>([planningRunRef]);
  let runId = planningRunRef;
  let hops = 0;
  while (hops < CURRENT_RUN_HOP_LIMIT) {
    let events: readonly StoredEvent[] | null;
    try {
      events = readEvents(runId);
    } catch {
      return answer(runId, hops, rejected, true);
    }
    // A missing history is only STALE once the walk has hopped: an id nothing was ever written
    // under is simply its own current run, which is what an unplanned goal reads as.
    if (events === null) return answer(runId, hops, rejected, hops > 0);
    const successorRunId = successorOf(events);
    if (successorRunId === undefined) return answer(runId, hops, rejected, true);
    if (successorRunId === null) return answer(runId, hops, rejected, false);
    rejected.push(Object.freeze({ runId, successorRunId }));
    // A cycle is REPORTED and then stopped on: the closing pair is real history worth naming,
    // while following it would revisit an id this walk already answered from.
    if (seen.has(successorRunId)) return answer(runId, hops, rejected, true);
    seen.add(successorRunId);
    runId = successorRunId;
    hops += 1;
  }
  return answer(runId, hops, rejected, true);
}

/** The store-backed resolver: an unreadable aggregate is stale, never a throw. */
export function currentPlanningRun(
  store: SqliteEventStore,
  planningRunRef: string,
): CurrentPlanningRun {
  return foldCurrentRun((runId) => store.readEvents(runId), planningRunRef);
}
