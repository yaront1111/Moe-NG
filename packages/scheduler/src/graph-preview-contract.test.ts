import { expect, it } from "vitest";

import { previewGraphSnapshot } from "./graph-preview.js";
import {
  devAllAvailable,
  devHardEdge,
  devNode,
  devSnapshot,
  devUniformEdgeFacts,
} from "./test-fixtures.js";
import type { GraphPreviewOptions } from "./graph-preview-model.js";

function chainSnapshot() {
  return devSnapshot(
    [devNode("dev-a"), devNode("dev-b"), devNode("dev-done")],
    [
      devHardEdge("dev-ab", "dev-a", "dev-b"),
      devHardEdge("dev-bd", "dev-b", "dev-done"),
    ],
    "dev-done",
  );
}

it("binds policy-dependent analysis separately from structural graph identity", () => {
  const snapshot = chainSnapshot();
  const permissive = previewGraphSnapshot(snapshot, {
    policyOverride: { minGatedDescendantsForReview: 0 },
  });
  const quiet = previewGraphSnapshot(snapshot, {
    policyOverride: { minGatedDescendantsForReview: 64 },
  });
  if (!permissive.ok || !quiet.ok) {
    throw new Error("expected analyzed previews");
  }

  expect(permissive.graphIdentity).toBe(quiet.graphIdentity);
  expect(permissive.analysis.diagnostics).not.toEqual(quiet.analysis.diagnostics);
  expect(permissive.previewIdentity).not.toBe(quiet.previewIdentity);
});

it("binds distinct caller frontier assertions to distinct preview identities", () => {
  const snapshot = chainSnapshot();
  const hardEdgeFacts = devUniformEdgeFacts(snapshot, "SATISFIED");
  const allAvailable = previewGraphSnapshot(snapshot, {
    frontierCursor: {
      hardEdgeFacts,
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    },
  });
  const noneAvailable = previewGraphSnapshot(snapshot, {
    frontierCursor: {
      hardEdgeFacts,
      nodeAvailabilityFacts: snapshot.nodes.map((node) => ({
        admissionEligible: false,
        dispatchAvailable: false,
        nodeKey: node.nodeKey,
      })),
    },
  });
  if (!allAvailable.ok || !noneAvailable.ok) {
    throw new Error("expected analyzed previews");
  }

  expect(allAvailable.graphIdentity).toBe(noneAvailable.graphIdentity);
  expect(allAvailable.analysis.admissionReadyWidth).toBe(3);
  expect(noneAvailable.analysis.admissionReadyWidth).toBe(0);
  expect(allAvailable.previewIdentity).not.toBe(noneAvailable.previewIdentity);
});

it("binds absent frontier facts separately from supplied frontier facts", () => {
  const snapshot = chainSnapshot();
  const absent = previewGraphSnapshot(snapshot);
  const supplied = previewGraphSnapshot(snapshot, {
    frontierCursor: {
      hardEdgeFacts: devUniformEdgeFacts(snapshot, "SATISFIED"),
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    },
  });
  if (!absent.ok || !supplied.ok) {
    throw new Error("expected analyzed previews");
  }

  expect(absent.frontierFacts).toBe("ABSENT");
  expect(absent.analysis.logicalReadyWidth).toBeNull();
  expect(supplied.analysis.logicalReadyWidth).toBe(3);
  expect(absent.previewIdentity).not.toBe(supplied.previewIdentity);
});

it("deep-freezes every result envelope", () => {
  const valid = previewGraphSnapshot(chainSnapshot());
  const optionsInvalid = previewGraphSnapshot(
    chainSnapshot(),
    { typo: true } as unknown as GraphPreviewOptions,
  );
  const policyInvalid = previewGraphSnapshot(chainSnapshot(), {
    policyOverride: { maxNodes: -1 },
  });
  const graphInvalid = previewGraphSnapshot({});
  const frontierInvalid = previewGraphSnapshot(
    devSnapshot([devNode("dev-done")], [], "dev-done"),
    { frontierCursor: null },
  );

  expect(Object.isFrozen(valid)).toBe(true);
  if (!valid.ok) {
    throw new Error("expected analyzed preview");
  }
  expect(Object.isFrozen(valid.analysis)).toBe(true);
  expect(Object.isFrozen(valid.analysis.topologicalOrder)).toBe(true);
  for (const invalid of [
    optionsInvalid,
    policyInvalid,
    graphInvalid,
    frontierInvalid,
  ]) {
    expect(Object.isFrozen(invalid)).toBe(true);
    if (invalid.ok) {
      throw new Error("expected validation failure");
    }
    expect(Object.isFrozen(invalid.issues)).toBe(true);
  }
});

it("classifies a malformed policy separately from graph defects", () => {
  const result = previewGraphSnapshot(chainSnapshot(), {
    policyOverride: { maxNodes: -1 },
  });

  expect(result).toMatchObject({
    advisoryOnly: true,
    authority: "NONE",
    ok: false,
    outcome: "POLICY_INVALID",
  });
  if (result.ok) {
    throw new Error("expected policy validation failure");
  }
  expect(result.issues).toEqual([
    expect.objectContaining({ code: "GRAPH_MALFORMED_POLICY" }),
  ]);
});
