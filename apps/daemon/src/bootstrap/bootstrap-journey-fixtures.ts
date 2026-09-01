/**
 * The finalize-routing fixtures: the index of the journey's finalize request, an index-keyed
 * drive, and the world that deliberately stops short of finalizing.
 *
 * Split out of `bootstrap-test-fixtures.ts` to keep that harness nearer the per-file cap. The
 * dependency runs ONE WAY - this module reads the sequence, the harness does not read back -
 * so nothing here can be pulled into an import cycle.
 */
import type { SqliteEventStore } from "@moe/store";

import { seedActivationWorldWithGatePolicy } from "../activation/activation-world-fixtures.js";
import { readDurableLedger } from "./bootstrap-ledger.js";
import { graphBodyAggregateId } from "../planning/graph-body-record.js";
import {
  PROJECT_ID,
  RUN_ID,
  SEALED_GRAPH_CONTENT_HASH,
  bootstrapSequence,
  envelope,
  openStore,
  planningChain,
  send,
} from "./bootstrap-test-fixtures.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
 * THE SAME WORLD, PLANTED — a run PROPOSED WITHOUT AUTHORITY BODIES as a PRE-FLIP daemon wrote it.
 *
 * `authorityLessProposedStore()` above can no longer produce this world: since task-16a6a2b1 the
 * propose seam REFUSES an authority-less terminal (PLANNING_AUTHORITY_REQUIRED), so that seeder's
 * meaning has changed from "the authority-less world" to "the refusal control's operand", and it
 * is kept for exactly that. Every consumer that needs the WORLD rather than the REFUSAL comes
 * here instead.
 *
 * WHY THIS IS NOT A FIXTURE PRETENDING PRODUCTION REACHES IT. Runs proposed before the flip are
 * real durable history: they exist in any store written by an earlier daemon, and the guards that
 * refuse them (task-2cc6c59d's INCONSISTENCY arm, the finalize seam's authority-absent arm,
 * task-074e6d2e's EMPTY-aggregate axis) must keep working against those bytes. Per the
 * task-93e8aab3 retirement ruling: a guard production can no longer trigger is fine to keep; a
 * TEST claiming production still reaches it is not. Every arm seeded from here says so.
 *
 * CAPTURED, NOT REIMPLEMENTED. The run events are read back out of a store driven by PRODUCTION
 * through the shipped sequence, then replayed onto a fresh store with the `authority` member
 * stripped from the sealed submission — which is precisely the one thing a pre-flip propose left
 * out. Nothing here hand-builds a planning event, so a change to what `plan.propose` writes moves
 * this world with it instead of silently freezing a stale shape. (Same technique as
 * `planning-authority-reader-test-fixtures.ts`'s `replicaStore`, and for the same reason.)
 */
export function legacyProposedStore(): SqliteEventStore {
  const store = openStore();
  driveTo(store, finalizeRequestIndex() - 1);
  const carried = store.readEvents(RUN_ID).length;

  const source = openStore();
  driveTo(source, finalizeRequestIndex());
  const proposed = source.readEvents(RUN_ID).slice(carried);
  if (proposed.length === 0) throw new Error("the shipped propose wrote no run event to replay");
  const sealed = readDurableLedger(source, PROJECT_ID).aggregates.get(RUN_ID);
  if (sealed === undefined) throw new Error("the shipped propose wrote no durable decision");

  // A DECISION, not a bare event append: the consumers read `aggregates.get(RUN_ID).result`, and
  // a store carrying events with no decision row is a shape no daemon has ever written.
  const payload = { commands: planningChain(), runId: RUN_ID };
  store.commitExpectedVersionDecision({
    commandKind: PROPOSE_KIND,
    committedResultBytes: encoder.encode(JSON.stringify(withoutSealedFields(sealed.result))),
    correlationId: "corr-1",
    decidedAt: "2026-08-08T00:00:00.000Z",
    events: proposed.map((event) => ({
      eventId: `legacy-${event.eventId}`,
      eventType: event.eventType,
      payload: encoder.encode(JSON.stringify(withoutAuthority(
        JSON.parse(decoder.decode(event.payload)) as unknown,
      ))),
    })),
    expectedVersion: store.getAggregateVersion(RUN_ID),
    key: { commandId: "cmd-legacy-propose", principalId: "principal-1", projectId: PROJECT_ID },
    requestBytes: encoder.encode(JSON.stringify({ kind: PROPOSE_KIND, payload })),
    targetAggregateId: RUN_ID,
  });
  // CAPTURED TOO, for the same reason the run events are. The graph BODY lives on its own
  // content-addressed aggregate, so stripping the authority member never touched it — a pre-flip
  // propose that sealed this graph still recorded its bytes. Copying it keeps this world's one
  // deliberate absence (`authority`) the only thing missing: without it the finalize seam refuses
  // RUN_POLICY_GRAPH_UNAVAILABLE and the authority-ABSENT arms would be grading a graph-absent
  // world instead.
  const bodyAggregate = graphBodyAggregateId(PROJECT_ID, SEALED_GRAPH_CONTENT_HASH);
  for (const event of source.readEvents(bodyAggregate)) {
    store.commit({
      aggregateId: bodyAggregate,
      commandBytes: encoder.encode("legacy-graph-body"),
      commandId: `legacy-${event.eventId}`,
      committedAt: "2026-08-08T00:00:00.000Z",
      events: [{ eventId: event.eventId, eventType: event.eventType, payload: event.payload }],
      expectedVersion: store.getAggregateVersion(bodyAggregate),
    });
  }
  return store;
}

const PROPOSE_KIND = "plan.propose";

/**
 * The three fields the authority leg contributes to the propose result. A pre-flip propose
 * carried `{}` where the binding now goes, so a legacy result has none of them — which is the
 * property `bootstrap-finalize-journey`'s negative control reads.
 */
const SEALED_RESULT_FIELDS = Object.freeze(["authorityRef", "bodiesDigest", "envelopeDigest"]);

function withoutSealedFields(result: unknown): unknown {
  if (result === null || typeof result !== "object") return result;
  const stripped: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  for (const field of SEALED_RESULT_FIELDS) delete stripped[field];
  return stripped;
}

/**
 * Drops the `authority` member wherever the sealed submission carries it. A pre-flip propose
 * never wrote one — that absence IS the world, and it is what the legacy pin asserted before
 * task-16a6a2b1 re-graded it into a refusal control.
 */
function withoutAuthority(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map((entry) => withoutAuthority(entry));
  if (payload === null || typeof payload !== "object") return payload;
  const stripped: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  delete stripped["authority"];
  return stripped;
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
    // THE FUNDED WORLD LANDS BEFORE THE APPROVAL (task-1de7b81a), and the order is load-bearing.
    // `approval.decide` now establishes the project's budget root, and a root is ONCE-ONLY with
    // no reducer in `@moe/scheduler` able to add units to one: `openBudgetRoot` is the only
    // unit-creating transition. A journey approved before its world is seeded therefore holds
    // the zero-amount genesis root permanently, and every later `effect.activate` in it refuses
    // BUDGET_LEDGER_TRANSITION_REFUSED. The witnessless HUMAN_APPROVAL world is this harness's
    // stand-in for the grant that mints real units; this loop sends the approval itself next.
    if (request.kind === "approval.decide") {
      seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
    }
    const outcome = send(store, request);
    if (!outcome.ok) {
      throw new Error(`fixture setup failed at ${request.kind}: ${outcome.code}`);
    }
  }
}
