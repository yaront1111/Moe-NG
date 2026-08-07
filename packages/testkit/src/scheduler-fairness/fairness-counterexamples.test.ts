import { describe, expect, it } from "vitest";

import { applyEvent, reduceEvents } from "./fairness-reducer.js";
import { boundFor, forcedCohortOrder, selectNext } from "./fairness-selection.js";
import { fromCanonicalBytes, toCanonicalBytes } from "./fairness-codec.js";
import { findTicket } from "./fairness-internal.js";
import type {
  FairnessEvent,
  FairnessReasonCode,
  FairnessState,
} from "./fairness-model.js";
import { DEFAULT_M_D } from "./fairness-policy.js";
import {
  fxAdmit,
  fxBypass,
  fxDispatch,
  fxForce,
  fxForcedCohortState,
  fxLose,
  fxRegain,
  fxStateWithNDispatchable,
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

// --- Counterexamples the model must survive (design §8.4, semantic 10) ---

describe("counterexample — incompatible dispatch storm never ages a bystander", () => {
  it("ages only the caller-confirmed bypassed ticket, never an inferred one", () => {
    const state = mustReduce([fxAdmit("x"), fxAdmit("y"), ...fxForce("y")]);
    expect(findTicket(state.tickets, "y")!.forced).toBe(true);
    const x = findTicket(state.tickets, "x")!;
    expect(x.priority).toBe("P3");
    expect(x.bypassesInLevel).toBe(0);
  });

  it("a dispatch with an empty bypass set ages nobody", () => {
    const state = mustReduce([fxAdmit("z"), fxAdmit("p"), fxDispatch("p", [])]);
    const z = findTicket(state.tickets, "z")!;
    expect(z.bypassesInLevel).toBe(0);
    expect(findTicket(state.tickets, "p")).toBeUndefined();
  });
});

describe("counterexample — continual new arrivals cannot delay or overtake forcing", () => {
  it("forces the aged ticket while newcomers stay ordinary and behind", () => {
    const newcomers = ["n0", "n1", "n2", "n3", "n4"].map((id) => fxAdmit(id));
    const state = mustReduce([fxAdmit("old"), ...newcomers, ...fxForce("old")]);
    expect(selectNext(state)?.ticketId).toBe("old");
    expect(selectNext(state)?.lane).toBe("FORCED");
    for (const id of ["n0", "n1", "n2", "n3", "n4"]) {
      expect(boundFor(state, id)?.kind).toBe("CONSERVATIVE");
    }
  });
});

describe("counterexample — dormant forced ticket keeps history, rejoins at the tail", () => {
  it("drops from the active cohort on lose and re-enters behind newer forced tickets", () => {
    const state = fxForcedCohortState([
      { ticketId: "a", workItemId: "wi-a", forcedCohortEntryEvent: 1 },
      { ticketId: "b", workItemId: "wi-b", forcedCohortEntryEvent: 2 },
    ]);
    expect(forcedCohortOrder(state).map((t) => t.ticketId)).toEqual(["a", "b"]);

    const lost = applyEvent(state, fxLose("a"));
    expect(lost.ok).toBe(true);
    if (!lost.ok) return;
    expect(forcedCohortOrder(lost.state).map((t) => t.ticketId)).toEqual(["b"]);
    expect(findTicket(lost.state.tickets, "a")!.forced).toBe(true);

    const back = applyEvent(lost.state, fxRegain("a"));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    // a earned forced first but re-entered last: now ordered behind b.
    expect(forcedCohortOrder(back.state).map((t) => t.ticketId)).toEqual(["b", "a"]);
  });
});

describe("counterexample — churn and re-entry never improve priority", () => {
  it("survives repeated lose/regain with priority and bypass counter intact", () => {
    let cur = mustReduce([fxAdmit("x"), ...fxBypass("x", 3)]);
    for (let i = 0; i < 5; i += 1) {
      const lost = applyEvent(cur, fxLose("x"));
      if (!lost.ok) throw new Error("lose failed");
      const back = applyEvent(lost.state, fxRegain("x"));
      if (!back.ok) throw new Error("regain failed");
      cur = back.state;
    }
    const t = findTicket(cur.tickets, "x")!;
    expect(t.priority).toBe("P3");
    expect(t.bypassesInLevel).toBe(3);
  });
});

describe("counterexample — restart mid-stream is transparent", () => {
  it("continuing on a round-tripped state matches continuing on the original", () => {
    const prefix = [fxAdmit("a"), ...fxForce("a"), fxAdmit("b")];
    const suffix: FairnessEvent[] = [
      fxDispatch("a", ["b"]),
      fxAdmit("c"),
      ...fxBypass("b", 9),
    ];

    const original = mustReduce([...prefix, ...suffix]);

    const mid = mustReduce(prefix);
    const restored = fromCanonicalBytes(toCanonicalBytes(mid));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    let cur = restored.state;
    for (const ev of suffix) {
      const step = applyEvent(cur, ev);
      if (!step.ok) throw new Error(`resume failed: ${JSON.stringify(step.issues)}`);
      cur = step.state;
    }
    expect(toCanonicalBytes(cur)).toEqual(toCanonicalBytes(original));
  });
});

describe("counterexample — 10k boundary", () => {
  it("accepts at the cap and rejects one past it", () => {
    const atCap = fxStateWithNDispatchable(DEFAULT_M_D, DEFAULT_M_D);
    expect(atCap.dispatchableCount).toBe(DEFAULT_M_D);
    const over = applyEvent(atCap, fxAdmit("fx-over"));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(codesOf(over.issues)).toContain("FAIRNESS_TICKET_CAP_EXCEEDED");
  });
});

// --- Hostile / sparse / duplicate / stale inputs (semantic 9) ---

describe("hostile inputs — fail closed with stable reason codes", () => {
  it("reduces an empty event stream to a frozen empty state", () => {
    const r = reduceEvents([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.tickets).toEqual([]);
    expect(r.state.dispatchableCount).toBe(0);
    expect(Object.isFrozen(r.state)).toBe(true);
  });

  it("rejects a structurally malformed event", () => {
    const base = mustReduce([fxAdmit("x")]);
    const r = applyEvent(base, {} as unknown as FairnessEvent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_EVENT");
  });

  it("rejects a non-object event", () => {
    const base = mustReduce([fxAdmit("x")]);
    const r = applyEvent(base, 42 as unknown as FairnessEvent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_EVENT");
  });

  it("rejects an ADMIT with an invalid starting priority", () => {
    const bad = {
      kind: "ADMIT",
      ticketId: "x",
      workItemId: "wi-x",
      dimension: "d",
      startingPriority: "P9",
    } as unknown as FairnessEvent;
    const r = reduceEvents([bad]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_INVALID_PRIORITY");
  });

  it("rejects an ADMIT missing a required string field", () => {
    const bad = { kind: "ADMIT", ticketId: "x", dimension: "d" } as unknown as FairnessEvent;
    const r = reduceEvents([bad]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_EVENT");
  });

  it("rejects operations on an unknown ticket", () => {
    const base = mustReduce([fxAdmit("x")]);
    const r = applyEvent(base, fxLose("ghost"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_UNKNOWN_TICKET");
  });

  it("rejects a duplicate admission", () => {
    const r = reduceEvents([fxAdmit("x"), fxAdmit("x")]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_DUPLICATE_TICKET");
  });

  it("rejects a stale bypass of an already non-dispatchable ticket", () => {
    const r = reduceEvents([fxAdmit("x"), fxAdmit("y"), fxLose("y"), fxDispatch("x", ["y"])]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_STALE_EVENT");
  });

  it("does not mutate a frozen input state on a failing event", () => {
    const base = mustReduce([fxAdmit("x")]);
    const snapshot = JSON.stringify(base);
    applyEvent(base, fxLose("ghost"));
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});
