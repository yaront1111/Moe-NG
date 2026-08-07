import { describe, expect, it } from "vitest";

import {
  boundFor,
  forcedCohortOrder,
  selectNext,
} from "./fairness-selection.js";
import { reduceEvents } from "./fairness-reducer.js";
import type { FairnessEvent, FairnessState } from "./fairness-model.js";
import { DEFAULT_M_D } from "./fairness-policy.js";
import {
  fxAdmit,
  fxBypass,
  fxForce,
  fxForcedCohortState,
  fxLose,
} from "./fairness-fixtures.js";

function mustReduce(
  events: readonly FairnessEvent[],
  md?: number,
): FairnessState {
  const r = reduceEvents(events, md);
  if (!r.ok) {
    throw new Error(`reduce failed: ${JSON.stringify(r.issues)}`);
  }
  return r.state;
}

describe("selection — forced precedes ordinary", () => {
  it("returns null when nothing is dispatchable", () => {
    const state = mustReduce([fxAdmit("x"), fxLose("x")]);
    expect(selectNext(state)).toBeNull();
  });

  it("selects an ordinary candidate by priority then workItemId when no forced ticket exists", () => {
    // p1 is P1, p3 is P3; higher priority wins regardless of workItemId order.
    const state = mustReduce([
      fxAdmit("p3", "wi-a", "fx-dim", "P3"),
      fxAdmit("p1", "wi-z", "fx-dim", "P1"),
    ]);
    const picked = selectNext(state);
    expect(picked?.ticketId).toBe("p1");
    expect(picked?.lane).toBe("ORDINARY");
  });

  it("breaks an ordinary priority tie by workItemId", () => {
    const state = mustReduce([
      fxAdmit("b", "wi-b", "fx-dim", "P2"),
      fxAdmit("a", "wi-a", "fx-dim", "P2"),
    ]);
    expect(selectNext(state)?.ticketId).toBe("a");
  });

  it("serves a forced ticket ahead of a higher-churn ordinary one", () => {
    const state = mustReduce([
      fxAdmit("forced"),
      ...fxForce("forced"),
      fxAdmit("hot", "wi-hot", "fx-dim", "P0"),
    ]);
    const picked = selectNext(state);
    expect(picked?.ticketId).toBe("forced");
    expect(picked?.lane).toBe("FORCED");
  });
});

describe("selection — forced cohort FIFO", () => {
  it("orders the active cohort by forcedCohortEntryEvent (earliest first)", () => {
    const state = mustReduce([
      fxAdmit("first"),
      ...fxForce("first"),
      fxAdmit("second"),
      ...fxForce("second"),
    ]);
    const order = forcedCohortOrder(state).map((t) => t.ticketId);
    expect(order).toEqual(["first", "second"]);
    expect(selectNext(state)?.ticketId).toBe("first");
  });

  it("breaks an equal-entry-event tie by workItemId", () => {
    const state = fxForcedCohortState([
      { ticketId: "t-late", workItemId: "wi-a", forcedCohortEntryEvent: 5 },
      { ticketId: "t-early", workItemId: "wi-b", forcedCohortEntryEvent: 5 },
    ]);
    const order = forcedCohortOrder(state).map((t) => t.workItemId);
    expect(order).toEqual(["wi-a", "wi-b"]);
  });

  it("excludes forced tickets that lost dispatchability from the active cohort", () => {
    const state = mustReduce([fxAdmit("f"), ...fxForce("f"), fxLose("f")]);
    expect(forcedCohortOrder(state)).toEqual([]);
    expect(selectNext(state)).toBeNull();
  });
});

describe("selection — bound evidence (opportunity counts, never time)", () => {
  it("gives a fresh P3 a conservative bound of 8*4 + M_d", () => {
    const state = mustReduce([fxAdmit("x")]);
    const bound = boundFor(state, "x");
    expect(bound).toEqual({
      ticketId: "x",
      kind: "CONSERVATIVE",
      value: 8 * 4 + DEFAULT_M_D,
    });
  });

  it("tightens the conservative bound as the ticket promotes", () => {
    const state = mustReduce([fxAdmit("x"), ...fxBypass("x", 8)]); // now P2
    expect(boundFor(state, "x")).toEqual({
      ticketId: "x",
      kind: "CONSERVATIVE",
      value: 8 * 3 + DEFAULT_M_D,
    });
  });

  it("honors a smaller policy M_d in the conservative bound", () => {
    const state = mustReduce([fxAdmit("x")], 50);
    expect(boundFor(state, "x")?.value).toBe(8 * 4 + 50);
  });

  it("gives forced tickets the exact remainder F_ahead + 1", () => {
    const state = mustReduce([
      fxAdmit("a"),
      ...fxForce("a"),
      fxAdmit("b"),
      ...fxForce("b"),
    ]);
    expect(boundFor(state, "a")).toEqual({ ticketId: "a", kind: "EXACT_FORCED", value: 1 });
    expect(boundFor(state, "b")).toEqual({ ticketId: "b", kind: "EXACT_FORCED", value: 2 });
  });

  it("has no bound for an unknown or non-dispatchable ticket", () => {
    const state = mustReduce([fxAdmit("x"), fxLose("x")]);
    expect(boundFor(state, "x")).toBeNull();
    expect(boundFor(state, "ghost")).toBeNull();
  });
});
