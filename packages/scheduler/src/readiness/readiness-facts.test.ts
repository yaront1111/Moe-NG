/**
 * RED-first contract for the readiness fact parser: what is KNOWN, never what
 * is ready. Absent, malformed, wrong-typed or stale truth must land on UNKNOWN
 * and never on CONFIRMED_FALSE, which is a positive claim the caller did not
 * make.
 */
import { describe, expect, it } from "vitest";

import { MAX_ADMISSION_ITEMS } from "../admission/admission-model.js";
import { parseNodeReadinessFacts } from "./readiness-facts.js";
import {
  ADMISSION_REASON_CODES,
  CALLER_FACT_CODES,
  DISPATCH_REASON_CODES,
} from "./readiness-model.js";

const DIGEST = "a".repeat(64);

function provenance(ref: string, version = 3): Record<string, unknown> {
  return {
    sourceFactRef: ref,
    sourceFactVersion: version,
    sourceFactDigest: DIGEST,
  };
}

function fact(
  code: string,
  confidence: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    code,
    confidence,
    provenance: provenance(`fact:${code}`),
    horizonGate: "GOAL_COMPLETION",
    recoveryRef: null,
    ...overrides,
  };
}

/** Every caller predicate CONFIRMED_TRUE — the only fully-known baseline. */
function allTrue(): Record<string, unknown>[] {
  return CALLER_FACT_CODES.map((code) => fact(code, "CONFIRMED_TRUE"));
}

function bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeKey: "dev-node-1",
    currentGate: "EXECUTOR_CLAIM",
    facts: allTrue(),
    wait: null,
    currentFactVersions: [],
    ...overrides,
  };
}

function without(code: string): Record<string, unknown>[] {
  return allTrue().filter((entry) => entry["code"] !== code);
}

function replacing(
  code: string,
  replacement: Record<string, unknown>,
): Record<string, unknown>[] {
  return allTrue().map((entry) => (entry["code"] === code ? replacement : entry));
}

function predicateOf(parsed: NonNullable<ReturnType<typeof parseNodeReadinessFacts>>, code: string) {
  const found = parsed.predicates.find((entry) => entry.code === code);
  expect(found, `predicate ${code} must always be present`).toBeDefined();
  return found!;
}

