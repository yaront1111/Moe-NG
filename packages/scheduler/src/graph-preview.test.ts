import { expect, it } from "vitest";

import * as scheduler from "./index.js";
import { previewGraphSnapshot } from "./graph-preview.js";
import {
  devAllAvailable,
  devHardEdge,
  devNode,
  devReversedOrder,
  devSnapshot,
  devUniformEdgeFacts,
} from "./test-fixtures.js";
import type {
  GraphPreviewOptions,
  GraphPreviewResult,
} from "./graph-preview-model.js";

const preview: (
  snapshot: unknown,
  options?: GraphPreviewOptions,
) => GraphPreviewResult = previewGraphSnapshot;

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

it("exports graph preview through the supported package root", () => {
  const candidate = (
    scheduler as unknown as Record<string, unknown>
  ).previewGraphSnapshot;

  expect(typeof candidate).toBe("function");
});

it("accepts frontier facts through one unambiguous options object", () => {
  const snapshot = chainSnapshot();
  const result = previewGraphSnapshot(snapshot, {
    frontierCursor: {
      hardEdgeFacts: devUniformEdgeFacts(snapshot, "SATISFIED"),
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    },
  });

  expect(result).toMatchObject({
    frontierFacts: "CALLER_SUPPLIED_UNVERIFIED",
    ok: true,
    outcome: "ANALYZED",
  });
});

it("rejects a frontier cursor mistaken for the options object", () => {
  const snapshot = chainSnapshot();
  const cursor = {
    hardEdgeFacts: devUniformEdgeFacts(snapshot, "SATISFIED"),
    nodeAvailabilityFacts: devAllAvailable(snapshot),
  };

  if (false) {
    // @ts-expect-error A cursor must be nested under options.frontierCursor.
    previewGraphSnapshot(snapshot, cursor);
  }
  const result = preview(
    snapshot,
    cursor as unknown as GraphPreviewOptions,
  );

  expect(result).toMatchObject({
    ok: false,
    outcome: "OPTIONS_INVALID",
    issues: [
      expect.objectContaining({ code: "GRAPH_PREVIEW_MALFORMED_OPTIONS" }),
    ],
  });
});

it("rejects malformed options without invoking accessors", () => {
  let reads = 0;
  const options = {} as Record<string, unknown>;
  Object.defineProperty(options, "frontierCursor", {
    get() {
      reads += 1;
      return {};
    },
  });

  const result = preview(
    chainSnapshot(),
    options as unknown as GraphPreviewOptions,
  );

  expect(result).toMatchObject({ ok: false, outcome: "OPTIONS_INVALID" });
  expect(reads).toBe(0);
});

it("returns an advisory analysis and preserves unknown readiness without frontier facts", () => {
  const result = preview(chainSnapshot());

  expect(result).toMatchObject({
    advisoryOnly: true,
    authority: "NONE",
    frontierFacts: "ABSENT",
    ok: true,
    outcome: "ANALYZED",
  });
  if (!result.ok) {
    throw new Error("expected analyzed preview");
  }
  expect(result.graphIdentity).toEqual(expect.any(String));
  expect(result.analysis).toMatchObject({
    admissionReadyWidth: null,
    dispatchableWidth: null,
    durationEstimate: null,
    logicalReadyWidth: null,
    structuralStageCount: 3,
  });
  expect(result).not.toHaveProperty("graph");
  expect(result).not.toHaveProperty("partition");
  expect(result).not.toHaveProperty("snapshot");
});

it("keeps logical, admission, and dispatch widths distinct for supplied facts", () => {
  const snapshot = chainSnapshot();
  const result = preview(snapshot, {
    frontierCursor: {
      hardEdgeFacts: devUniformEdgeFacts(snapshot, "SATISFIED"),
      nodeAvailabilityFacts: [
        { nodeKey: "dev-a", admissionEligible: true, dispatchAvailable: true },
        { nodeKey: "dev-b", admissionEligible: true, dispatchAvailable: false },
        { nodeKey: "dev-done", admissionEligible: false, dispatchAvailable: true },
      ],
    },
  });

  expect(result).toMatchObject({
    advisoryOnly: true,
    authority: "NONE",
    frontierFacts: "CALLER_SUPPLIED_UNVERIFIED",
    ok: true,
    outcome: "ANALYZED",
  });
  if (!result.ok) {
    throw new Error("expected analyzed preview");
  }
  expect(result.analysis).toMatchObject({
    admissionReadyWidth: 2,
    dispatchableWidth: 1,
    logicalReadyWidth: 3,
  });
});

