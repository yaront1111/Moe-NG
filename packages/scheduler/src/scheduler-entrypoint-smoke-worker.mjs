import { parentPort } from "node:worker_threads";

import { createAcceptanceContract, createPlanRevision } from "@moe/core";

// The node-authority builders now arrive with everything else, through the BARE
// root: task-210efa47 landed the publication, so this worker imports them the way
// a real consumer would. The sibling-bridge coverage this file used to buy with a
// relative import is UNCHANGED, and that is the point of the root chain: under
// Node's REAL resolution the root reaches ./node-authority/node-authority-public.js,
// which reaches ./node-authority-codec.js and ./node-authority-recursion.js, which
// reach the remaining three. A missing or CRLF sibling bridge anywhere along that
// chain still surfaces here as ERR_MODULE_NOT_FOUND rather than passing silently —
// vitest resolves ./x.js back to x.ts and is blind to it, so this worker stays the
// only witness.
import {
  ADMISSION_PURPOSES,
  FAIRNESS_CONTRACT_ISSUE_CODES,
  FAIRNESS_CONTRACT_LAYERS,
  GRAPH_CONTENT_ISSUE_CODES,
  GRAPH_REVISION_CONTENT_KEYS,
  analyzeHardEdgeCounterfactuals,
  analyzeGraphStructure,
  createNodeDefinition,
  decodeGraphContent,
  deriveNodeAuthoritySet,
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
//
// The v3 section below is built by PRODUCTION code end to end — `createPlanRevision`,
// `createAcceptanceContract`, `createNodeDefinition` and `deriveNodeAuthoritySet` —
// so this worker also proves the codec's consumer edge to the NodeAuthority
// composer runs outside vitest, not merely that the codec loads.
const hex = (digit) => digit.repeat(64);
const planRevision = createPlanRevision({
  affectedCriterionIds: ["criterion-a"],
  affectedNodeIds: ["runtime-done"],
  approvalState: "APPROVED",
  authorRef: "principal-a",
  graphBinding: { graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a" },
  parentRevisionId: null,
  rejectionRef: null,
  revisionId: "plan-revision-a",
  steps: [{ description: "Land the node.", kind: "IMPLEMENTATION", stepId: "step-a" }],
  verificationRecipeRefs: ["recipe-a"],
});
const acceptanceContract = createAcceptanceContract({
  applicability: {
    graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a",
    nodeIds: ["runtime-done"], nodeKind: "LEAF",
  },
  authorRef: "principal-a",
  contractId: "acceptance-contract-a",
  obligations: [{
    criterionId: "criterion-a",
    evidenceRequirements: [
      { evidenceRef: "artifact-a", kind: "ARTIFACT", requirementId: "requirement-a" },
    ],
    statement: "The node ships its focused verification.",
    verificationRecipeRefs: ["recipe-a"],
  }],
});
if (!planRevision.ok || !acceptanceContract.ok) {
  throw new Error("runtime node authority fixture did not build");
}
const nodeDefinition = createNodeDefinition({
  acceptanceContract: acceptanceContract.contract,
  draft: {
    admissionAmounts: [...ADMISSION_PURPOSES].sort().map((purpose, index) => ({
      meter: "runner.authorized_ms", purpose, quantity: index + 1,
    })),
    admissionGatePolicy: "POLICY_ALLOWANCE",
    capability: "capability-implement",
    completionLinkage: "runtime-done",
    constraints: ["constraint-a"],
    directHardDependencies: [],
    joinRole: "COMPLETION",
    nodeKey: "runtime-done",
    objective: "Land the runtime node.",
    policySliceHash: hex("3"),
    readScopes: ["services/api/src/0"],
    repositoryBaseTree: hex("4"),
    resources: ["resource-a"],
    verificationRecipeRevisions: ["recipe-a"],
    writeScopes: ["services/api/src/node"],
  },
  planRevision: planRevision.revision,
  predicateRegistry: [],
});
if (!nodeDefinition.ok) {
  throw new Error("runtime node definition was not admitted");
}
const definitions = [nodeDefinition.value.definition];
const derivedAuthority = deriveNodeAuthoritySet(snapshot, definitions);
if (!derivedAuthority.ok) {
  throw new Error("runtime node authority set did not derive");
}
const revisionContent = {
  author: "human:runtime",
  completionNode: "runtime-done",
  decompositionBudget: 1,
  nodeAuthority: { authorities: derivedAuthority.value, definitions },
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
// A STATED authority the composer does not derive from the very definitions beside
// it. Shape-valid, so the field reader admits it and only the consumer edge can
// refuse — which is what pins that edge as live under Node's own resolution.
const forged = encodeGraphContent({
  ...revisionContent,
  nodeAuthority: {
    authorities: [{ nodeAuthorityHash: hex("9"), nodeKey: "runtime-done" }],
    definitions,
  },
});
const authorityRefusal = forged.ok
  ? "UNEXPECTEDLY_ADMITTED"
  : `${forged.issues[0].code}:${forged.issues[0].layer}`;

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
  authorityHashLength:
    encodedContent.value.content.nodeAuthority.authorities[0].nodeAuthorityHash.length,
  authorityNodeKeys:
    encodedContent.value.content.nodeAuthority.authorities.map((entry) => entry.nodeKey),
  authorityRefusal,
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
