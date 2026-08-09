/**
 * DEVELOPMENT_ONLY fixtures for the readiness engine tests.
 *
 * The base graph is built so the three readiness layers GENUINELY DIFFER — a
 * fixture where they coincide makes `dispatchable ⊆ admissionReady ⊆
 * logicalReady` trivially true and proves nothing:
 *
 *   dev-ready      HARD-> dev-done   all facts confirmed          -> dispatchable
 *   dev-resource   HARD-> dev-done   resource confirmed FALSE     -> admissionReady only
 *   dev-capability HARD-> dev-done   capability confirmed FALSE   -> logicalReady only
 *   dev-advisory   ADVISORY-> dev-done   all facts confirmed      -> no execution authority
 *   dev-done       blocked by its three UNSATISFIED incoming HARD edges
 */
import { validateGraphSnapshot } from "../validate-graph.js";
import type { GraphSnapshot, HardEdgeSatisfaction, ValidatedGraph } from "../graph-model.js";
import { CALLER_FACT_CODES } from "./readiness-model.js";

export const DEV_DIGEST = "a".repeat(64);

export const DEV_READY = "dev-ready";
export const DEV_RESOURCE = "dev-resource";
export const DEV_CAPABILITY = "dev-capability";
export const DEV_ADVISORY = "dev-advisory";
export const DEV_DONE = "dev-done";

export const DEV_SNAPSHOT: GraphSnapshot = {
  completionNodeKey: DEV_DONE,
  nodes: [
    { nodeKey: DEV_READY, executionBearing: true },
    { nodeKey: DEV_RESOURCE, executionBearing: true },
    { nodeKey: DEV_CAPABILITY, executionBearing: true },
    { nodeKey: DEV_ADVISORY, executionBearing: false },
    { nodeKey: DEV_DONE, executionBearing: true },
  ],
  edges: [
    { edgeKey: "dev-edge-ready", kind: "HARD", producerNodeKey: DEV_READY, consumerNodeKey: DEV_DONE },
    { edgeKey: "dev-edge-resource", kind: "HARD", producerNodeKey: DEV_RESOURCE, consumerNodeKey: DEV_DONE },
    { edgeKey: "dev-edge-capability", kind: "HARD", producerNodeKey: DEV_CAPABILITY, consumerNodeKey: DEV_DONE },
    { edgeKey: "dev-edge-advisory", kind: "ADVISORY", producerNodeKey: DEV_ADVISORY, consumerNodeKey: DEV_DONE },
  ],
};

export function devGraph(): ValidatedGraph {
  const validated = validateGraphSnapshot(DEV_SNAPSHOT);
  if (!validated.ok) {
    throw new Error("readiness fixture graph must validate");
  }
  return validated.graph;
}

export function devProvenance(ref: string, version = 3): Record<string, unknown> {
  return {
    sourceFactRef: ref,
    sourceFactVersion: version,
    sourceFactDigest: DEV_DIGEST,
  };
}

export function devFact(
  code: string,
  confidence: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    code,
    confidence,
    provenance: devProvenance(`fact:${code}`),
    horizonGate: "GOAL_COMPLETION",
    recoveryRef: `recovery:${code}`,
    ...overrides,
  };
}

export function devAllTrueFacts(): Record<string, unknown>[] {
  return CALLER_FACT_CODES.map((code) => devFact(code, "CONFIRMED_TRUE"));
}

/** All-true facts with `code` replaced by `replacement`, or dropped if null. */
export function devFactsWith(
  code: string,
  replacement: Record<string, unknown> | null,
): Record<string, unknown>[] {
  const facts = devAllTrueFacts().filter((entry) => entry["code"] !== code);
  return replacement === null ? facts : [...facts, replacement];
}

export function devBundle(
  nodeKey: string,
  facts: Record<string, unknown>[] = devAllTrueFacts(),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    nodeKey,
    currentGate: "EXECUTOR_CLAIM",
    facts,
    wait: null,
    currentFactVersions: [],
    ...overrides,
  };
}

/** The base bundles: ready dispatchable, resource blocked, capability blocked. */
export function devBundles(): Record<string, unknown>[] {
  return [
    devBundle(DEV_READY),
    devBundle(
      DEV_RESOURCE,
      devFactsWith(
        "READINESS_RESOURCE_CONFIRMED_ACTIVE",
        devFact("READINESS_RESOURCE_CONFIRMED_ACTIVE", "CONFIRMED_FALSE"),
      ),
    ),
    devBundle(
      DEV_CAPABILITY,
      devFactsWith("READINESS_CAPABILITY", devFact("READINESS_CAPABILITY", "CONFIRMED_FALSE")),
    ),
    devBundle(DEV_ADVISORY),
    devBundle(DEV_DONE),
  ];
}