it("fails at graph validation before inspecting supplied frontier input", () => {
  let frontierInspections = 0;
  const hostileCursor = new Proxy({}, {
    getOwnPropertyDescriptor() {
      frontierInspections += 1;
      throw new Error("frontier must not be inspected");
    },
    ownKeys() {
      frontierInspections += 1;
      throw new Error("frontier must not be inspected");
    },
  });

  const result = preview(
    { completionNodeKey: "dev-missing", edges: [], nodes: [] },
    { frontierCursor: hostileCursor },
  );

  expect(result).toMatchObject({
    advisoryOnly: true,
    authority: "NONE",
    ok: false,
    outcome: "GRAPH_INVALID",
  });
  if (result.ok || result.outcome !== "GRAPH_INVALID") {
    throw new Error("expected graph validation failure");
  }
  expect(result.issues.map((issue: { code: string }) => issue.code)).toContain(
    "GRAPH_COMPLETION_NODE_MISSING",
  );
  expect(frontierInspections).toBe(0);
  expect(result).not.toHaveProperty("analysis");
  expect(result).not.toHaveProperty("graphIdentity");
});

it("reports a malformed supplied frontier instead of treating it as absent", () => {
  const snapshot = devSnapshot([devNode("dev-done")], [], "dev-done");
  const result = preview(snapshot, { frontierCursor: {} });
  const explicitUndefined = preview(snapshot, { frontierCursor: undefined });

  expect(result).toMatchObject({
    advisoryOnly: true,
    authority: "NONE",
    graphIdentity: expect.any(String),
    ok: false,
    outcome: "FRONTIER_INVALID",
  });
  if (result.ok || result.outcome !== "FRONTIER_INVALID") {
    throw new Error("expected frontier validation failure");
  }
  expect(result.issues).toEqual([
    expect.objectContaining({ code: "FRONTIER_MALFORMED_CURSOR" }),
  ]);
  expect(result).not.toHaveProperty("analysis");
  expect(result).not.toHaveProperty("partition");
  expect(explicitUndefined).toMatchObject({
    frontierFacts: "ABSENT",
    ok: true,
    outcome: "ANALYZED",
  });
});

it("never upgrades an UNKNOWN hard dependency to logical readiness", () => {
  const snapshot = chainSnapshot();
  const result = preview(snapshot, {
    frontierCursor: {
      hardEdgeFacts: [
        { edgeKey: "dev-ab", state: "SATISFIED" },
        { edgeKey: "dev-bd", state: "UNKNOWN" },
      ],
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    },
  });

  expect(result).toMatchObject({
    frontierFacts: "CALLER_SUPPLIED_UNVERIFIED",
    ok: true,
    outcome: "ANALYZED",
  });
  if (!result.ok) {
    throw new Error("expected analyzed preview");
  }
  expect(result.analysis).toMatchObject({
    admissionReadyWidth: 2,
    dispatchableWidth: 2,
    logicalReadyWidth: 2,
  });
});

it("is deterministic across graph and frontier fact ordering", () => {
  const snapshot = chainSnapshot();
  const hardEdgeFacts = devUniformEdgeFacts(snapshot, "SATISFIED");
  const nodeAvailabilityFacts = devAllAvailable(snapshot);

  const forward = preview(snapshot, {
    frontierCursor: { hardEdgeFacts, nodeAvailabilityFacts },
  });
  const reversed = preview(devReversedOrder(snapshot), {
    frontierCursor: {
      hardEdgeFacts: [...hardEdgeFacts].reverse(),
      nodeAvailabilityFacts: [...nodeAvailabilityFacts].reverse(),
    },
  });

  expect(reversed).toEqual(forward);
});
