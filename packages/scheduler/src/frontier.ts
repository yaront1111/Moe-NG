import { admitFrontierCursor } from "./frontier-cursor.js";
import { deepFreeze, makeIssue, sortIssues, sortedCopy } from "./graph-internal.js";
import { isGraphKey } from "./graph-key.js";
import {
  hasValidatedGraphProvenance,
  registerFrontierPartition,
} from "./graph-provenance.js";
import {
  hasOnlyOwnStringKeys,
  isPlainRecord,
  readOwnArrayElement,
  readOwnDataProperty,
} from "./runtime-shape.js";
import type {
  BlockedNode,
  BlockedReason,
  FrontierPartition,
  FrontierResult,
  GraphIssue,
  TraversalCounter,
  ValidatedGraph,
} from "./graph-model.js";

const NODE_FACT_KEYS = Object.freeze([
  "admissionEligible",
  "dispatchAvailable",
  "nodeKey",
] as const);

/**
 * Partition the graph's nodes into the three distinct readiness concepts plus
 * the hard-dependency-blocked set, from caller-supplied frontier facts. Fails
 * closed with stable reason codes if the cursor is malformed, missing a fact
 * for any HARD edge or node, references an unknown/advisory edge or unknown
 * node, or supplies a duplicate fact.
 *
 * Availability booleans must be confirmed caller facts. A caller with UNKNOWN
 * admission or dispatch availability must withhold the frontier instead of
 * encoding UNKNOWN as `false`; the analysis API then reports null widths.
 * External adapters must reject bodies over 1 MiB before parsing, then enforce
 * the design's depth/string caps during decode or before invocation.
 *
 * Readiness rules (never collapsed into one "ready" boolean):
 *  - logicalReady: every incoming HARD dependency SATISFIED; UNKNOWN never counts.
 *  - admissionReady ⊆ logicalReady (caller admission eligibility).
 *  - dispatchable   ⊆ admissionReady (caller dispatch/resource availability).
 *  - ADVISORY edges never block readiness.
 *
 * The hostile cursor read lives in `frontier-cursor.ts`; this file keeps what
 * counts as ready, plus the single place a FrontierResult is sorted, frozen and
 * registered.
 */
export function partitionFrontier(
  graph: ValidatedGraph,
  cursor: unknown,
  counter?: TraversalCounter,
): FrontierResult {
  // Provenance FIRST: a graph this runtime did not validate has no facts worth
  // parsing a cursor against at all.
  if (!hasValidatedGraphProvenance(graph)) {
    return fail([
      makeIssue(
        "GRAPH_VALIDATION_PROVENANCE_INVALID",
        "graph was not produced by this runtime's validateGraphSnapshot",
        [],
        [],
      ),
    ]);
  }

  const admitted = admitFrontierCursor(graph, cursor);
  if (!admitted.ok) {
    return fail(admitted.issues);
  }
  // HARD-edge issues seed the list so node issues append AFTER them, preserving
  // the pre-split accumulation order the canonical sort is applied to.
  const issues: GraphIssue[] = [...admitted.issues];
  const { edgeState, nodeAvailabilityFacts, nodeAvailabilityFactCount } = admitted;

  // --- Node availability facts ---
  const nodeKeys = new Set<string>(graph.nodes.map((node) => node.nodeKey));
  const admissionEligible = new Map<string, boolean>();
  const dispatchAvailable = new Map<string, boolean>();
  const seenNodeFacts = new Set<string>();
  for (let i = 0; i < nodeAvailabilityFactCount; i += 1) {
    const factProperty = readOwnArrayElement(nodeAvailabilityFacts, i);
    const fact = factProperty.ok && factProperty.present
      ? factProperty.value
      : undefined;
    const factShape = isPlainRecord(fact) && hasOnlyOwnStringKeys(fact, NODE_FACT_KEYS);
    const nodeKeyProperty = factShape
      ? readOwnDataProperty(fact, "nodeKey")
      : { ok: false as const };
    const admissionProperty = factShape
      ? readOwnDataProperty(fact, "admissionEligible")
      : { ok: false as const };
    const dispatchProperty = factShape
      ? readOwnDataProperty(fact, "dispatchAvailable")
      : { ok: false as const };
    const nodeKey = nodeKeyProperty.ok && nodeKeyProperty.present
      ? nodeKeyProperty.value
      : undefined;
    const admission = admissionProperty.ok && admissionProperty.present
      ? admissionProperty.value
      : undefined;
    const dispatch = dispatchProperty.ok && dispatchProperty.present
      ? dispatchProperty.value
      : undefined;
    if (
      !factShape ||
      !isGraphKey(nodeKey) ||
      typeof admission !== "boolean" ||
      typeof dispatch !== "boolean"
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
    admissionEligible.set(nodeKey, admission);
    dispatchAvailable.set(nodeKey, dispatch);
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

  const partition = deepFreeze({
    graphIdentity: graph.graphIdentity,
    logicalReady: sortedCopy(logicalReady),
    admissionReady: sortedCopy(admissionReady),
    dispatchable: sortedCopy(dispatchable),
    blocked: [...blocked].sort((a, b) =>
      a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0,
    ),
  }) as unknown as FrontierPartition;
  registerFrontierPartition(graph, partition);
  return deepFreeze({ ok: true, partition });
}

function fail(issues: readonly GraphIssue[]): FrontierResult {
  return deepFreeze({ ok: false, issues: sortIssues(issues) });
}
