import {
  buildHardGraphIndex,
  computeGraphIdentity,
  deepFreeze,
  findCycleCore,
  makeIssue,
  sortIssues,
  sortedCopy,
  topologicalOrder,
  type GraphStructureView,
} from "./graph-internal.js";
import { isGraphKey } from "./graph-key.js";
import {
  MAX_GRAPH_KEY_CODE_UNITS,
  resolveGraphPolicy,
} from "./graph-policy.js";
import { registerValidatedGraph } from "./graph-provenance.js";
import {
  hasExactDenseArrayShape,
  hasOnlyOwnStringKeys,
  isPlainArray,
  isPlainRecord,
  readOwnArrayElement,
  readOwnDataProperty,
  readPlainArrayLength,
} from "./runtime-shape.js";
import type {
  GraphEdge,
  GraphEdgeKind,
  GraphIssue,
  GraphNode,
  GraphValidationResult,
  TraversalCounter,
  ValidatedGraph,
} from "./graph-model.js";

const SNAPSHOT_KEYS = Object.freeze(["completionNodeKey", "edges", "nodes"] as const);
const NODE_KEYS = Object.freeze(["executionBearing", "nodeKey"] as const);
const EDGE_KEYS = Object.freeze([
  "consumerNodeKey",
  "edgeKey",
  "kind",
  "producerNodeKey",
] as const);

function isEdgeKind(value: unknown): value is GraphEdgeKind {
  return value === "HARD" || value === "ADVISORY";
}

/**
 * Fail-closed structural validation. Returns `{ ok: true, graph }` only when the
 * snapshot is well-formed AND acyclic (on HARD edges) AND completion-closed;
 * otherwise returns `{ ok: false, issues }` with stable reason codes and NO
 * partial analysis. Integrity issues (malformed/duplicate/self/missing/limit)
 * are collected together; cycle and completion-closure are only evaluated once
 * integrity holds, because they presuppose resolvable endpoints.
 *
 * Integration precondition: external adapters must reject command bodies over
 * 1 MiB before parsing, then enforce the design's JSON-depth and string-size
 * caps during decode or before calling this kernel. Exact schema checks
 * enumerate own keys; direct calls with attacker-constructed, byte-unbounded
 * objects are outside the bounded-input guarantee.
 */
