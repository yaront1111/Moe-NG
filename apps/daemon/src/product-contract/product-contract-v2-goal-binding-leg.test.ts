import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  PRODUCT_CONTRACT_V2_GOAL_BINDING_LAYER, deriveProductContractV2GoalBindingAggregateId,
} from "./product-contract-v2-goal-binding-contract.js";
import { prepareProductContractV2GoalBindingLegs } from "./product-contract-v2-goal-binding-leg.js";
import { readProductContractV2GoalBinding } from "./product-contract-v2-goal-binding-reader.js";

const PROJECT = "project-binding-leg";
const GOAL = "goal-binding-leg";
const CONTRACT = "contract-binding-leg";
const COMMAND = "cmd-binding-leg";
const CAUSE = Object.freeze({ commandId: COMMAND, kind: "REVISION" as const, ref: "rev-1" });

function withStore<T>(run: (store: SqliteEventStore) => T): T {
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
  try { return run(store); } finally { store.close(); }
}

/** A store whose goal-binding aggregate answers as `answer` says; everything else is real. */
function goalSideAnswers(
  store: SqliteEventStore, answer: () => ReturnType<SqliteEventStore["readAggregateEvents"]>,
): SqliteEventStore {
  const goalAggregate = deriveProductContractV2GoalBindingAggregateId(PROJECT, GOAL);
  return new Proxy(store, { get(target, key) {
    if (key === "readAggregateEvents") {
      return (...args: Parameters<SqliteEventStore["readAggregateEvents"]>) =>
        (args[0] === goalAggregate ? answer() : target.readAggregateEvents(...args));
    }
    const member = Reflect.get(target, key, target) as unknown;
    return typeof member === "function" ? member.bind(target) : member;
  } });
}

const prepare = (store: SqliteEventStore) => prepareProductContractV2GoalBindingLegs(store, {
  cause: CAUSE, commandId: COMMAND, contractId: CONTRACT, goalRef: GOAL, projectId: PROJECT,
});

describe("prepareProductContractV2GoalBindingLegs", () => {
  it("mints both binding legs when neither side is bound yet", () => withStore((store) => {
    const legs = prepare(store);
    expect(legs.ok).toBe(true);
    if (!legs.ok) return;
    expect(legs.legs).toHaveLength(2);
    expect(legs.binding).toMatchObject({ contractId: CONTRACT, goalRef: GOAL, projectId: PROJECT });
  }));

  it("forwards an INVALID goal side under the reader's own code, not as a mismatch", () => withStore((store) => {
    // The goal side reads as INVALID (a page that claims more than the one binding event), the
    // contract side is honestly absent. The old absent-vs-present compare answered MISMATCH for
    // this — "the two sides disagree" — hiding a corrupt binding behind a different story.
    const corrupt = goalSideAnswers(store, () => ({ hasMore: true, items: [], nextCursor: 1 }));
    expect(prepare(corrupt)).toEqual({
      code: "PRODUCT_CONTRACT_V2_GOAL_BINDING_INVALID", layer: PRODUCT_CONTRACT_V2_GOAL_BINDING_LAYER, ok: false,
    });
  }));

  it("forwards a failing goal-side read exactly as the reader answers it", () => withStore((store) => {
    const failing = goalSideAnswers(store, () => { throw new Error("disk gone"); });
    const expected = readProductContractV2GoalBinding(failing, { goalRef: GOAL, projectId: PROJECT });
    expect(expected.ok).toBe(false);
    if (expected.ok) return;
    expect(expected.code).not.toBe("PRODUCT_CONTRACT_V2_GOAL_BINDING_MISMATCH");
    expect(prepare(failing)).toEqual({ code: expected.code, layer: expected.layer, ok: false });
  }));
});
