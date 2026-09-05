/**
 * The rejection reason a RE-STAFFED compiler seat reads in its mission (task-2c016c04).
 *
 * Every arm runs over a REAL store through `rejectedWorld`, and reads the run ids back through the
 * fixture's `currentPlanningRun`-derived answers rather than recomputing `successorRunIdFor`: an
 * arm that re-derived an id would assert the test's own arithmetic instead of the product's.
 *
 * The marker-fence arms live in `rejection-instructions-fence.test.ts`, which is where the hostile
 * half of this module is graded.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { refsOfGoal } from "../goals/goal-identity.js";
import { currentPlanningRun } from "./current-planning-run.js";
import {
  PROJECT_ID,
  RUN_ID,
  boundWorld,
  closeStores,
  rejectPlan,
  rejectedWorld,
  submit,
} from "./plan-reject-test-fixtures.js";
import {
  REJECTION_SENTENCE_TAIL, composeCompilerInstructions, latestRejectionReason,
} from "./rejection-instructions.js";

afterEach(closeStores);

const BRIEF = "Ship the widget read.\nThe operator wants one page per record.";

/** The exact sentence the seat must read, spelled once so no arm can drift from the product's. */
const sentenceFor = (reason: string): string =>
  `PLAN REJECTED by the operator: ${reason}. ${REJECTION_SENTENCE_TAIL}`;

/**
 * A store whose `readEvents` THROWS for one aggregate, so `foldCurrentRun`'s catch arm fires and
 * `currentPlanningRun` answers `unreadable: true` - the degraded read a corrupt or mid-write
 * aggregate produces, without having to corrupt one.
 *
 * Same Proxy technique and same reason as `compile-dispatcher-revision.test.ts:110`:
 * `SqliteEventStore` calls `Object.freeze(this)`, so a method cannot be shadowed by assignment,
 * but the methods live on the PROTOTYPE and are therefore interceptable. Every non-intercepted
 * member is forwarded BOUND TO THE REAL TARGET, which keeps the private `#core` field reachable.
 */
