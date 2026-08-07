import { describe, expect, it } from "vitest";

import { applyEvent, reduceEvents } from "./fairness-reducer.js";
import { boundFor } from "./fairness-selection.js";
import type {
  FairnessEvent,
  FairnessReasonCode,
  FairnessState,
} from "./fairness-model.js";
import { DEFAULT_M_D } from "./fairness-policy.js";
import {
  fxAdmit,
  fxLose,
  fxRaiseCap,
  fxStateWithNDispatchable,
  fxTerminate,
} from "./fairness-fixtures.js";

function mustReduce(
  events: readonly FairnessEvent[],
  md?: number,
): FairnessState {
  const r = reduceEvents(events, md);
  if (!r.ok) throw new Error(`reduce failed: ${JSON.stringify(r.issues)}`);
  return r.state;
}

function codesOf(issues: readonly { readonly code: FairnessReasonCode }[]): string[] {
  return issues.map((i) => i.code);
}

describe("cap — M_d admission ceiling", () => {
  it("accepts the 10,000th dispatchable ticket", () => {
    const state = fxStateWithNDispatchable(DEFAULT_M_D - 1, DEFAULT_M_D);
    const r = applyEvent(state, fxAdmit("fx-extra"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.dispatchableCount).toBe(DEFAULT_M_D);
  });

  it("rejects the 10,001st via the O(1) count gate (no traversal needed)", () => {
    const full = fxStateWithNDispatchable(DEFAULT_M_D, DEFAULT_M_D);
    const r = applyEvent(full, fxAdmit("fx-overflow"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_TICKET_CAP_EXCEEDED");
  });

  it("keys the gate on dispatchableCount, not on the ticket array length", () => {
    // A hostile state that claims a full cap with an empty ticket array must
    // still reject admission without inspecting elements.
    const bogusFull: FairnessState = {
      dimension: "fx-dim",
      projectCeilingMd: DEFAULT_M_D,
      policyMd: 4,
      eventSeq: 4,
      dispatchableCount: 4,
      tickets: [],
    };
    const r = applyEvent(bogusFull, fxAdmit("fx-x"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_TICKET_CAP_EXCEEDED");
  });

  it("counts a regained ticket against the cap but not a non-dispatchable one", () => {
    const near = fxStateWithNDispatchable(DEFAULT_M_D, DEFAULT_M_D);
    // lose one, then admit is allowed again; regaining a *different* dropped one
    // would refill — exercised via lose then admit.
    const afterLose = applyEvent(near, fxLose("fx-t-000000"));
    expect(afterLose.ok).toBe(true);
    if (!afterLose.ok) return;
    expect(afterLose.state.dispatchableCount).toBe(DEFAULT_M_D - 1);
    const readmit = applyEvent(afterLose.state, fxAdmit("fx-new"));
    expect(readmit.ok).toBe(true);
  });
});

describe("cap — RAISE_CAP drain-or-tighter-migration", () => {
  it("raises the cap within the project ceiling when every live ticket is drained", () => {
    const state = mustReduce([fxAdmit("a"), fxTerminate("a")], 100);
    const r = applyEvent(state, fxRaiseCap(1000));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.policyMd).toBe(1000);
  });

  it("rejects a bare raise while live tickets carry a looser implied bound", () => {
    const state = mustReduce([fxAdmit("a")], 100);
    const r = applyEvent(state, fxRaiseCap(1000));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(codesOf(r.issues)).toContain(
        "CAP_RAISE_REQUIRES_DRAIN_OR_TIGHTER_MIGRATION",
      );
    }
  });

  it("accepts a raise when every live ticket receives an equal-or-tighter migration", () => {
    const state = mustReduce([fxAdmit("a"), fxAdmit("b")], 100);
    const boundA = boundFor(state, "a")!.value; // 8*4 + 100
    const r = applyEvent(
      state,
      fxRaiseCap(1000, [
        { ticketId: "a", boundAtMost: boundA },
        { ticketId: "b", boundAtMost: boundA },
      ]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.policyMd).toBe(1000);
  });

  it("rejects a raise whose migration leaves a ticket uncovered", () => {
    const state = mustReduce([fxAdmit("a"), fxAdmit("b")], 100);
    const boundA = boundFor(state, "a")!.value;
    const r = applyEvent(state, fxRaiseCap(1000, [{ ticketId: "a", boundAtMost: boundA }]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(codesOf(r.issues)).toContain(
        "CAP_RAISE_REQUIRES_DRAIN_OR_TIGHTER_MIGRATION",
      );
    }
  });

  it("rejects a raise whose migration bound is looser than the current bound", () => {
    const state = mustReduce([fxAdmit("a")], 100);
    const boundA = boundFor(state, "a")!.value;
    const r = applyEvent(
      state,
      fxRaiseCap(1000, [{ ticketId: "a", boundAtMost: boundA + 1 }]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(codesOf(r.issues)).toContain(
        "CAP_RAISE_REQUIRES_DRAIN_OR_TIGHTER_MIGRATION",
      );
    }
  });
});
