import { describe, expect, it } from "vitest";

import { applyEvent, reduceEvents } from "./fairness-reducer.js";
import type {
  FairnessEvent,
  FairnessReasonCode,
  FairnessState,
} from "./fairness-model.js";
import { findTicket } from "./fairness-internal.js";
import { BYPASSES_PER_LEVEL } from "./fairness-policy.js";
import {
  fxAdmit,
  fxBypass,
  fxDispatch,
  fxForce,
  fxLose,
  fxRegain,
  fxTerminate,
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

function codesOf(issues: readonly { readonly code: FairnessReasonCode }[]): string[] {
  return issues.map((i) => i.code);
}

describe("reducer — admission", () => {
  it("admits a fresh P3 dispatchable ticket with zeroed aging", () => {
    const state = mustReduce([fxAdmit("x")]);
    const t = findTicket(state.tickets, "x")!;
    expect(t.priority).toBe("P3");
    expect(t.bypassesInLevel).toBe(0);
    expect(t.forced).toBe(false);
    expect(t.forcedCohortEntryEvent).toBeNull();
    expect(t.dispatchable).toBe(true);
    expect(state.dispatchableCount).toBe(1);
  });

  it("honors an explicit starting priority", () => {
    const state = mustReduce([fxAdmit("x", "wi-x", "fx-dim", "P1")]);
    expect(findTicket(state.tickets, "x")!.priority).toBe("P1");
  });

  it("rejects a duplicate ticketId", () => {
    const r = reduceEvents([fxAdmit("x"), fxAdmit("x")]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(codesOf(r.issues)).toContain("FAIRNESS_DUPLICATE_TICKET");
    }
  });

  it("rejects an ADMIT whose dimension differs from the state dimension", () => {
    const r = reduceEvents([fxAdmit("x"), fxAdmit("y", "wi-y", "other")]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_EVENT");
    }
  });
});

describe("reducer — aging and promotion", () => {
  it("promotes one class after exactly eight bypasses and resets the counter", () => {
    const state = mustReduce([fxAdmit("x"), ...fxBypass("x", BYPASSES_PER_LEVEL)]);
    const t = findTicket(state.tickets, "x")!;
    expect(t.priority).toBe("P2");
    expect(t.bypassesInLevel).toBe(0);
    expect(t.forced).toBe(false);
  });

  it("does not promote at seven bypasses", () => {
    const state = mustReduce([fxAdmit("x"), ...fxBypass("x", BYPASSES_PER_LEVEL - 1)]);
    const t = findTicket(state.tickets, "x")!;
    expect(t.priority).toBe("P3");
    expect(t.bypassesInLevel).toBe(BYPASSES_PER_LEVEL - 1);
  });

  it("forces a P3 ticket after 8*4 bypasses (eight further at P0)", () => {
    const state = mustReduce([fxAdmit("x"), ...fxForce("x")]);
    const t = findTicket(state.tickets, "x")!;
    expect(t.priority).toBe("P0");
    expect(t.forced).toBe(true);
    expect(t.forcedCohortEntryEvent).not.toBeNull();
  });
});

describe("reducer — dispatch validity", () => {
  it("removes the dispatched winner", () => {
    const state = mustReduce([fxAdmit("x"), fxAdmit("y"), fxDispatch("y", ["x"])]);
    expect(findTicket(state.tickets, "y")).toBeUndefined();
    expect(findTicket(state.tickets, "x")!.bypassesInLevel).toBe(1);
  });

  it("rejects a dispatch whose winner is unknown", () => {
    const r = reduceEvents([fxAdmit("x"), fxDispatch("ghost", ["x"])]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(codesOf(r.issues)).toContain("FAIRNESS_UNKNOWN_TICKET");
    }
  });

  it("rejects a bypass of a non-dispatchable ticket as stale", () => {
    const r = reduceEvents([
      fxAdmit("x"),
      fxAdmit("y"),
      fxLose("x"),
      fxDispatch("y", ["x"]),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(codesOf(r.issues)).toContain("FAIRNESS_STALE_EVENT");
    }
  });
});

describe("reducer — dispatchability churn preserves aging history", () => {
  it("keeps priority and bypass on lose/regain and never improves via churn", () => {
    const base = mustReduce([fxAdmit("x"), ...fxBypass("x", BYPASSES_PER_LEVEL + 2)]);
    const before = findTicket(base.tickets, "x")!;
    expect(before.priority).toBe("P2");
    expect(before.bypassesInLevel).toBe(2);

    const lost = applyEvent(base, fxLose("x"));
    expect(lost.ok).toBe(true);
    if (!lost.ok) return;
    const regained = applyEvent(lost.state, fxRegain("x"));
    expect(regained.ok).toBe(true);
    if (!regained.ok) return;
    const t = findTicket(regained.state.tickets, "x")!;
    expect(t.priority).toBe("P2");
    expect(t.bypassesInLevel).toBe(2);
    expect(t.dispatchable).toBe(true);
  });

  it("a forced ticket leaves the active cohort on lose and rejoins at the tail on regain", () => {
    const state = mustReduce([fxAdmit("x"), ...fxForce("x")]);
    const entry1 = findTicket(state.tickets, "x")!.forcedCohortEntryEvent!;
    const lost = applyEvent(state, fxLose("x"));
    expect(lost.ok).toBe(true);
    if (!lost.ok) return;
    const lostTicket = findTicket(lost.state.tickets, "x")!;
    expect(lostTicket.forced).toBe(true);
    expect(lostTicket.forcedCohortEntryEvent).toBeNull();
    const regained = applyEvent(lost.state, fxRegain("x"));
    expect(regained.ok).toBe(true);
    if (!regained.ok) return;
    const entry2 = findTicket(regained.state.tickets, "x")!.forcedCohortEntryEvent!;
    expect(entry2).toBeGreaterThan(entry1);
  });
});

describe("reducer — terminate and stale", () => {
  it("terminates a ticket and rejects later operations on it", () => {
    const base = mustReduce([fxAdmit("x")]);
    const gone = applyEvent(base, fxTerminate("x"));
    expect(gone.ok).toBe(true);
    if (!gone.ok) return;
    expect(findTicket(gone.state.tickets, "x")).toBeUndefined();
    expect(gone.state.dispatchableCount).toBe(0);
    const stale = applyEvent(gone.state, fxLose("x"));
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(codesOf(stale.issues)).toContain("FAIRNESS_UNKNOWN_TICKET");
    }
  });

  it("does not mutate the input state", () => {
    const base = mustReduce([fxAdmit("x")]);
    const snapshot = JSON.stringify(base);
    applyEvent(base, fxAdmit("y"));
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(Object.isFrozen(base)).toBe(true);
  });
});
