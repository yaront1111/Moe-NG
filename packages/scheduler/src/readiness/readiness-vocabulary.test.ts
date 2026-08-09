/**
 * Closed-vocabulary sweep. Every READINESS_REASON_CODES member must be
 * reachable from a real production surface and the OBSERVED set must EQUAL the
 * declared set, so an unreachable code fails the suite instead of sitting in
 * the union as decoration.
 *
 * The sweep asserts it actually generated its cases: a sweep that silently
 * produces zero iterations passes while testing nothing.
 */
import { describe, expect, it } from "vitest";

import { explainReadiness } from "./readiness-explanation.js";
import { projectReadiness } from "./readiness-projection.js";
import {
  CALLER_FACT_CODES,
  READINESS_CLASSES,
  READINESS_REASON_CODES,
  READINESS_REASON_LAYERS,
} from "./readiness-model.js";
import {
  DEV_ADVISORY,
  DEV_CAPABILITY,
  devBundle,
  devBundlesWith,
  devFact,
  devFactsWith,
  devGraph,
  devInput,
} from "./test-fixtures.js";

function reasonCodesFor(nodeKey: string, input: unknown): string[] {
  const graph = devGraph();
  const projected = projectReadiness(graph, input);
  expect(projected.ok).toBe(true);
  if (!projected.ok) {
    throw new Error("unreachable");
  }
  const entry = explainReadiness(graph, projected.projection).entries.find(
    (item) => item.nodeKey === nodeKey,
  );
  expect(entry, `node ${nodeKey} must be explained`).toBeDefined();
  return entry!.reasons.map((reason) => reason.code);
}

describe("closed reason vocabulary", () => {
  it("reaches every declared reason code from a production surface, and no other", () => {
    const observed = new Set<string>();
    let generated = 0;

    for (const code of CALLER_FACT_CODES) {
      generated += 1;
      const bundle = devBundle(
        DEV_CAPABILITY,
        devFactsWith(code, devFact(code, "CONFIRMED_FALSE")),
      );
      const codes = reasonCodesFor(
        DEV_CAPABILITY,
        devInput({ nodeFacts: devBundlesWith(DEV_CAPABILITY, bundle) }),
      );
      // The case really was generated AND really produced its own code.
      expect(codes, `sweep case ${code} produced no matching reason`).toContain(code);
      for (const observedCode of codes) {
        observed.add(observedCode);
      }
    }
    expect(generated).toBe(CALLER_FACT_CODES.length);
    expect(generated).toBeGreaterThan(0);

    for (const code of reasonCodesFor(DEV_ADVISORY, devInput())) {
      observed.add(code);
    }

    const observedReadinessCodes = [...observed]
      .filter((code) => code.startsWith("READINESS_"))
      .sort();
    expect(observedReadinessCodes).toEqual([...READINESS_REASON_CODES].sort());
  });

  it("declares a layer for every reason code and no code outside the union", () => {
    expect(Object.keys(READINESS_REASON_LAYERS).sort()).toEqual(
      [...READINESS_REASON_CODES].sort(),
    );
  });

  it("classifies only into declared readiness classes", () => {
    const graph = devGraph();
    const projected = projectReadiness(graph, devInput());
    expect(projected.ok).toBe(true);
    if (!projected.ok) {
      throw new Error("unreachable");
    }
    const entries = explainReadiness(graph, projected.projection).entries;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(READINESS_CLASSES).toContain(entry.readinessClass);
    }
  });
});