export function devEdgeFacts(
  state: HardEdgeSatisfaction = "UNSATISFIED",
  overrides: Readonly<Record<string, HardEdgeSatisfaction>> = {},
): Record<string, unknown>[] {
  return ["dev-edge-ready", "dev-edge-resource", "dev-edge-capability"].map((edgeKey) => ({
    edgeKey,
    state: overrides[edgeKey] ?? state,
  }));
}

export function devInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { hardEdgeFacts: devEdgeFacts(), nodeFacts: devBundles(), ...overrides };
}

/** Replace one node's bundle in the base set. */
export function devBundlesWith(
  nodeKey: string,
  bundle: Record<string, unknown>,
): Record<string, unknown>[] {
  return devBundles().map((entry) => (entry["nodeKey"] === nodeKey ? bundle : entry));
}

/**
 * `recheckAtGate` must not sit past `deadlineGate` or the record is malformed
 * rather than expired, so an expired fixture has to move BOTH gates behind the
 * bundle's `currentGate` of EXECUTOR_CLAIM.
 */
export function devWait(
  deadlineGate = "REVIEW_QUALIFICATION",
  recheckAtGate = "EXECUTOR_CLAIM",
): Record<string, unknown> {
  return {
    waitRef: "wait:dev",
    ownerNodeKey: DEV_CAPABILITY,
    reason: "awaiting an external approval window",
    predicate: {
      predicateRef: "predicate:approval-window",
      schemaId: "schema:approval",
      schemaVersion: 1,
      parametersDigest: DEV_DIGEST,
    },
    affectedScope: [DEV_CAPABILITY],
    recheckAtGate,
    deadlineGate,
    escalation: { kind: "ESCALATE_TO_HUMAN", ref: "escalation:dev" },
    binding: {
      graphIdentity: "graph:dev",
      sourceFactVersions: [{ sourceFactRef: "fact:approval", version: 2 }],
    },
  };
}

/**
 * A second fixture with real descendants, for the failed-predecessor case:
 *
 *   dev-producer HARD-> dev-consumer HARD-> dev-done   (both edges UNSATISFIED)
 *   dev-free     HARD-> dev-done                       (SATISFIED, unrelated)
 */
export const DEV_PRODUCER = "dev-producer";
export const DEV_CONSUMER = "dev-consumer";
export const DEV_FREE = "dev-free";

export const DEV_CHAIN_SNAPSHOT: GraphSnapshot = {
  completionNodeKey: DEV_DONE,
  nodes: [
    { nodeKey: DEV_PRODUCER, executionBearing: true },
    { nodeKey: DEV_CONSUMER, executionBearing: true },
    { nodeKey: DEV_FREE, executionBearing: true },
    { nodeKey: DEV_DONE, executionBearing: true },
  ],
  edges: [
    { edgeKey: "dev-edge-produce", kind: "HARD", producerNodeKey: DEV_PRODUCER, consumerNodeKey: DEV_CONSUMER },
    { edgeKey: "dev-edge-consume", kind: "HARD", producerNodeKey: DEV_CONSUMER, consumerNodeKey: DEV_DONE },
    { edgeKey: "dev-edge-free", kind: "HARD", producerNodeKey: DEV_FREE, consumerNodeKey: DEV_DONE },
  ],
};

export function devChainGraph(): ValidatedGraph {
  const validated = validateGraphSnapshot(DEV_CHAIN_SNAPSHOT);
  if (!validated.ok) {
    throw new Error("readiness chain fixture graph must validate");
  }
  return validated.graph;
}

export function devChainInput(): Record<string, unknown> {
  return {
    hardEdgeFacts: [
      { edgeKey: "dev-edge-produce", state: "UNSATISFIED" },
      { edgeKey: "dev-edge-consume", state: "UNSATISFIED" },
      { edgeKey: "dev-edge-free", state: "SATISFIED" },
    ],
    nodeFacts: [DEV_PRODUCER, DEV_CONSUMER, DEV_FREE, DEV_DONE].map((key) => devBundle(key)),
  };
}
