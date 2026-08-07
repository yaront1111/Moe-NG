import { describe, expect, it } from "vitest";

import { fromCanonicalBytes, toCanonicalBytes } from "./fairness-codec.js";
import { fxAdmit, fxForcedCohortState, fxRaiseCap, fxTerminate } from "./fairness-fixtures.js";
import type { FairnessState } from "./fairness-model.js";
import { DEFAULT_M_D } from "./fairness-policy.js";
import { applyEvent, reduceEvents } from "./fairness-reducer.js";
import { boundFor } from "./fairness-selection.js";

const encoder = new TextEncoder();

function expectCode(
  result: ReturnType<typeof applyEvent> | ReturnType<typeof reduceEvents>,
  code: string,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain(code);
}

describe("fairness hardening — dispatch authority", () => {
  it("rejects dispatching behind the forced FIFO head", () => {
    const state = fxForcedCohortState([
      { ticketId: "head", workItemId: "wi-a", forcedCohortEntryEvent: 1 },
      { ticketId: "tail", workItemId: "wi-b", forcedCohortEntryEvent: 2 },
    ]);

    expectCode(
      applyEvent(state, {
        kind: "COMPATIBLE_DISPATCH",
        winnerTicketId: "tail",
        bypassedTicketIds: ["head"],
      }),
      "FAIRNESS_DISPATCH_ORDER_VIOLATION",
    );
  });

  it("rejects a non-selected ordinary winner", () => {
    const reduced = reduceEvents([
      fxAdmit("selected", "wi-a"),
      fxAdmit("other", "wi-z"),
    ]);
    if (!reduced.ok) throw new Error("fixture reduction failed");

    expectCode(
      applyEvent(reduced.state, {
        kind: "COMPATIBLE_DISPATCH",
        winnerTicketId: "other",
        bypassedTicketIds: ["selected"],
      }),
      "FAIRNESS_DISPATCH_ORDER_VIOLATION",
    );
  });
});

describe("fairness hardening — cap and identity", () => {
  it("persists a migration bound across a cap raise", () => {
    const reduced = reduceEvents([fxAdmit("old")], 100);
    if (!reduced.ok) throw new Error("fixture reduction failed");
    const before = boundFor(reduced.state, "old")!.value;

    const raised = applyEvent(
      reduced.state,
      fxRaiseCap(1_000, [{ ticketId: "old", boundAtMost: before }]),
    );
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;
    expect(boundFor(raised.state, "old")!.value).toBe(before);
  });

  it("retains dimension identity after the last ticket terminates", () => {
    const first = reduceEvents([fxAdmit("first", "wi-first", "dimension-a"), fxTerminate("first")]);
    if (!first.ok) throw new Error("fixture reduction failed");

    expectCode(
      applyEvent(first.state, fxAdmit("second", "wi-second", "dimension-b")),
      "FAIRNESS_DIMENSION_MISMATCH",
    );
  });

  it("never permits a policy cap above the project ceiling", () => {
    expectCode(reduceEvents([], DEFAULT_M_D + 1), "FAIRNESS_PROJECT_CEILING_EXCEEDED");

    const reduced = reduceEvents([], 100);
    if (!reduced.ok) throw new Error("fixture reduction failed");
    expectCode(
      applyEvent(reduced.state, fxRaiseCap(DEFAULT_M_D + 1)),
      "FAIRNESS_PROJECT_CEILING_EXCEEDED",
    );
  });
});

describe("fairness hardening — bounded hostile inputs", () => {
  it("rejects unsafe integer policy and event sequence values", () => {
    expectCode(reduceEvents([], Number.MAX_SAFE_INTEGER + 1), "FAIRNESS_MALFORMED_STATE");

    const hostile = {
      dimension: null,
      projectCeilingMd: DEFAULT_M_D,
      policyMd: 10,
      eventSeq: Number.MAX_SAFE_INTEGER,
      dispatchableCount: 0,
      tickets: [],
    } as FairnessState;
    expectCode(applyEvent(hostile, fxAdmit("x")), "FAIRNESS_MALFORMED_STATE");
  });

  it("rejects oversized and non-Unicode identifiers", () => {
    expectCode(reduceEvents([fxAdmit("x".repeat(257))]), "FAIRNESS_MALFORMED_EVENT");
    expectCode(reduceEvents([fxAdmit("bad\ud800")]), "FAIRNESS_MALFORMED_EVENT");
  });

  it("rejects an event stream above its bounded cardinality", () => {
    expectCode(reduceEvents(new Array(100_001).fill(null)), "FAIRNESS_EVENT_LIMIT_EXCEEDED");
  });

  it("rejects oversized dispatch evidence before traversing it", () => {
    const reduced = reduceEvents([fxAdmit("winner")]);
    if (!reduced.ok) throw new Error("fixture reduction failed");
    const bypassed = new Array(10_001).fill("ghost");
    expectCode(
      applyEvent(reduced.state, {
        kind: "COMPATIBLE_DISPATCH",
        winnerTicketId: "winner",
        bypassedTicketIds: bypassed,
      }),
      "FAIRNESS_EVENT_LIMIT_EXCEEDED",
    );
  });

  it("returns a result for proxies and throwing accessors", () => {
    const reduced = reduceEvents([fxAdmit("x")]);
    if (!reduced.ok) throw new Error("fixture reduction failed");
    const proxy = new Proxy({}, { get: () => { throw new Error("trap"); } });
    expect(() => applyEvent(reduced.state, proxy)).not.toThrow();
    expectCode(applyEvent(reduced.state, proxy), "FAIRNESS_MALFORMED_EVENT");

    const accessor = Object.defineProperty({}, "kind", {
      enumerable: true,
      get: () => { throw new Error("getter"); },
    });
    expect(() => applyEvent(reduced.state, accessor)).not.toThrow();
    expectCode(applyEvent(reduced.state, accessor), "FAIRNESS_MALFORMED_EVENT");
  });
});

describe("fairness hardening — canonical byte boundary", () => {
  it("rejects duplicate keys and noncanonical encodings", () => {
    const duplicate = encoder.encode(
      '{"kind":"DEVELOPMENT_ONLY/NOT_CONFIRMATORY","policyMd":1,"policyMd":1,"eventSeq":0,"dispatchableCount":0,"tickets":[]}',
    );
    expectCode(fromCanonicalBytes(duplicate as unknown as string), "FAIRNESS_MALFORMED_STATE");

    const state = reduceEvents([fxAdmit("x")]);
    if (!state.ok) throw new Error("fixture reduction failed");
    const canonical = toCanonicalBytes(state.state);
    const text = typeof canonical === "string" ? canonical : new TextDecoder().decode(canonical);
    expectCode(
      fromCanonicalBytes(encoder.encode(` ${text}`) as unknown as string),
      "FAIRNESS_MALFORMED_STATE",
    );
  });
});
