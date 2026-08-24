/**
 * Production-reachable budget-settlement refusals on a bare durable store.
 *
 * Production cannot currently commit an effect activation, so this suite stops at the two
 * settlement rungs a real store can reach without inventing activation, run, or budget facts.
 * Later rungs remain named TODOs instead of fixture-authored authority.
 */

import { afterAll, describe, expect, it } from "vitest";

import {
  applySettlement,
  cleanupSettlementScratchRoots,
  openUnactivatedBudgetFixture,
  storeWideEventHorizon,
} from "./budget-settlement-fixtures.js";

interface RefusalTuple {
  readonly code: unknown;
  readonly layer: unknown;
  readonly sourceCode: unknown;
  readonly sourceLayer: unknown;
}

const REACHABLE_CASES = [
  {
    attemptRef: "",
    expected: {
      code: "BUDGET_SETTLEMENT_REQUEST_INVALID",
      layer: "BUDGET_SETTLEMENT_APPLICATION",
      sourceCode: null,
      sourceLayer: null,
    },
    name: "names invalid input before the same empty store's missing run",
  },
  {
    attemptRef: "attempt-never-run",
    expected: {
      code: "BUDGET_SETTLEMENT_RUN_ABSENT",
      layer: "BUDGET_SETTLEMENT_APPLICATION",
      sourceCode: "PROVIDER_RUN_EVIDENCE_ABSENT",
      sourceLayer: "PROVIDER_RUN_READER",
    },
    name: "forwards the durable provider-run absence",
  },
] as const;

const UNREACHABLE_CODES = [
  "BUDGET_SETTLEMENT_GOAL_UNRESOLVED",
  "BUDGET_SETTLEMENT_LEDGER_UNREADABLE",
  "BUDGET_SETTLEMENT_RESERVATION_AMBIGUOUS",
  "BUDGET_SETTLEMENT_RESERVATION_ABSENT",
] as const;

function refusalOf(outcome: unknown): RefusalTuple {
  if (typeof outcome !== "object" || outcome === null) {
    throw new Error("settlement returned a non-object outcome");
  }
  const value = outcome as Readonly<Record<string, unknown>>;
  if (value["ok"] !== false) throw new Error("expected a production settlement refusal");
  return {
    code: value["code"],
    layer: value["layer"],
    sourceCode: value["sourceCode"],
    sourceLayer: value["sourceLayer"],
  };
}

afterAll(cleanupSettlementScratchRoots);

describe("provider usage applied to budget — reachable refusal ladder", () => {
  it("generates both production-reachable rungs", () => {
    expect(REACHABLE_CASES).toHaveLength(2);
    expect(REACHABLE_CASES.length).toBeGreaterThan(0);
  });

  it.each(REACHABLE_CASES)("$name", ({ attemptRef, expected }) => {
    const label = attemptRef.length === 0 ? "invalid" : "run-absent";
    const store = openUnactivatedBudgetFixture(`reachable-${label}`);
    try {
      expect(storeWideEventHorizon(store)).toBe(0n);

      expect(refusalOf(applySettlement(store, attemptRef))).toStrictEqual(expected);

      // The store-wide horizon catches writes outside the budget aggregate too.
      expect(storeWideEventHorizon(store)).toBe(0n);
    } finally {
      store.close();
    }
  });

  it("discriminates the reachable rungs and produces none of the gated codes", () => {
    const codes = REACHABLE_CASES.map(({ attemptRef }, index) => {
      const store = openUnactivatedBudgetFixture(`discrimination-${index}`);
      try {
        expect(storeWideEventHorizon(store)).toBe(0n);
        const code = refusalOf(applySettlement(store, attemptRef)).code;
        expect(storeWideEventHorizon(store)).toBe(0n);
        return code;
      } finally {
        store.close();
      }
    });

    expect(codes).toHaveLength(2);
    expect(codes[0]).not.toBe(codes[1]);
    expect(new Set(codes)).toStrictEqual(new Set([
      "BUDGET_SETTLEMENT_REQUEST_INVALID",
      "BUDGET_SETTLEMENT_RUN_ABSENT",
    ]));
    expect(UNREACHABLE_CODES).toHaveLength(4);
    for (const code of UNREACHABLE_CODES) expect(codes).not.toContain(code);
  });
});

describe("provider usage applied to budget — unreachable claims stay visible", () => {
  it.todo("rung 3: goal unresolved after a durable provider run");
  it.todo("rung 4: budget ledger unreadable after a durable run and goal");
  it.todo("rung 5: ambiguous activated reservations for one attempt");
  it.todo("rung 6: activated reservation absent after all earlier evidence exists");
  it.todo("COMPLETE, PARTIAL, and UNKNOWN settlement dispositions remain distinct");
  it.todo("settlement replay and cross-attempt binding preserve conserved balances");
  it.todo("activation ingress reaches the budget-binding store refusal");
});
