/**
 * The finalize-routing fixtures: the index of the journey's finalize request, an index-keyed
 * drive, and the world that deliberately stops short of finalizing.
 *
 * Split out of `bootstrap-test-fixtures.ts` to keep that harness nearer the per-file cap. The
 * dependency runs ONE WAY - this module reads the sequence, the harness does not read back -
 * so nothing here can be pulled into an import cycle.
 */
import type { SqliteEventStore } from "@moe/store";

import {
  RUN_ID,
  bootstrapSequence,
  envelope,
  openStore,
  planningChain,
  send,
} from "./bootstrap-test-fixtures.js";

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
 * A run PROPOSED WITHOUT AUTHORITY BODIES, on the AUTHORITY axis (task-074e6d2e).
 *
 * The omission is the point and must not be "fixed". `bootstrapSequence()` now proposes through
 * `sealedPlanningChain()`, so without this seeder no world in the daemon would reach a durable
 * proposal whose authority aggregate is EMPTY. Two named consumers depend on that world being
 * reachable:
 *   - the ABSENT branch of `buildPlanningAuthorityLeg` (planning-authority-persistence.ts:189),
 *     which is also what the legacy pin at planning-authority-persistence.test.ts:257-274 asserts
 *     byte-identically; and
 *   - task-2cc6c59d's INCONSISTENCY refusal, which needs an unsealed run to refuse ON.
 * A guard whose only world has been enriched away is green forever and killable by deleting the
 * check, which is exactly how a negative world dies looking like a bug being fixed.
 *
 * The chain is `planningChain()` itself — the authority-LESS shared builder, byte-identical to
 * what it was before this row. Nothing is mutated or hand-shortened here: the world IS the
 * builder, so a later edit that seals the shared builder reddens this seeder rather than
 * quietly turning it positive.
 *
 * The axis matters because two other rows designate negative worlds on OTHER axes, and neither
 * is a candidate for this one's treatment: task-acc1a3b4's are negative on the BUDGET axis
 * (`seedActivationWorldWithoutGraph` / `seedActivationWorldWithoutGoal`), and task-f216f085's is
 * `proposedNotFinalizedStore` above, negative on the LIFECYCLE axis. This world is fully
 * finalizable and fully budget-enriched; it is negative on AUTHORITY only.
 */
export function authorityLessProposedStore(): SqliteEventStore {
  const store = openStore();
  driveTo(store, finalizeRequestIndex() - 1);
  const outcome = send(store, envelope("plan.propose", 0, {
    commands: planningChain(), runId: RUN_ID,
  }));
  if (!outcome.ok) {
    throw new Error(`authority-less proposal refused: ${outcome.code}`);
  }
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
