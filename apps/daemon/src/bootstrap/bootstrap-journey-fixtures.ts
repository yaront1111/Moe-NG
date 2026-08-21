/**
 * The finalize-routing fixtures: the index of the journey's finalize request, an index-keyed
 * drive, and the world that deliberately stops short of finalizing.
 *
 * Split out of `bootstrap-test-fixtures.ts` to keep that harness nearer the per-file cap. The
 * dependency runs ONE WAY - this module reads the sequence, the harness does not read back -
 * so nothing here can be pulled into an import cycle.
 */
import type { SqliteEventStore } from "@moe/store";

import { bootstrapSequence, openStore, send } from "./bootstrap-test-fixtures.js";

/**
 * A run that has PROPOSED but DELIBERATELY NOT FINALIZED, on the LIFECYCLE axis.
 *
 * The omission is the point and must not be "fixed". `bootstrapSequence()` now finalizes, so
 * without this seeder no world in the daemon would sit at a non-PLAN_REVIEW lifecycle with a
 * null `graphRevisionRef`, and any guard that refuses such a run would be green forever and
 * killable by deleting the check. task-2cc6c59d's not-PLAN_REVIEW refusal arm is the named
 * consumer; this is its operand.
 *
 * The axis matters because a second row is designating negative worlds at the same time.
 * task-acc1a3b4's are negative on the BUDGET axis (no durable ACTIVE graph, no budget root).
 * This one is negative on the LIFECYCLE axis only — it is fully graph- and budget-enriched if
 * its consumer enriches it, and it is NOT a candidate for a finalize terminal, just as their
 * budget-negative worlds are not candidates for this one.
 */
export function proposedNotFinalizedStore(): SqliteEventStore {
  const store = openStore();
  driveTo(store, finalizeRequestIndex());
  return store;
}

/**
 * The finalize request's position, DERIVED from the sequence rather than pinned: a hand-written
 * index would silently start seeding a different world the moment a command is inserted before
 * it, and this world's whole value is which command it stops short of.
 */
export function finalizeRequestIndex(): number {
  const index = bootstrapSequence().findIndex((request) => request.commandId === "cmd-finalize");
  if (index < 0) throw new Error("bootstrapSequence issues no finalize request");
  return index;
}

/**
 * Drives the first `index` requests of the durable sequence. `driveThrough` keys on KIND and so
 * stops at the FIRST request of that kind — since the journey now issues `plan.propose` twice
 * (the proposal, then the finalize terminal), a caller that already holds an index must say so
 * rather than let the kind lookup silently rewind it to the earlier request.
 */
export function driveTo(store: SqliteEventStore, index: number): void {
  for (const request of bootstrapSequence().slice(0, index)) {
    const outcome = send(store, request);
    if (!outcome.ok) {
      throw new Error(`fixture setup failed at ${request.kind}: ${outcome.code}`);
    }
  }
}
