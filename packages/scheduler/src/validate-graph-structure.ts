import {
  buildHardGraphIndex,
  findCycleCore,
  makeIssue,
  sortedCopy,
  topologicalOrder,
  type GraphStructureView,
  type HardGraphIndex,
} from "./graph-internal.js";
import type {
  GraphIssue,
  GraphPolicy,
  TraversalCounter,
} from "./graph-model.js";
import type { ParsedGraphInput } from "./validate-graph-input.js";

/**
 * Graph-wide structural validation over already-parsed bounded state.
 *
 * Package-internal by design: it is deliberately absent from the package root
 * export. It owns the cross-record rules (endpoint resolution, completion
 * presence/terminality, normalized policy limits) and the topology rules (HARD
 * cycle, completion closure). It reads no caller-controlled object, freezes
 * nothing, and is pure apart from the optional traversal counter it is handed.
 */
export type GraphStructureValidation =
  | { readonly ok: false; readonly issues: readonly GraphIssue[] }
  | { readonly ok: true; readonly view: GraphStructureView };

/** Missing endpoints only make sense once node shape is trustworthy. */
function missingEndpointIssues(parsed: ParsedGraphInput): GraphIssue[] {
  const issues: GraphIssue[] = [];
  if (!parsed.nodeShapeOk) {
    return issues;
  }
  for (const edge of parsed.edges) {
    const missing: string[] = [];
    if (!parsed.nodeKeys.has(edge.producerNodeKey)) {
      missing.push(edge.producerNodeKey);
    }
    if (!parsed.nodeKeys.has(edge.consumerNodeKey)) {
      missing.push(edge.consumerNodeKey);
    }
    if (missing.length > 0) {
      issues.push(
        makeIssue(
          "GRAPH_MISSING_ENDPOINT",
          `edge "${edge.edgeKey}" references unknown node(s)`,
          sortedCopy(new Set(missing)),
          [edge.edgeKey],
        ),
      );
    }
  }
  return issues;
}

/** Completion node presence + terminality, under the same node-shape guard. */
function completionIssues(parsed: ParsedGraphInput): GraphIssue[] {
  const completion = parsed.completionNodeKey;
  if (parsed.nodeShapeOk && !parsed.nodeKeys.has(completion)) {
    return [
      makeIssue(
        "GRAPH_COMPLETION_NODE_MISSING",
        `completionNodeKey "${completion}" is not a declared node`,
        [completion],
        [],
      ),
    ];
  }
  if (!parsed.nodeShapeOk) {
    return [];
  }
  // The completion node must be a terminal HARD sink: no outgoing HARD edge
  // may leave it. Advisory outgoing relations are organizational and allowed.
  const outgoingHard = parsed.edges
    .filter((edge) => edge.kind === "HARD" && edge.producerNodeKey === completion)
    .map((edge) => edge.edgeKey);
  if (outgoingHard.length === 0) {
    return [];
  }
  return [
    makeIssue(
      "GRAPH_COMPLETION_NOT_TERMINAL",
      `completion node "${completion}" has outgoing HARD edge(s); it must be a terminal HARD sink`,
      [completion],
      sortedCopy(outgoingHard),
    ),
  ];
}

/** Limits (explicit policy) over the normalized, not the raw, collections. */
function policyLimitIssues(
  parsed: ParsedGraphInput,
  policy: GraphPolicy,
): GraphIssue[] {
  const issues: GraphIssue[] = [];
  if (parsed.nodes.length > policy.maxNodes) {
    issues.push(
      makeIssue(
        "GRAPH_NODE_LIMIT_EXCEEDED",
        `graph has ${parsed.nodes.length} nodes; policy limit is ${policy.maxNodes}`,
        [],
        [],
      ),
    );
  }
  if (parsed.hardEdgeCount > policy.maxHardEdges) {
    issues.push(
      makeIssue(
        "GRAPH_HARD_EDGE_LIMIT_EXCEEDED",
        `graph has ${parsed.hardEdgeCount} hard edges; policy limit is ${policy.maxHardEdges}`,
        [],
        [],
      ),
    );
  }
  if (parsed.edges.length > policy.maxTotalEdges) {
    issues.push(
      makeIssue(
        "GRAPH_TOTAL_EDGE_LIMIT_EXCEEDED",
        `graph has ${parsed.edges.length} total edges (HARD + ADVISORY); policy limit is ${policy.maxTotalEdges}`,
        [],
        [],
      ),
    );
  }
  return issues;
}

