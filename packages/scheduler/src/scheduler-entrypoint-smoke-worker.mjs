import { parentPort } from "node:worker_threads";

import {
  analyzeHardEdgeCounterfactuals,
  analyzeGraphStructure,
  partitionFrontier,
  validateGraphSnapshot,
} from "@moe/scheduler";

if (parentPort === null) {
  throw new Error("scheduler entrypoint smoke worker requires a parent port");
}

const validated = validateGraphSnapshot({
  completionNodeKey: "runtime-done",
  edges: [],
  nodes: [{ executionBearing: true, nodeKey: "runtime-done" }],
});
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
  counterfactualEdgeCount: counterfactuals.edges.length,
  counterfactualType: typeof analyzeHardEdgeCounterfactuals,
  dispatchableWidth: analysis.dispatchableWidth,
  logicalReadyWidth: analysis.logicalReadyWidth,
  internalSubpath,
  outcome: "IMPORTED",
  stageCount: analysis.structuralStageCount,
  validateType: typeof validateGraphSnapshot,
});