describe("caller fact classification", () => {
  it("classifies a confirmed-true fact and carries its provenance through unchanged", () => {
    const parsed = parseNodeReadinessFacts(bundle());
    expect(parsed).not.toBeNull();
    expect(parsed!.predicates).toHaveLength(CALLER_FACT_CODES.length);
    const budget = predicateOf(parsed!, "READINESS_DOWNSTREAM_PROOF_BUDGET");
    expect(budget.confidence).toBe("CONFIRMED_TRUE");
    expect(budget.layer).toBe("ADMISSION");
    expect(budget.provenance).toEqual({
      sourceFactRef: "fact:READINESS_DOWNSTREAM_PROOF_BUDGET",
      sourceFactVersion: 3,
      sourceFactDigest: DIGEST,
    });
    expect(parsed!.admission).toBe("CONFIRMED_TRUE");
    expect(parsed!.dispatch).toBe("CONFIRMED_TRUE");
  });

  it("keeps a confirmed-false fact CONFIRMED_FALSE with its provenance", () => {
    const parsed = parseNodeReadinessFacts(
      bundle({ facts: replacing("READINESS_NO_PAUSE", fact("READINESS_NO_PAUSE", "CONFIRMED_FALSE")) }),
    );
    const pause = predicateOf(parsed!, "READINESS_NO_PAUSE");
    expect(pause.confidence).toBe("CONFIRMED_FALSE");
    expect(pause.layer).toBe("DISPATCH");
    expect(pause.provenance).not.toBeNull();
    expect(parsed!.dispatch).toBe("CONFIRMED_FALSE");
    expect(parsed!.admission).toBe("CONFIRMED_TRUE");
  });

  it.each([
    ["READINESS_CAPABILITY", "ADMISSION"],
    ["READINESS_PROVIDER_SLOT_RESERVABLE", "DISPATCH"],
  ])("reports an absent %s fact as UNKNOWN on layer %s with no invented provenance", (code, layer) => {
    const parsed = parseNodeReadinessFacts(bundle({ facts: without(code) }));
    const absent = predicateOf(parsed!, code);
    expect(absent.confidence).toBe("UNKNOWN");
    expect(absent.code).toBe(code);
    expect(absent.layer).toBe(layer);
    expect(absent.provenance).toBeNull();
    expect(absent.recoveryRef).toBeNull();
  });

  it.each([
    ["malformed provenance", { provenance: { sourceFactRef: 5, sourceFactVersion: 3, sourceFactDigest: DIGEST } }],
    ["wrong-typed confidence", { confidence: "MAYBE" }],
    ["null confidence", { confidence: null }],
    ["missing digest", { provenance: { sourceFactRef: "fact:x", sourceFactVersion: 3, sourceFactDigest: "not-hex" } }],
  ])("never coerces a %s fact to CONFIRMED_FALSE", (_label, override) => {
    const parsed = parseNodeReadinessFacts(
      bundle({
        facts: replacing(
          "READINESS_EXACT_PLAN",
          fact("READINESS_EXACT_PLAN", "CONFIRMED_TRUE", override),
        ),
      }),
    );
    const plan = predicateOf(parsed!, "READINESS_EXACT_PLAN");
    expect(plan.confidence).toBe("UNKNOWN");
    expect(plan.layer).toBe("ADMISSION");
    expect(parsed!.admission).toBe("UNKNOWN");
  });

  it("treats a fact consumed past its declared horizon gate as UNKNOWN, not false", () => {
    const parsed = parseNodeReadinessFacts(
      bundle({
        currentGate: "ACCEPTANCE_QUALIFICATION",
        facts: replacing(
          "READINESS_CONTEXT",
          fact("READINESS_CONTEXT", "CONFIRMED_TRUE", { horizonGate: "EXECUTOR_CLAIM" }),
        ),
      }),
    );
    const context = predicateOf(parsed!, "READINESS_CONTEXT");
    expect(context.confidence).toBe("UNKNOWN");
    expect(context.provenance).not.toBeNull();
    expect(parsed!.admission).toBe("UNKNOWN");
  });

  it.each([
    ["behind", 3, 5],
    ["ahead of", 7, 5],
  ])("treats a fact %s the caller's current source-fact version as UNKNOWN", (_label, factVersion, currentVersion) => {
    const parsed = parseNodeReadinessFacts(
      bundle({
        currentFactVersions: [
          { sourceFactRef: "fact:READINESS_RISK_POLICY", version: currentVersion },
        ],
        facts: replacing(
          "READINESS_RISK_POLICY",
          fact("READINESS_RISK_POLICY", "CONFIRMED_TRUE", {
            provenance: provenance("fact:READINESS_RISK_POLICY", factVersion),
          }),
        ),
      }),
    );
    expect(predicateOf(parsed!, "READINESS_RISK_POLICY").confidence).toBe("UNKNOWN");
  });

  it("keeps a fact at exactly the caller's current source-fact version confirmed", () => {
    const parsed = parseNodeReadinessFacts(
      bundle({
        currentFactVersions: [
          { sourceFactRef: "fact:READINESS_RISK_POLICY", version: 3 },
        ],
      }),
    );
    expect(predicateOf(parsed!, "READINESS_RISK_POLICY").confidence).toBe("CONFIRMED_TRUE");
  });
});

describe("three-valued fold", () => {
  it("folds an empty fact list to UNKNOWN on both layers, never CONFIRMED_FALSE", () => {
    const parsed = parseNodeReadinessFacts(bundle({ facts: [] }));
    expect(parsed!.admission).toBe("UNKNOWN");
    expect(parsed!.dispatch).toBe("UNKNOWN");
    expect(parsed!.predicates.every((entry) => entry.confidence === "UNKNOWN")).toBe(true);
  });

  it("lets CONFIRMED_FALSE win over UNKNOWN, because not-eligible is itself confirmed", () => {
    const parsed = parseNodeReadinessFacts(
      bundle({
        facts: without("READINESS_CONTEXT").map((entry) =>
          entry["code"] === "READINESS_CAPABILITY"
            ? fact("READINESS_CAPABILITY", "CONFIRMED_FALSE")
            : entry,
        ),
      }),
    );
    expect(predicateOf(parsed!, "READINESS_CONTEXT").confidence).toBe("UNKNOWN");
    expect(parsed!.admission).toBe("CONFIRMED_FALSE");
  });

  it("covers every declared admission and dispatch code exactly once", () => {
    const parsed = parseNodeReadinessFacts(bundle({ facts: [] }));
    const codes = parsed!.predicates.map((entry) => entry.code);
    expect([...codes].sort()).toEqual([...CALLER_FACT_CODES].sort());
    expect(new Set(codes).size).toBe(ADMISSION_REASON_CODES.length + DISPATCH_REASON_CODES.length);
  });
});