function corruptChainStore(store: SqliteEventStore, runId: string): SqliteEventStore {
  return new Proxy(store, {
    get(target, property, receiver): unknown {
      if (property === "readEvents") {
        return (aggregateId: string): unknown => {
          if (aggregateId === runId) throw new Error("injected read failure");
          return target.readEvents(aggregateId);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("latestRejectionReason over a real store", () => {
  it("answers null for a goal whose run was never rejected", () => {
    // `boundWorld` reaches a bound goal with an UNPLANNED run: nothing was ever submitted, so the
    // walk stops on run 1 with an empty `rejected` chain. This is the shape a first-time compiler
    // staffing reads, and it must produce no sentence at all.
    const store = boundWorld();
    expect(latestRejectionReason(store, PROJECT_ID, RUN_ID)).toBeNull();
  });

  it("answers the reason and the rejected run id after one rejection", () => {
    const world = rejectedWorld("the second slice is missing");
    const found = latestRejectionReason(world.store, PROJECT_ID, world.originalRunId);
    expect(found).toEqual({
      reason: "the second slice is missing",
      rejectedRunId: world.originalRunId,
    });
    // The walk starts at the goal's IMMUTABLE ref, which is the original run - not at the head.
    expect(world.originalRunId).toBe(RUN_ID);
  });

  it("answers the LATEST reason, not the first, after two rejections", () => {
    // The arm that catches a fold returning the first match. A single-rejection world cannot tell
    // `rejected[0]` from `rejected[rejected.length - 1]`, so this is the only shape that grades
    // the "latest" half of the contract.
    const world = rejectedWorld("the second slice is missing");
    const compiled = submit(world.store, world.ref);
    if (!compiled.ok) throw new Error(`submit refused: ${compiled.code} @ ${compiled.layer}`);
    const thirdRunId = rejectPlan(world.store, world.successorRunId, "still one node short");
    expect(thirdRunId).not.toBe(world.successorRunId);

    const found = latestRejectionReason(world.store, PROJECT_ID, world.originalRunId);
    expect(found).toEqual({
      reason: "still one node short",
      rejectedRunId: world.successorRunId,
    });
    // CONTROL: the FIRST reason is genuinely still readable on its own run, so the assertion above
    // is choosing between two live answers rather than reading the only one that exists.
    expect(latestRejectionReason(world.store, PROJECT_ID, world.successorRunId)).toEqual({
      reason: "still one node short",
      rejectedRunId: world.successorRunId,
    });
    expect(currentPlanningRun(world.store, world.originalRunId).rejected).toHaveLength(2);
  });

  it("answers null on a corrupt run chain and never throws", () => {
    const world = rejectedWorld("the second slice is missing");
    const broken = corruptChainStore(world.store, world.successorRunId);
    // CONTROL: the walk really is degraded, so the null below is the fail-closed answer rather
    // than a chain that happened to have no rejection.
    expect(currentPlanningRun(broken, world.originalRunId).unreadable).toBe(true);
    expect(() => latestRejectionReason(broken, PROJECT_ID, world.originalRunId)).not.toThrow();
    expect(latestRejectionReason(broken, PROJECT_ID, world.originalRunId)).toBeNull();
  });

  it("answers null when the walk itself throws at the very first read", () => {
    const world = rejectedWorld("the second slice is missing");
    const broken = corruptChainStore(world.store, world.originalRunId);
    expect(latestRejectionReason(broken, PROJECT_ID, world.originalRunId)).toBeNull();
  });

  it("is reachable from a GOAL id through refsOfGoal, the wrapper's own derivation", () => {
    // agent-wrapper-main.ts's `compilerInstructions` holds a goalId, not a run ref, and derives
    // the ref with `refsOfGoal` - the SAME function goal-create-with-source.ts:76 uses to WRITE
    // it. This arm pins that coupling: if either side stopped deriving, the wrapper would walk an
    // aggregate with no history and every re-staffed seat would silently read no rejection, with
    // nothing in the unit suite to notice.
    const world = rejectedWorld("the second slice is missing");
    const derived = refsOfGoal(world.goalId).planningRunRef;
    expect(derived).toBe(world.originalRunId);
    // ...and it is what the goal's own DURABLE record says, not merely what the fixture assumed.
    const durable = stateOf(readDurableLedger(world.store, PROJECT_ID), world.goalId);
    expect((durable as Record<string, unknown>)["planningRunRef"]).toBe(derived);
    expect(latestRejectionReason(world.store, PROJECT_ID, derived)?.reason)
      .toBe("the second slice is missing");
  });
});

describe("composeCompilerInstructions", () => {
  it("passes the brief through BYTE-IDENTICALLY when there is no rejection", () => {
    // `toBe` on purpose: a composer that trimmed, re-wrapped or appended an empty line would
    // satisfy `toContain(BRIEF)` while changing what every un-rejected seat reads.
    expect(composeCompilerInstructions(BRIEF, null)).toBe(BRIEF);
  });

  it("answers null for a goal with neither a brief nor a rejection", () => {
    // The wiring hands `compilerMission` this value directly, and `null` is what suppresses the
    // whole operator block (agent-mission-text.ts:153). An empty string would open an EMPTY
    // fenced block instead.
    expect(composeCompilerInstructions(null, null)).toBeNull();
  });

  it("ends with the exact sentence and keeps the brief when both exist", () => {
    const composed = composeCompilerInstructions(BRIEF, {
      reason: "the second slice is missing",
      rejectedRunId: "run-1",
    });
    expect(composed).not.toBeNull();
    expect(composed as string).toContain(BRIEF);
    expect(composed as string)
      .toBe(`${BRIEF}\n\n${sentenceFor("the second slice is missing")}`);
    expect((composed as string).endsWith(sentenceFor("the second slice is missing"))).toBe(true);
  });

  it("is the sentence ALONE when the goal carries no brief", () => {
    const composed = composeCompilerInstructions(null, {
      reason: "one node is not a plan",
      rejectedRunId: "run-1",
    });
    expect(composed).toBe(sentenceFor("one node is not a plan"));
  });

  it("treats a whitespace-only brief as absent rather than emitting a blank leading block", () => {
    expect(composeCompilerInstructions("   \n  ", { reason: "r", rejectedRunId: "run-1" }))
      .toBe(sentenceFor("r"));
    expect(composeCompilerInstructions("   \n  ", null)).toBeNull();
  });

  it("composes end to end from a real rejected store", () => {
    // The two exports meet here: what a re-staffed seat would actually be handed for this goal.
    const world = rejectedWorld("the second slice is missing");
    const composed = composeCompilerInstructions(
      BRIEF, latestRejectionReason(world.store, PROJECT_ID, world.originalRunId),
    );
    expect(composed)
      .toBe(`${BRIEF}\n\n${sentenceFor("the second slice is missing")}`);
  });
});
