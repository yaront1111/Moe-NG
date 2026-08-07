import { describe, expect, it } from "vitest";

import { fromCanonicalBytes, toCanonicalBytes } from "./fairness-codec.js";
import { reduceEvents } from "./fairness-reducer.js";
import { selectNext } from "./fairness-selection.js";
import type {
  FairnessEvent,
  FairnessReasonCode,
  FairnessState,
} from "./fairness-model.js";
import { fxAdmit, fxBypass, fxForce } from "./fairness-fixtures.js";

function mustReduce(events: readonly FairnessEvent[]): FairnessState {
  const r = reduceEvents(events);
  if (!r.ok) {
    throw new Error(`reduce failed: ${JSON.stringify(r.issues)}`);
  }
  return r.state;
}

function codesOf(issues: readonly { readonly code: FairnessReasonCode }[]): string[] {
  return issues.map((i) => i.code);
}

describe("codec — canonical restart round-trip", () => {
  it("reconstructs identical state, ordering, selection, and bytes", () => {
    const state = mustReduce([
      fxAdmit("a"),
      ...fxForce("a"),
      fxAdmit("b"),
      ...fxBypass("b", 9),
      fxAdmit("c"),
    ]);
    const bytes = toCanonicalBytes(state);
    const restored = fromCanonicalBytes(bytes);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    // byte-identical re-serialization
    expect(toCanonicalBytes(restored.state)).toBe(bytes);
    // structurally identical state
    expect(restored.state).toEqual(state);
    // identical selection decision
    expect(selectNext(restored.state)).toEqual(selectNext(state));
    // outputs are deeply frozen
    expect(Object.isFrozen(restored.state)).toBe(true);
    expect(Object.isFrozen(restored.state.tickets)).toBe(true);
  });

  it("serializes deterministically for identical event histories", () => {
    const events = [fxAdmit("a"), ...fxBypass("a", 3), fxAdmit("b")];
    const one = mustReduce(events);
    const two = mustReduce(events);
    expect(toCanonicalBytes(one)).toBe(toCanonicalBytes(two));
  });
});

describe("codec — fail-closed reconstruction", () => {
  it("rejects non-JSON text", () => {
    const r = fromCanonicalBytes("}{ not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a JSON payload missing required fields", () => {
    const r = fromCanonicalBytes(JSON.stringify({ policyMd: 10 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a ticket carrying an invalid priority", () => {
    const good = mustReduce([fxAdmit("a")]);
    const bytes = toCanonicalBytes(good);
    const tampered = bytes.replace('"P3"', '"P9"');
    expect(tampered).not.toBe(bytes);
    const r = fromCanonicalBytes(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a payload whose dispatchableCount disagrees with its tickets", () => {
    const good = mustReduce([fxAdmit("a")]);
    const parsed = JSON.parse(toCanonicalBytes(good)) as Record<string, unknown>;
    parsed["dispatchableCount"] = 7;
    const r = fromCanonicalBytes(JSON.stringify(parsed));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a snapshot whose eventSeq is below a ticket's own event (FIFO guard)", () => {
    const good = mustReduce([fxAdmit("a"), ...fxForce("a")]);
    const parsed = JSON.parse(toCanonicalBytes(good)) as Record<string, unknown>;
    parsed["eventSeq"] = 1;
    const r = fromCanonicalBytes(JSON.stringify(parsed));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a snapshot with a forced ticket that is not P0 with a reset counter", () => {
    const good = mustReduce([fxAdmit("a"), ...fxForce("a")]);
    const parsed = JSON.parse(toCanonicalBytes(good)) as { tickets: Record<string, unknown>[] };
    parsed.tickets[0]!["priority"] = "P1";
    const r = fromCanonicalBytes(JSON.stringify(parsed));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a snapshot carrying an unknown ticket field", () => {
    const good = mustReduce([fxAdmit("a")]);
    const parsed = JSON.parse(toCanonicalBytes(good)) as { tickets: Record<string, unknown>[] };
    parsed.tickets[0]!["injected"] = 1;
    const r = fromCanonicalBytes(JSON.stringify(parsed));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a snapshot carrying an unknown top-level field", () => {
    const good = mustReduce([fxAdmit("a")]);
    const parsed = JSON.parse(toCanonicalBytes(good)) as Record<string, unknown>;
    parsed["injected"] = 1;
    const r = fromCanonicalBytes(JSON.stringify(parsed));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a snapshot whose tickets span multiple dimensions", () => {
    const good = mustReduce([fxAdmit("a"), fxAdmit("b")]);
    const parsed = JSON.parse(toCanonicalBytes(good)) as { tickets: Record<string, unknown>[] };
    parsed.tickets[1]!["dimension"] = "other";
    const r = fromCanonicalBytes(JSON.stringify(parsed));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });
});