/** Integrity holds; sort deterministically so downstream work is reproducible. */
function sortedStructureView(parsed: ParsedGraphInput): GraphStructureView {
  return {
    nodes: [...parsed.nodes].sort((a, b) =>
      a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0,
    ),
    edges: [...parsed.edges].sort((a, b) =>
      a.edgeKey < b.edgeKey ? -1 : a.edgeKey > b.edgeKey ? 1 : 0,
    ),
    completionNodeKey: parsed.completionNodeKey,
  };
}

/**
 * Completion closure: execution-bearing nodes that are neither the completion
 * node nor a transitive HARD predecessor of it (reverse BFS over HARD in-arcs).
 */
function closureOrphans(
  index: HardGraphIndex,
  counter?: TraversalCounter,
): string[] {
  const reachesCompletion = new Uint8Array(index.nodeKeys.length);
  const queue: number[] = [index.completionIndex];
  reachesCompletion[index.completionIndex] = 1;
  let head = 0;
  while (head < queue.length) {
    const node = queue[head]!;
    head += 1;
    if (counter !== undefined) {
      counter.nodeVisits += 1;
    }
    for (const arc of index.hardIn[node]!) {
      if (reachesCompletion[arc.nodeIndex] === 0) {
        reachesCompletion[arc.nodeIndex] = 1;
        queue.push(arc.nodeIndex);
      }
      if (counter !== undefined) {
        counter.edgeVisits += 1;
      }
    }
  }
  const orphans: string[] = [];
  for (let i = 0; i < index.nodeKeys.length; i += 1) {
    if (index.executionBearing[i] && reachesCompletion[i] === 0) {
      orphans.push(index.nodeKeys[i]!);
    }
  }
  return orphans;
}

/**
 * Validate the graph as a whole. Every integrity issue (record-local plus
 * cross-record) is reported together and BEFORE any topology is constructed,
 * because cycle and closure presuppose resolvable endpoints. Topology failures
 * are reported one at a time, in evaluation order.
 */
export function validateGraphStructure(
  parsed: ParsedGraphInput,
  policy: GraphPolicy,
  counter?: TraversalCounter,
): GraphStructureValidation {
  const issues: GraphIssue[] = [
    ...parsed.issues,
    ...missingEndpointIssues(parsed),
    ...completionIssues(parsed),
    ...policyLimitIssues(parsed, policy),
  ];
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const view = sortedStructureView(parsed);
  const index = buildHardGraphIndex(view, counter);

  // --- Cycle (HARD edges only) ---
  const topo = topologicalOrder(index, counter);
  if (!topo.acyclic) {
    // Report only the actual cycle members and their edges, not every node Kahn
    // failed to order (which would wrongly include acyclic downstream nodes).
    const core = findCycleCore(index);
    return {
      ok: false,
      issues: [
        makeIssue(
          "GRAPH_CYCLE",
          "the HARD-edge subgraph contains a cycle",
          sortedCopy(core.nodeIndices.map((i) => index.nodeKeys[i]!)),
          [...core.edgeKeys],
        ),
      ],
    };
  }

  // --- Completion closure (HARD ancestors of completion, reverse BFS) ---
  const orphans = closureOrphans(index, counter);
  if (orphans.length > 0) {
    return {
      ok: false,
      issues: [
        makeIssue(
          "COMPLETION_CLOSURE_INCOMPLETE",
          "execution-bearing node(s) are neither the completion node nor a transitive HARD predecessor of it (advisory edges cannot satisfy closure)",
          sortedCopy(orphans),
          [],
        ),
      ],
    };
  }

  return { ok: true, view };
}
