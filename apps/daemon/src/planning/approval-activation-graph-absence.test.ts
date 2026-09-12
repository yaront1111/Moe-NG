/**
 * ACTIVE_GRAPH_ABSENT AFTER AN ORDINARY PLAN APPROVAL IS THE INTENDED STATE — task-c055f6af.
 *
 * The row this suite discharges asked a yes/no question: should plan approval leave an active
 * graph revision? The answer is NO. `graph.approve` owns that transition and always commits the
 * revision leg (`graph-activation-service.ts:240`); plan approval's durable effect is
 * `GoalExecutionEnabled` on the goal. Two commands writing the same projection would put
 * current-graph authority in two places that could disagree, with fifteen production readers
 * resolving against it and no way to adjudicate. `approval-activation.ts`'s header carries the
 * decision and its reasoning; these arms make it a gate rather than a comment.
 *
 * WHAT THIS SUITE IS FOR. Nothing on the tree used to say WHICH answer was intended, so
 * `gates-unattended-fixtures.ts` once FABRICATED a revision after approval to compensate
 * (deleted by task-510340a3). If a future change silently starts activating a revision on this
 * path, arm (a) reds naming ACTIVE_GRAPH_ABSENT — the decision cannot drift back out of the tree
 * unnoticed.
 *
 * WHY AN ABSENCE ARM NEEDS TWO POSITIVE ASSERTIONS BESIDE IT, both present in arm (a). An
 * absence is the easiest thing in the world to satisfy accidentally: it stays green if the world
 * was never built, if the approval silently refused, or if the read was never reached. So arm (a)
 * also asserts the approval COMMITTED and reached EXECUTION_ENABLED, and arm (b) proves the very
 * same read answers OK once a revision IS active — so "absent" here is a measurement of this
 * path, not an inability of the reader.
 *
 * THE REFUSAL THIS SUITE DOES NOT ASSERT. The policy-risk omission that motivated the parent row
 * is pinned by `policy-risk-observability.test.ts` (task-c7a66b70), which measured its code and
 * layer against the real run. That suite is the single owner of that assertion and this one names
 * no policy-risk code at all — not even the measured one — because a second copy is a second
 * place to update, and a copy living in a COMMENT is the worse of the two: nothing reds when it
 * goes stale. This suite owns the graph-revision half of the same story only.
 */

import { afterEach, describe, expect, it } from "vitest";

import { seedActivationGraph } from "../activation/activation-world-fixtures.js";
import { GOAL_ID, PROJECT_ID, closeStores, journeyWorld } from "../gates-journey-fixtures.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import {
  ACTIVE_GRAPH_PROJECTION_LAYER,
  graphRevisionAggregateId,
  readCurrentActiveGraph,
} from "./active-graph-projection.js";

/** Only goals plan approval actually enabled; a goal short of it contributes nothing. */
const ENABLED = new Set(["EXECUTION_ENABLED"]);

/**
 * NO `expectApprovalCommitted` HELPER, DELIBERATELY. The commit assertions are written out inside
 * each arm that asserts an absence, because that pairing is the whole guard: an absence arm whose
 * "the world was really built" half sits in a shared helper can be silently decoupled from it by
 * one edit, and the arm then passes on a world that never ran. Two duplicated lines are the price
 * of the two facts being impossible to separate.
 */

afterEach(() => {
  closeStores();
});

describe("plan approval deliberately leaves no active graph revision (task-c055f6af)", () => {
  // (a) DoD 4. The ordinary journey, driven by the PRODUCTION approval, and the state it leaves.
  it("answers ACTIVE_GRAPH_ABSENT @ ACTIVE_GRAPH_PROJECTION after an ordinary approval", () => {
    const world = journeyWorld("SUBMITTED");

    // THE APPROVAL COMMITTED, in THIS arm, because "nothing ran" is otherwise indistinguishable
    // from "the graph is correctly absent". Two independent durable facts: the goal carries
    // exactly one `GoalExecutionEnabled` event — the decision's own primary leg, the very event
    // this path's header names — and a production reader admitting only EXECUTION_ENABLED goals
    // finds this one.
    expect(world.store.readEvents(GOAL_ID)
      .filter((event) => event.eventType === "GoalExecutionEnabled")).toHaveLength(1);
    expect(activeCompiledGraphs(world.store, PROJECT_ID, ENABLED).map((graph) => graph.goalRef))
      .toContain(GOAL_ID);
    // THE CODE AND THE LAYER, per this epic's refusal rail. `ok: false` alone would stay green on
    // ACTIVE_GRAPH_SPLIT_BRAIN or ACTIVE_GRAPH_BODY_UNAVAILABLE, which mean the opposite thing:
    // that a revision IS there and something is wrong with it.
    //
    // THIS ASSERTION COMES FIRST ON PURPOSE. The aggregate-list assertion below is strictly
    // coarser — a mutant that activates a revision trips it too — so putting it first would
    // short-circuit every drill before the code and layer were ever compared, and the pinned
    // refusal would go permanently unexercised behind a passing-looking suite.
    expect(readCurrentActiveGraph(world.store, PROJECT_ID)).toMatchObject({
      code: "ACTIVE_GRAPH_ABSENT",
      layer: ACTIVE_GRAPH_PROJECTION_LAYER,
      ok: false,
    });
    // THE MECHANISM, one layer below the projection: the decision committed no revision leg at
    // all, so there is no graph-revision aggregate for the projection to find. The projection's
    // verdict alone would stay green if a revision were committed in a non-ACTIVE lifecycle —
    // that is a different world, and this row did not decide it.
    expect(world.store.enumerateAggregateIdsByPrefix(graphRevisionAggregateId(PROJECT_ID, "")))
      .toStrictEqual([]);
  });

  // (b) DoD 6's in-suite half, and it survives the commit rather than living in a deleted probe.
  // SAME world, SAME store, SAME read — one ACTIVE revision added. If the reader could not answer
  // OK over a post-approval world, arm (a) would be measuring the reader instead of this path.
  it("answers OK over that same world once a revision IS active, so the absence is measured",
    () => {
      const world = journeyWorld("SUBMITTED");

      // Same pairing as arm (a), written out for the same reason: this arm's precondition is an
      // absence too, and an absence over an unbuilt world would make the seed below meaningless.
      expect(world.store.readEvents(GOAL_ID)
        .filter((event) => event.eventType === "GoalExecutionEnabled")).toHaveLength(1);
      expect(activeCompiledGraphs(world.store, PROJECT_ID, ENABLED).map((graph) => graph.goalRef))
        .toContain(GOAL_ID);
      expect(readCurrentActiveGraph(world.store, PROJECT_ID)).toMatchObject({
        code: "ACTIVE_GRAPH_ABSENT", layer: ACTIVE_GRAPH_PROJECTION_LAYER, ok: false,
      });

      seedActivationGraph(world.store);

      const read = readCurrentActiveGraph(world.store, PROJECT_ID);
      expect(read.ok, read.ok ? "" : `${read.code} @ ${read.layer}`).toBe(true);
      expect(world.store.enumerateAggregateIdsByPrefix(graphRevisionAggregateId(PROJECT_ID, "")))
        .toHaveLength(1);
    });
});
