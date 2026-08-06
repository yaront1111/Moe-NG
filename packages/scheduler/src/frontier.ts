import {
  deepFreeze,
  makeIssue,
  sortIssues,
  sortedCopy,
} from "./graph-internal.js";
import type {
  BlockedNode,
  BlockedReason,
  FrontierCursor,
  FrontierPartition,
  FrontierResult,
  GraphIssue,
  HardEdgeSatisfaction,
  TraversalCounter,
  ValidatedGraph,
} from "./graph-model.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSatisfaction(value: unknown): value is HardEdgeSatisfaction {
  return value === "SATISFIED" || value === "UNSATISFIED" || value === "UNKNOWN";
}

/**
 * Partition the graph's nodes into the three distinct readiness concepts plus
 * the hard-dependency-blocked set, from caller-supplied frontier facts. Fails
 * closed with stable reason codes if the cursor is malformed, missing a fact
 * for any HARD edge or node, references an unknown/advisory edge or unknown
 * node, or supplies a duplicate fact.
 *
 * Readiness rules (never collapsed into one "ready" boolean):
 *  - logicalReady: every incoming HARD dependency SATISFIED; UNKNOWN never counts.
 *  - admissionReady ⊆ logicalReady (caller admission eligibility).
 *  - dispatchable   ⊆ admissionReady (caller dispatch/resource availability).
 *  - ADVISORY edges never block readiness.
 */