export function validateGraphSnapshot(
  snapshot: unknown,
  policyOverride?: unknown,
  counter?: TraversalCounter,
): GraphValidationResult {
  const issues: GraphIssue[] = [];

  const policy = resolveGraphPolicy(policyOverride);
  if (policy === null) {
    return fail([
      makeIssue(
        "GRAPH_MALFORMED_POLICY",
        "policy override is malformed, has unsupported fields, or exceeds parser ceilings",
        [],
        [],
      ),
    ]);
  }

  const raw = snapshot as unknown;
  if (!isPlainRecord(raw) || !hasOnlyOwnStringKeys(raw, SNAPSHOT_KEYS)) {
    return fail([
      makeIssue(
        "GRAPH_MALFORMED_SNAPSHOT",
        "snapshot schema is malformed or contains unsupported fields",
        [],
        [],
      ),
    ]);
  }
  const nodesProperty = readOwnDataProperty(raw, "nodes");
  const edgesProperty = readOwnDataProperty(raw, "edges");
  const completionProperty = readOwnDataProperty(raw, "completionNodeKey");
  if (
    !nodesProperty.ok ||
    !nodesProperty.present ||
    !edgesProperty.ok ||
    !edgesProperty.present ||
    !completionProperty.ok ||
    !completionProperty.present
  ) {
    return fail([
      makeIssue(
        "GRAPH_MALFORMED_SNAPSHOT",
        "snapshot requires own data properties for nodes, edges, and completionNodeKey",
        [],
        [],
      ),
    ]);
  }
  const rawNodes = nodesProperty.value;
  const rawEdges = edgesProperty.value;
  const rawCompletion = completionProperty.value;
  if (!isPlainArray(rawNodes) || !isPlainArray(rawEdges)) {
    return fail([
      makeIssue(
        "GRAPH_MALFORMED_SNAPSHOT",
        "snapshot.nodes and snapshot.edges must both be arrays",
        [],
        [],
      ),
    ]);
  }
  if (!isGraphKey(rawCompletion)) {
    return fail([
      makeIssue(
        "GRAPH_MALFORMED_SNAPSHOT",
        `snapshot.completionNodeKey must be a 1..${MAX_GRAPH_KEY_CODE_UNITS}-code-unit ASCII machine identifier matching [A-Za-z0-9_][A-Za-z0-9._:@/+~-]*`,
        [],
        [],
      ),
    ]);
  }

  // Length checks happen before any indexed read. This makes sparse or accessor-
  // backed over-limit arrays fail in constant time instead of turning the policy
  // check itself into an attacker-controlled traversal.
  const rawNodeCount = readPlainArrayLength(rawNodes);
  const rawEdgeCount = readPlainArrayLength(rawEdges);
  if (rawNodeCount === null || rawEdgeCount === null) {
    return fail([
      makeIssue(
        "GRAPH_MALFORMED_SNAPSHOT",
        "snapshot collection lengths could not be read safely",
        [],
        [],
      ),
    ]);
  }
  if (rawNodeCount > policy.maxNodes) {
    issues.push(
      makeIssue(
        "GRAPH_NODE_LIMIT_EXCEEDED",
        `graph declares ${rawNodeCount} node slots; policy limit is ${policy.maxNodes}`,
        [],
        [],
      ),
    );
  }
  if (rawEdgeCount > policy.maxTotalEdges) {
    issues.push(
      makeIssue(
        "GRAPH_TOTAL_EDGE_LIMIT_EXCEEDED",
        `graph declares ${rawEdgeCount} total edge slots; policy limit is ${policy.maxTotalEdges}`,
        [],
        [],
      ),
    );
  }
  if (issues.length > 0) {
    return fail(issues);
  }
  if (
    !hasExactDenseArrayShape(rawNodes, rawNodeCount) ||
    !hasExactDenseArrayShape(rawEdges, rawEdgeCount)
  ) {
    issues.push(
      makeIssue(
        "GRAPH_MALFORMED_SNAPSHOT",
        "snapshot collections must contain only dense own data elements",
        [],
        [],
      ),
    );
  }

  // --- Nodes: shape, NaN/sparse rejection, duplicates ---
  const nodeKeySet = new Set<string>();
  const duplicateNodeKeys = new Set<string>();
  const normalizedNodes: GraphNode[] = [];
  let nodeShapeOk = true;
  for (let i = 0; i < rawNodeCount; i += 1) {
    const candidateProperty = readOwnArrayElement(rawNodes, i);
    const candidate = candidateProperty.ok && candidateProperty.present
      ? candidateProperty.value
      : undefined;
    const nodeShape = isPlainRecord(candidate) && hasOnlyOwnStringKeys(candidate, NODE_KEYS);
    const nodeKeyProperty = nodeShape
      ? readOwnDataProperty(candidate, "nodeKey")
      : { ok: false as const };
    const executionProperty = nodeShape
      ? readOwnDataProperty(candidate, "executionBearing")
      : { ok: false as const };
    const nodeKey = nodeKeyProperty.ok && nodeKeyProperty.present
      ? nodeKeyProperty.value
      : undefined;
    const executionBearing = executionProperty.ok && executionProperty.present
      ? executionProperty.value
      : undefined;
    if (
      !nodeShape ||
      !isGraphKey(nodeKey) ||
      typeof executionBearing !== "boolean"
    ) {
      issues.push(
        makeIssue(
          "GRAPH_MALFORMED_NODE",
          `node at index ${i} is malformed, sparse, or missing required fields`,
          [],
          [],
        ),
      );
      nodeShapeOk = false;
      continue;
    }
    if (nodeKeySet.has(nodeKey)) {
      duplicateNodeKeys.add(nodeKey);
    } else {
      nodeKeySet.add(nodeKey);
    }
    normalizedNodes.push({
      nodeKey,
      executionBearing,
    });
  }
  for (const key of sortedCopy(duplicateNodeKeys)) {
    issues.push(
      makeIssue("GRAPH_DUPLICATE_NODE", `duplicate nodeKey "${key}"`, [key], []),
    );
  }

  // --- Edges: shape, duplicates, self-edge, missing endpoints ---
  const edgeKeySet = new Set<string>();
  const duplicateEdgeKeys = new Set<string>();
  const normalizedEdges: GraphEdge[] = [];
  let hardEdgeCount = 0;
  for (let i = 0; i < rawEdgeCount; i += 1) {
    const candidateProperty = readOwnArrayElement(rawEdges, i);
    const candidate = candidateProperty.ok && candidateProperty.present
      ? candidateProperty.value
      : undefined;
    const edgeShape = isPlainRecord(candidate) && hasOnlyOwnStringKeys(candidate, EDGE_KEYS);
    const edgeKeyProperty = edgeShape
      ? readOwnDataProperty(candidate, "edgeKey")
      : { ok: false as const };
    const producerProperty = edgeShape
      ? readOwnDataProperty(candidate, "producerNodeKey")
      : { ok: false as const };
    const consumerProperty = edgeShape
      ? readOwnDataProperty(candidate, "consumerNodeKey")
      : { ok: false as const };
    const kindProperty = edgeShape
      ? readOwnDataProperty(candidate, "kind")
      : { ok: false as const };
    const edgeKey = edgeKeyProperty.ok && edgeKeyProperty.present
      ? edgeKeyProperty.value
      : undefined;
    const producerNodeKey = producerProperty.ok && producerProperty.present
      ? producerProperty.value
      : undefined;
    const consumerNodeKey = consumerProperty.ok && consumerProperty.present
      ? consumerProperty.value
      : undefined;
    const kind = kindProperty.ok && kindProperty.present
      ? kindProperty.value
      : undefined;
    if (
      !edgeShape ||
      !isGraphKey(edgeKey) ||
      !isGraphKey(producerNodeKey) ||
      !isGraphKey(consumerNodeKey) ||
      !isEdgeKind(kind)
    ) {
      issues.push(
        makeIssue(
          "GRAPH_MALFORMED_EDGE",
          `edge at index ${i} is malformed, sparse, or missing required fields`,
          [],
          [],
        ),
      );
      continue;
    }
    if (edgeKeySet.has(edgeKey)) {
      duplicateEdgeKeys.add(edgeKey);
    } else {
      edgeKeySet.add(edgeKey);
    }
    if (producerNodeKey === consumerNodeKey) {
      issues.push(
        makeIssue(
          "GRAPH_SELF_EDGE",
          `edge "${edgeKey}" connects node "${producerNodeKey}" to itself`,
          [producerNodeKey],
          [edgeKey],
        ),
      );
    }
    if (kind === "HARD") {
      hardEdgeCount += 1;
    }
    normalizedEdges.push({ edgeKey, producerNodeKey, consumerNodeKey, kind });
  }
  for (const key of sortedCopy(duplicateEdgeKeys)) {
    issues.push(
      makeIssue("GRAPH_DUPLICATE_EDGE", `duplicate edgeKey "${key}"`, [], [key]),
    );
  }
  // Missing endpoints only make sense once node shape is trustworthy.
  if (nodeShapeOk) {
    for (const edge of normalizedEdges) {
      const missing: string[] = [];
      if (!nodeKeySet.has(edge.producerNodeKey)) {
        missing.push(edge.producerNodeKey);
      }
      if (!nodeKeySet.has(edge.consumerNodeKey)) {
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
  }

  // --- Completion node presence + terminality ---
  if (nodeShapeOk && !nodeKeySet.has(rawCompletion)) {
    issues.push(
      makeIssue(
        "GRAPH_COMPLETION_NODE_MISSING",
        `completionNodeKey "${rawCompletion}" is not a declared node`,
        [rawCompletion],
        [],
      ),
    );
  } else if (nodeShapeOk) {
    // The completion node must be a terminal HARD sink: no outgoing HARD edge
    // may leave it. Advisory outgoing relations are organizational and allowed.
    const outgoingHard = normalizedEdges
      .filter(
        (edge) => edge.kind === "HARD" && edge.producerNodeKey === rawCompletion,
      )
      .map((edge) => edge.edgeKey);
    if (outgoingHard.length > 0) {
      issues.push(
        makeIssue(
          "GRAPH_COMPLETION_NOT_TERMINAL",
          `completion node "${rawCompletion}" has outgoing HARD edge(s); it must be a terminal HARD sink`,
          [rawCompletion],
          sortedCopy(outgoingHard),
        ),
      );
    }
  }

  // --- Limits (explicit policy) ---
  if (normalizedNodes.length > policy.maxNodes) {
    issues.push(
      makeIssue(
        "GRAPH_NODE_LIMIT_EXCEEDED",
        `graph has ${normalizedNodes.length} nodes; policy limit is ${policy.maxNodes}`,
        [],
        [],
      ),
    );
  }
  if (hardEdgeCount > policy.maxHardEdges) {
    issues.push(
      makeIssue(
        "GRAPH_HARD_EDGE_LIMIT_EXCEEDED",
        `graph has ${hardEdgeCount} hard edges; policy limit is ${policy.maxHardEdges}`,
        [],
        [],
      ),
    );
  }
  if (normalizedEdges.length > policy.maxTotalEdges) {
    issues.push(
      makeIssue(
        "GRAPH_TOTAL_EDGE_LIMIT_EXCEEDED",
        `graph has ${normalizedEdges.length} total edges (HARD + ADVISORY); policy limit is ${policy.maxTotalEdges}`,
        [],
        [],
      ),
    );
  }

  if (issues.length > 0) {
    return fail(issues);
  }

  // Integrity holds; sort deterministically and build the HARD index once.
  const sortedNodes = [...normalizedNodes].sort((a, b) =>
    a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0,
  );
  const sortedEdges = [...normalizedEdges].sort((a, b) =>
    a.edgeKey < b.edgeKey ? -1 : a.edgeKey > b.edgeKey ? 1 : 0,
  );
  const view: GraphStructureView = {
    nodes: sortedNodes,
    edges: sortedEdges,
    completionNodeKey: rawCompletion,
  };
  const index = buildHardGraphIndex(view, counter);

  // --- Cycle (HARD edges only) ---
  const topo = topologicalOrder(index, counter);
  if (!topo.acyclic) {
    // Report only the actual cycle members and their edges, not every node Kahn
    // failed to order (which would wrongly include acyclic downstream nodes).
    const core = findCycleCore(index);
    return fail([
      makeIssue(
        "GRAPH_CYCLE",
        "the HARD-edge subgraph contains a cycle",
        sortedCopy(core.nodeIndices.map((i) => index.nodeKeys[i]!)),
        [...core.edgeKeys],
      ),
    ]);
  }

  // --- Completion closure (HARD ancestors of completion, reverse BFS) ---
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
  if (orphans.length > 0) {
    return fail([
      makeIssue(
        "COMPLETION_CLOSURE_INCOMPLETE",
        "execution-bearing node(s) are neither the completion node nor a transitive HARD predecessor of it (advisory edges cannot satisfy closure)",
        sortedCopy(orphans),
        [],
      ),
    ]);
  }

  const graph = deepFreeze({
    nodes: sortedNodes.map((node) => ({ ...node })),
    edges: sortedEdges.map((edge) => ({ ...edge })),
    completionNodeKey: rawCompletion,
    policy: { ...policy },
    graphIdentity: computeGraphIdentity(view),
  }) as unknown as ValidatedGraph;
  registerValidatedGraph(graph);
  return deepFreeze({ ok: true, graph });
}

function fail(issues: readonly GraphIssue[]): GraphValidationResult {
  return deepFreeze({ ok: false, issues: sortIssues(issues) });
}
