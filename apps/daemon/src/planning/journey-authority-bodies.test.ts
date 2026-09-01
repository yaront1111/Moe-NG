import { decodeGraphContent } from "@moe/scheduler";
import { expect, it } from "vitest";

import { journeyAuthority } from "./journey-authority-bodies.js";

it("gates every shipped execution node on human approval", () => {
  const sealed = journeyAuthority({
    authorRef: "operator-local",
    criterionIds: ["goal-live-1-criterion"],
    graphRevisionRef: "graph-revision-1",
    idPrefix: "run-live-1",
    nodeIds: ["node-code-1"],
    stepDescription: "Land the live board's demo node.",
  });
  const decoded = decodeGraphContent(Buffer.from(sealed.graphContentBytesBase64, "base64"));
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;

  const executionNodes = new Set(decoded.value.content.snapshot.nodes
    .filter((node) => node.executionBearing)
    .map((node) => node.nodeKey));
  expect(executionNodes.size).toBeGreaterThan(0);
  const definitions = decoded.value.content.nodeAuthority.definitions
    .filter((definition) => executionNodes.has(definition.nodeKey));
  expect(definitions).toHaveLength(executionNodes.size);
  for (const definition of definitions) {
    expect(definition.admissionGatePolicy).toBe("HUMAN_APPROVAL");
  }
});