describe("hostile input refuses before any element read", () => {
  it("refuses an oversized fact list on the bound without reading element 0", () => {
    const oversized: unknown[] = new Array(MAX_ADMISSION_ITEMS + 1).fill(null);
    let elementWasRead = false;
    Object.defineProperty(oversized, "0", {
      configurable: true,
      get() {
        elementWasRead = true;
        throw new Error("element read before the bound was applied");
      },
    });
    expect(parseNodeReadinessFacts(bundle({ facts: oversized }))).toBeNull();
    expect(elementWasRead).toBe(false);
  });

  it.each([
    ["a non-record", 7],
    ["an array", []],
    ["null", null],
  ])("refuses %s bundle", (_label, input) => {
    expect(parseNodeReadinessFacts(input)).toBeNull();
  });

  it("refuses an extra own key on the bundle", () => {
    expect(parseNodeReadinessFacts({ ...bundle(), extra: 1 })).toBeNull();
  });

  it("refuses a getter-bearing bundle", () => {
    const hostile = { ...bundle() };
    Object.defineProperty(hostile, "facts", { configurable: true, get: () => allTrue() });
    expect(parseNodeReadinessFacts(hostile)).toBeNull();
  });

  it("refuses a non-plain prototype while accepting an explicit null prototype", () => {
    class Bundle {}
    expect(parseNodeReadinessFacts(Object.assign(new Bundle(), bundle()))).toBeNull();
    expect(parseNodeReadinessFacts(Object.assign(Object.create(null), bundle()))).not.toBeNull();
  });

  it.each([
    ["a null fact entry", [null]],
    ["an unattributable entry with no code", [{ confidence: "CONFIRMED_TRUE" }]],
    ["a structural code a caller may not assert", [fact("READINESS_NOT_EXECUTION_BEARING", "CONFIRMED_TRUE")]],
    ["an unknown code", [fact("READINESS_MADE_UP", "CONFIRMED_TRUE")]],
  ])("refuses %s", (_label, facts) => {
    expect(parseNodeReadinessFacts(bundle({ facts }))).toBeNull();
  });

  it("refuses a duplicate predicate code", () => {
    expect(
      parseNodeReadinessFacts(
        bundle({ facts: [...allTrue(), fact("READINESS_CONTEXT", "CONFIRMED_FALSE")] }),
      ),
    ).toBeNull();
  });

  it.each([
    ["nodeKey", { nodeKey: "not a key" }],
    ["currentGate", { currentGate: "NOT_A_GATE" }],
    ["currentFactVersions", { currentFactVersions: [{ sourceFactRef: "", version: 1 }] }],
  ])("refuses a malformed %s", (_label, override) => {
    expect(parseNodeReadinessFacts(bundle(override))).toBeNull();
  });
});

function waitRecord(deadlineGate: string): Record<string, unknown> {
  return {
    waitRef: "wait:1",
    ownerNodeKey: "dev-node-1",
    reason: "awaiting an external approval window",
    predicate: {
      predicateRef: "predicate:approval-window",
      schemaId: "schema:approval",
      schemaVersion: 1,
      parametersDigest: DIGEST,
    },
    affectedScope: ["dev-node-1"],
    recheckAtGate: "EXECUTOR_CLAIM",
    deadlineGate,
    escalation: { kind: "ESCALATE_TO_HUMAN", ref: "escalation:1" },
    binding: {
      graphIdentity: "graph:1",
      sourceFactVersions: [{ sourceFactRef: "fact:approval", version: 2 }],
    },
  };
}

describe("intentional wait currency", () => {
  it("accepts a wait record that is still current at the caller's gate", () => {
    const parsed = parseNodeReadinessFacts(
      bundle({ currentGate: "EXECUTOR_CLAIM", wait: waitRecord("REVIEW_QUALIFICATION") }),
    );
    expect(parsed!.waitCurrent).toBe(true);
    expect(parsed!.wait?.waitRef).toBe("wait:1");
  });

  it("drops an expired wait record: an expired intention is not an intention", () => {
    const parsed = parseNodeReadinessFacts(
      bundle({ currentGate: "ACCEPTANCE_QUALIFICATION", wait: waitRecord("EFFECT_ACTIVATE") }),
    );
    expect(parsed!.waitCurrent).toBe(false);
    expect(parsed!.wait).toBeNull();
  });

  it("drops a malformed wait record rather than granting an intention", () => {
    const malformed = { ...waitRecord("GOAL_COMPLETION"), waitRef: "" };
    const parsed = parseNodeReadinessFacts(bundle({ wait: malformed }));
    expect(parsed!.waitCurrent).toBe(false);
    expect(parsed!.wait).toBeNull();
  });

  it("treats an absent wait as no intention without refusing the bundle", () => {
    const parsed = parseNodeReadinessFacts(bundle({ wait: null }));
    expect(parsed!.waitCurrent).toBe(false);
    expect(parsed!.wait).toBeNull();
  });
});