export function partitionFrontier(
  graph: ValidatedGraph,
  cursor: FrontierCursor,
  counter?: TraversalCounter,
): FrontierResult {
  const rawCursor = cursor as unknown;
  if (
    !isRecord(rawCursor) ||
    !Array.isArray(rawCursor["hardEdgeFacts"]) ||
    !Array.isArray(rawCursor["nodeAvailabilityFacts"])
  ) {
    return fail([
      makeIssue(
        "FRONTIER_MALFORMED_CURSOR",
        "cursor.hardEdgeFacts and cursor.nodeAvailabilityFacts must both be arrays",
        [],
        [],
      ),
    ]);
  }

  const issues: GraphIssue[] = [];

  const hardEdgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind === "HARD") {
      hardEdgeKeys.add(edge.edgeKey);
    }
  }

  // --- HARD edge facts ---
  const edgeState = new Map<string, HardEdgeSatisfaction>();
  const seenEdgeFacts = new Set<string>();
  for (let i = 0; i < cursor.hardEdgeFacts.length; i += 1) {
    const fact = cursor.hardEdgeFacts[i] as unknown;
    if (!isRecord(fact) || !isNonEmptyString(fact["edgeKey"]) || !isSatisfaction(fact["state"])) {
      issues.push(
        makeIssue(
          "FRONTIER_MALFORMED_CURSOR",
          `hardEdgeFacts[${i}] is malformed or has an invalid state`,
          [],
          [],
        ),
      );
      continue;
    }
    const edgeKey = fact["edgeKey"];
    if (!hardEdgeKeys.has(edgeKey)) {
      issues.push(
        makeIssue(
          "FRONTIER_EDGE_FACT_UNKNOWN_EDGE",
          `hardEdgeFacts references "${edgeKey}", which is not a HARD edge`,
          [],
          [edgeKey],
        ),
      );
      continue;
    }
    if (seenEdgeFacts.has(edgeKey)) {
      issues.push(
        makeIssue(
          "FRONTIER_EDGE_FACT_DUPLICATE",
          `duplicate satisfaction fact for HARD edge "${edgeKey}"`,
          [],
          [edgeKey],
        ),
      );
      continue;
    }
    seenEdgeFacts.add(edgeKey);
    edgeState.set(edgeKey, fact["state"]);
  }
  for (const edgeKey of sortedCopy(hardEdgeKeys)) {
    if (!seenEdgeFacts.has(edgeKey)) {
      issues.push(
        makeIssue(
          "FRONTIER_EDGE_FACT_MISSING",
          `no satisfaction fact supplied for HARD edge "${edgeKey}"`,
          [],
          [edgeKey],
        ),
      );
    }
  }

  // --- Node availability facts ---
  const nodeKeys = new Set<string>(graph.nodes.map((node) => node.nodeKey));
  const admissionEligible = new Map<string, boolean>();
  const dispatchAvailable = new Map<string, boolean>();
  const seenNodeFacts = new Set<string>();
  for (let i = 0; i < cursor.nodeAvailabilityFacts.length; i += 1) {
    const fact = cursor.nodeAvailabilityFacts[i] as unknown;
    if (
      !isRecord(fact) ||
      !isNonEmptyString(fact["nodeKey"]) ||
      typeof fact["admissionEligible"] !== "boolean" ||
      typeof fact["dispatchAvailable"] !== "boolean"
    ) {
      issues.push(
        makeIssue(
          "FRONTIER_MALFORMED_CURSOR",
          `nodeAvailabilityFacts[${i}] is malformed or missing boolean flags`,
          [],
          [],
        ),
      );
      continue;
    }
    const nodeKey = fact["nodeKey"];
    if (!nodeKeys.has(nodeKey)) {
      issues.push(
        makeIssue(
          "FRONTIER_NODE_FACT_UNKNOWN_NODE",
          `nodeAvailabilityFacts references unknown node "${nodeKey}"`,
          [nodeKey],
          [],
        ),
      );
      continue;
    }
    if (seenNodeFacts.has(nodeKey)) {
      issues.push(
        makeIssue(
          "FRONTIER_NODE_FACT_DUPLICATE",
          `duplicate availability fact for node "${nodeKey}"`,
          [nodeKey],
          [],
        ),
      );
      continue;
    }
    seenNodeFacts.add(nodeKey);
    admissionEligible.set(nodeKey, fact["admissionEligible"]);
    dispatchAvailable.set(nodeKey, fact["dispatchAvailable"]);
  }
  for (const nodeKey of sortedCopy(nodeKeys)) {
    if (!seenNodeFacts.has(nodeKey)) {
      issues.push(
        makeIssue(
          "FRONTIER_NODE_FACT_MISSING",
          `no availability fact supplied for node "${nodeKey}"`,
          [nodeKey],
          [],
        ),
      );
    }
  }

  if (issues.length > 0) {
    return fail(issues);
  }

  // --- Partition (facts are complete and well-formed) ---
  const incomingHard = new Map<string, { edgeKey: string; producerNodeKey: string }[]>();
  for (const node of graph.nodes) {
    incomingHard.set(node.nodeKey, []);
  }
  for (const edge of graph.edges) {
    if (edge.kind !== "HARD") {
      continue;
    }
    incomingHard.get(edge.consumerNodeKey)!.push({
      edgeKey: edge.edgeKey,
      producerNodeKey: edge.producerNodeKey,
    });
    if (counter !== undefined) {
      counter.edgeVisits += 1;
    }
  }

  const logicalReady: string[] = [];
  const admissionReady: string[] = [];
  const dispatchable: string[] = [];
  const blocked: BlockedNode[] = [];
  for (const node of graph.nodes) {
    if (counter !== undefined) {
      counter.nodeVisits += 1;
    }
    // Non-execution-bearing (advisory/organizational) nodes have NO execution
    // authority: they never enter logicalReady/admissionReady/dispatchable, and
    // never appear as a blocked *executable*. They remain visible only as
    // structural graph facts (analyzeGraphStructure's node/root/leaf lists).
    if (!node.executionBearing) {
      continue;
    }
    const reasons: BlockedReason[] = [];
    for (const dep of incomingHard.get(node.nodeKey)!) {
      const state = edgeState.get(dep.edgeKey)!;
      if (state === "UNSATISFIED") {
        reasons.push({
          code: "HARD_DEPENDENCY_UNSATISFIED",
          edgeKey: dep.edgeKey,
          producerNodeKey: dep.producerNodeKey,
        });
      } else if (state === "UNKNOWN") {
        reasons.push({
          code: "HARD_DEPENDENCY_UNKNOWN",
          edgeKey: dep.edgeKey,
          producerNodeKey: dep.producerNodeKey,
        });
      }
    }
    if (reasons.length > 0) {
      reasons.sort((a, b) =>
        a.edgeKey < b.edgeKey ? -1 : a.edgeKey > b.edgeKey ? 1 : 0,
      );
      blocked.push({ nodeKey: node.nodeKey, reasons });
      continue;
    }
    logicalReady.push(node.nodeKey);
    if (admissionEligible.get(node.nodeKey) === true) {
      admissionReady.push(node.nodeKey);
      if (dispatchAvailable.get(node.nodeKey) === true) {
        dispatchable.push(node.nodeKey);
      }
    }
  }

  const partition: FrontierPartition = {
    graphIdentity: graph.graphIdentity,
    logicalReady: sortedCopy(logicalReady),
    admissionReady: sortedCopy(admissionReady),
    dispatchable: sortedCopy(dispatchable),
    blocked: [...blocked].sort((a, b) =>
      a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0,
    ),
  };
  return deepFreeze({ ok: true, partition });
}

function fail(issues: readonly GraphIssue[]): FrontierResult {
  return deepFreeze({ ok: false, issues: sortIssues(issues) });
}
