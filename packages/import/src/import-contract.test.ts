import { describe, expect, it } from "vitest";

import { AMBIGUITY_CLASSES, AMBIGUITY_OUTCOME, reconciliationFinding } from "./import-contract.js";
import type { ImportProvenance } from "./import-contract.js";

/**
 * The one reconciliation-finding factory shared by every detector (reconcile, the
 * dependsOn graph walk, skill-asset classification, and the duplicate-identity guard).
 * Three detectors used to carry a private copy and the fourth built its finding inline;
 * these cases pin what all of them did, so the shared one cannot drift from any of them.
 */

const PROVENANCE: ImportProvenance = {
  manifestDigest: "a".repeat(64),
  sourceDigest: "b".repeat(64),
  sourcePath: "skills/one/SKILL.md",
  sourceTime: "1970-01-01T00:00:00.000Z",
  timeBasis: "MANIFEST_SENTINEL",
};

describe("reconciliationFinding", () => {
  it("carries exactly the class, detail, provenance and the single outcome", () => {
    const found = reconciliationFinding("CYCLE", PROVENANCE, "record task-1 closes a cycle");
    expect(found).toEqual({
      ambiguityClass: "CYCLE",
      detail: "record task-1 closes a cycle",
      outcome: AMBIGUITY_OUTCOME,
      provenance: PROVENANCE,
    });
    expect(Object.keys(found)).toEqual(["ambiguityClass", "detail", "outcome", "provenance"]);
  });

  it("freezes the finding itself, so no detector can amend one after reporting it", () => {
    const found = reconciliationFinding("UNKNOWN_FIELD", PROVENANCE, "field mystery");
    expect(Object.isFrozen(found)).toBe(true);
    expect(() => {
      (found as { detail: string }).detail = "rewritten";
    }).toThrow(TypeError);
    expect(found.detail).toBe("field mystery");
  });

  it("keeps the caller's provenance by reference and does not freeze it (a shallow freeze)", () => {
    const found = reconciliationFinding("SKILL_MALFORMED", PROVENANCE, "no descriptor");
    expect(found.provenance).toBe(PROVENANCE);
    expect(Object.isFrozen(PROVENANCE)).toBe(false);
  });

  it("preserves an empty detail verbatim rather than substituting one", () => {
    expect(reconciliationFinding("CORRUPT_BYTES", PROVENANCE, "").detail).toBe("");
  });

  it("builds a finding for every declared ambiguity class, each with the same outcome", () => {
    for (const ambiguityClass of AMBIGUITY_CLASSES) {
      const found = reconciliationFinding(ambiguityClass, PROVENANCE, ambiguityClass);
      expect(found.ambiguityClass).toBe(ambiguityClass);
      expect(found.outcome).toBe("NEEDS_RECONCILIATION");
    }
  });

  it("returns a fresh object per call, so two identical findings never share identity", () => {
    const first = reconciliationFinding("DANGLING_REF", PROVENANCE, "missing task-2");
    const second = reconciliationFinding("DANGLING_REF", PROVENANCE, "missing task-2");
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
