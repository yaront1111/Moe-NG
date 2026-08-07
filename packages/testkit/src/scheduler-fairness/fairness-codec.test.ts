import { describe, expect, it } from "vitest";

import { canonicalize } from "../canonical-json.js";
import { fromCanonicalBytes, toCanonicalBytes } from "./fairness-codec.js";
import { reduceEvents } from "./fairness-reducer.js";
import { selectNext } from "./fairness-selection.js";
import type {
  FairnessEvent,
  FairnessReasonCode,
  FairnessState,
} from "./fairness-model.js";
import { fxAdmit, fxBypass, fxForce, fxForcedCohortState } from "./fairness-fixtures.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function parseBytes(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes)) as unknown;
}

function encodeCanonical(value: unknown): Uint8Array {
  return encoder.encode(canonicalize(value));
}

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
    const state = fxForcedCohortState([
      { ticketId: "a", workItemId: "wi-a", forcedCohortEntryEvent: 1 },
      { ticketId: "b", workItemId: "wi-b", forcedCohortEntryEvent: 2 },
    ]);
    const bytes = toCanonicalBytes(state);
    const restored = fromCanonicalBytes(bytes);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    // byte-identical re-serialization
    expect(toCanonicalBytes(restored.state)).toEqual(bytes);
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
    expect(toCanonicalBytes(one)).toEqual(toCanonicalBytes(two));
  });
});

describe("codec — fail-closed reconstruction", () => {
  it("rejects non-JSON text", () => {
    const r = fromCanonicalBytes(encoder.encode("}{ not json"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a JSON payload missing required fields", () => {
    const r = fromCanonicalBytes(encodeCanonical({ policyMd: 10 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a ticket carrying an invalid priority", () => {
    const good = mustReduce([fxAdmit("a")]);
    const parsed = parseBytes(toCanonicalBytes(good)) as { tickets: Record<string, unknown>[] };
    parsed.tickets[0]!["priority"] = "P9";
    const r = fromCanonicalBytes(encodeCanonical(parsed));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a payload whose dispatchableCount disagrees with its tickets", () => {
    const good = mustReduce([fxAdmit("a")]);
    const parsed = parseBytes(toCanonicalBytes(good)) as Record<string, unknown>;
    parsed["dispatchableCount"] = 7;
    const r = fromCanonicalBytes(encodeCanonical(parsed));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a snapshot whose eventSeq is below a ticket's own event (FIFO guard)", () => {
    const good = mustReduce([fxAdmit("a"), ...fxForce("a")]);
    const parsed = parseBytes(toCanonicalBytes(good)) as Record<string, unknown>;
    parsed["eventSeq"] = 1;
    const r = fromCanonicalBytes(encodeCanonical(parsed));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a snapshot with a forced ticket that is not P0 with a reset counter", () => {
    const good = mustReduce([fxAdmit("a"), ...fxForce("a")]);
    const parsed = parseBytes(toCanonicalBytes(good)) as { tickets: Record<string, unknown>[] };
    parsed.tickets[0]!["priority"] = "P1";
    const r = fromCanonicalBytes(encodeCanonical(parsed));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a snapshot carrying an unknown ticket field", () => {
    const good = mustReduce([fxAdmit("a")]);
    const parsed = parseBytes(toCanonicalBytes(good)) as { tickets: Record<string, unknown>[] };
    parsed.tickets[0]!["injected"] = 1;
    const r = fromCanonicalBytes(encodeCanonical(parsed));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a snapshot carrying an unknown top-level field", () => {
    const good = mustReduce([fxAdmit("a")]);
    const parsed = parseBytes(toCanonicalBytes(good)) as Record<string, unknown>;
    parsed["injected"] = 1;
    const r = fromCanonicalBytes(encodeCanonical(parsed));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });

  it("rejects a snapshot whose tickets span multiple dimensions", () => {
    const good = mustReduce([fxAdmit("a"), fxAdmit("b")]);
    const parsed = parseBytes(toCanonicalBytes(good)) as { tickets: Record<string, unknown>[] };
    parsed.tickets[1]!["dimension"] = "other";
    const r = fromCanonicalBytes(encodeCanonical(parsed));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codesOf(r.issues)).toContain("FAIRNESS_MALFORMED_STATE");
  });
});
