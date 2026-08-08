import { describe, expect, it } from "vitest";

import {
  createReleaseHandoff,
  type ReleaseHandoffInput,
  type ReleaseHandoffReferenceField,
} from "./release-handoff.js";

const REF_A = "a".repeat(64);
const REF_B = "b".repeat(64);
const REF_C = "c".repeat(64);
const REF_D = "d".repeat(64);
const REF_E = "e".repeat(64);

const baseInput: ReleaseHandoffInput = {
  contextManifestDigest: REF_A,
  journalDigest: REF_B,
  graphReference: REF_C,
  leaseReference: REF_D,
  evidenceReceiptReference: REF_E,
};

function requireCreated(input: ReleaseHandoffInput = baseInput) {
  const result = createReleaseHandoff(input);
  if (result.kind !== "CREATED") throw new Error("expected handoff creation");
  return result.handoff;
}

describe("release handoff", () => {
  it("creates an immutable package of opaque content references", () => {
    const handoff = requireCreated();
    expect(handoff).toMatchObject({
      contextManifestDigest: REF_A,
      journalDigest: REF_B,
      graphReference: REF_C,
      leaseReference: REF_D,
      evidenceReceiptReference: REF_E,
    });
    expect(Object.isFrozen(handoff)).toBe(true);
  });

  it("binds every cited identity into the handoff digest", () => {
    const fields = [
      "contextManifestDigest",
      "journalDigest",
      "graphReference",
      "leaseReference",
      "evidenceReceiptReference",
    ] as const satisfies readonly ReleaseHandoffReferenceField[];
    const original = requireCreated();
    const changedDigests = fields.map((field, index) =>
      requireCreated({
        ...baseInput,
        [field]: String(index + 1).repeat(64),
      }).digest,
    );

    expect(changedDigests).toHaveLength(fields.length);
    expect(changedDigests.length).toBeGreaterThan(0);
    for (const digest of changedDigests) expect(digest).not.toBe(original.digest);
  });

  it("refuses malformed references with their exact field and layer", () => {
    const invalidCases = [
      { field: "contextManifestDigest", value: "a".repeat(63) },
      { field: "journalDigest", value: "z".repeat(64) },
      { field: "graphReference", value: "abc" },
      { field: "leaseReference", value: "g".repeat(64) },
      { field: "evidenceReceiptReference", value: "f".repeat(63) },
    ] as const;
    expect(invalidCases.length).toBe(5);
    expect(invalidCases.length).toBeGreaterThan(0);

    for (const invalid of invalidCases) {
      expect(
        createReleaseHandoff({ ...baseInput, [invalid.field]: invalid.value }),
      ).toEqual({
        kind: "REFUSED",
        code: "INVALID_CONTENT_REFERENCE",
        layer: "RELEASE_HANDOFF",
        field: invalid.field,
      });
    }
  });

  it("normalizes valid uppercase hex before binding", () => {
    const handoff = requireCreated({ ...baseInput, graphReference: REF_C.toUpperCase() });
    expect(handoff.graphReference).toBe(REF_C);
    expect(handoff.digest).toBe(requireCreated().digest);
  });
});
