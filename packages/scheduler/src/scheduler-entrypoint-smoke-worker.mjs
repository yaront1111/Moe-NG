import { parentPort } from "node:worker_threads";

import {
  FAIRNESS_CONTRACT_ISSUE_CODES,
  FAIRNESS_CONTRACT_LAYERS,
  GRAPH_CONTENT_ISSUE_CODES,
  GRAPH_REVISION_CONTENT_KEYS,
  analyzeHardEdgeCounterfactuals,
  analyzeGraphStructure,
  decodeGraphContent,
  encodeGraphContent,
  partitionFrontier,
  previewGraphSnapshot,
  validateBypassClaim,
  validateGraphSnapshot,
  validateRing,
} from "@moe/scheduler";

if (parentPort === null) {
  throw new Error("scheduler entrypoint smoke worker requires a parent port");
}

const snapshot = {
  completionNodeKey: "runtime-done",
  edges: [],
  nodes: [{ executionBearing: true, nodeKey: "runtime-done" }],
};
const validated = validateGraphSnapshot(snapshot);
if (!validated.ok) {
  throw new Error("runtime graph did not validate");
}
const frontier = partitionFrontier(validated.graph, {
  hardEdgeFacts: [],
  nodeAvailabilityFacts: [{
    admissionEligible: true,
    dispatchAvailable: true,
    nodeKey: "runtime-done",
  }],
});
if (!frontier.ok) {
  throw new Error("runtime frontier did not partition");
}
const analysis = analyzeGraphStructure(validated.graph, frontier.partition);
const counterfactuals = analyzeHardEdgeCounterfactuals(validated.graph);
const preview = previewGraphSnapshot(snapshot, {
  frontierCursor: {
    hardEdgeFacts: [],
    nodeAvailabilityFacts: [{
      admissionEligible: true,
      dispatchAvailable: true,
      nodeKey: "runtime-done",
    }],
  },
});
if (!preview.ok) {
  throw new Error("runtime graph preview did not analyze");
}
// Fairness contracts, exercised here and not only under vitest: vitest resolves a
// NodeNext "./x.js" specifier back to "./x.ts" and is therefore blind to a
// missing sibling bridge. Only this worker runs Node's real resolution, so a
// deleted bridge under ./fairness/ shows up as an ERR_MODULE_NOT_FOUND here.
const bypass = validateBypassClaim({
  workItemId: "wi-a",
  claimedBypasses: 2,
  attestations: [],
});
const fairnessBypassRefusal = bypass.ok
  ? "UNEXPECTEDLY_ADMITTED"
  : `${bypass.disposition}:${bypass.issues[0].code}:${bypass.issues[0].layer}`;
const ring = validateRing({
  ringId: "ring-1",
  dimensionId: "dim-1",
  resources: [{ resourceId: "res-a", weight: 1 }, { resourceId: "res-b", weight: 1 }],
  entries: [
    { workItemId: "wi-a", resourceId: "res-a", deficitCounter: 0 },
    { workItemId: "wi-a", resourceId: "res-b", deficitCounter: 0 },
  ],
});
const fairnessRingRefusal = ring.ok
  ? "UNEXPECTEDLY_ADMITTED"
  : `${ring.disposition}:${ring.issues[0].code}:${ring.issues[0].layer}`;

// The graph-content codec, exercised under Node's real resolution for the same
// reason: `graph-content.js` imports `./graph-content-fields.js`,
// `./graph-content-format.js` and `./graph-content-issues.js` literally, and a
// missing or CRLF sibling bridge is invisible to both vitest and tsc.
const revisionContent = {
  author: "human:runtime",
  completionNode: "runtime-done",
  decompositionBudget: 1,
  parentRevision: null,
  policyRevision: "pol-runtime",
  repositoryBaseTree: "4".repeat(40),
  snapshot,
};
const encodedContent = encodeGraphContent(revisionContent);
if (!encodedContent.ok) {
  throw new Error("runtime graph content did not encode");
}
const decodedContent = decodeGraphContent(encodedContent.value.bytes);
const contentRoundTrip = decodedContent.ok
  && decodedContent.value.graphContentHash === encodedContent.value.graphContentHash
  ? "MATCHED"
  : "DRIFTED";
// Content authority is never the structural identity, proven through the bare
// specifier rather than the internal module (dec-64b2391c).
const contentAuthority =
  encodedContent.value.graphContentHash === encodedContent.value.snapshotIdentity
    ? "COLLAPSED_ONTO_STRUCTURE"
    : "SEPARATE";
const drifted = encodeGraphContent({ ...revisionContent, completionNode: "runtime-other" });
const contentRefusal = drifted.ok
  ? "UNEXPECTEDLY_ADMITTED"
  : `${drifted.issues[0].code}:${drifted.issues[0].layer}`;

let internalSubpath;
try {
  await import("@moe/scheduler/src/graph-provenance.js");
  internalSubpath = "UNEXPECTEDLY_EXPORTED";
} catch (error) {
  internalSubpath = error instanceof Error && "code" in error
    ? error.code
    : "UNKNOWN_ERROR";
}

parentPort.postMessage({
  admissionReadyWidth: analysis.admissionReadyWidth,
  contentAuthority,
  contentHashLength: encodedContent.value.graphContentHash.length,
  contentIssueCodeCount: GRAPH_CONTENT_ISSUE_CODES.length,
  contentKeyCount: GRAPH_REVISION_CONTENT_KEYS.length,
  contentRefusal,
  contentRoundTrip,
  counterfactualEdgeCount: counterfactuals.edges.length,
  counterfactualType: typeof analyzeHardEdgeCounterfactuals,
  dispatchableWidth: analysis.dispatchableWidth,
  fairnessBypassRefusal,
  fairnessIssueCodeCount: FAIRNESS_CONTRACT_ISSUE_CODES.length,
  fairnessLayerCount: FAIRNESS_CONTRACT_LAYERS.length,
  fairnessRingRefusal,
  logicalReadyWidth: analysis.logicalReadyWidth,
  internalSubpath,
  outcome: "IMPORTED",
  previewAuthority: preview.authority,
  previewOutcome: preview.outcome,
  previewType: typeof previewGraphSnapshot,
  stageCount: analysis.structuralStageCount,
  validateType: typeof validateGraphSnapshot,
});
