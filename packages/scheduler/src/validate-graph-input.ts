import { makeIssue, sortedCopy } from "./graph-internal.js";
import { isGraphKey } from "./graph-key.js";
import { MAX_GRAPH_KEY_CODE_UNITS } from "./graph-policy.js";
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
  GraphPolicy,
} from "./graph-model.js";

/**
 * Bounded, hostile-safe parsing and normalization of a caller graph snapshot.
 *
 * Package-internal by design: it is deliberately absent from the package root
 * export. It performs only record-local work — snapshot schema and own-data-
 * property checks, raw slot ceilings, dense-array shape, per-record
 * normalization, duplicate detection, and self-edge detection. It never
 * inspects graph-wide topology, never freezes a result, and never mutates the
 * caller's snapshot.
 */

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

/** Bounded normalized snapshot state plus the diagnostics found so far. */
export interface ParsedGraphInput {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly completionNodeKey: string;
  readonly nodeKeys: ReadonlySet<string>;
  readonly hardEdgeCount: number;
  /** False once any node record is untrustworthy; dependent facts stay unclaimed. */
  readonly nodeShapeOk: boolean;
  /** Record-local diagnostics in accumulation order; NOT yet sorted or frozen. */
  readonly issues: readonly GraphIssue[];
}

export type GraphInputParse =
  | { readonly ok: false; readonly issues: readonly GraphIssue[] }
  | { readonly ok: true; readonly parsed: ParsedGraphInput };

function malformedSnapshot(message: string): GraphInputParse {
  return {
    ok: false,
    issues: [makeIssue("GRAPH_MALFORMED_SNAPSHOT", message, [], [])],
  };
}

interface NodeParse {
  readonly nodes: GraphNode[];
  readonly nodeKeys: Set<string>;
  readonly shapeOk: boolean;
  readonly issues: GraphIssue[];
}

/** Nodes: shape, NaN/sparse rejection, duplicates. No cross-record inference. */
function parseNodes(rawNodes: unknown[], rawNodeCount: number): NodeParse {
  const issues: GraphIssue[] = [];
  const nodeKeys = new Set<string>();
  const duplicateNodeKeys = new Set<string>();
  const nodes: GraphNode[] = [];
  let shapeOk = true;
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
      shapeOk = false;
      continue;
    }
    if (nodeKeys.has(nodeKey)) {
      duplicateNodeKeys.add(nodeKey);
    } else {
      nodeKeys.add(nodeKey);
    }
    nodes.push({
      nodeKey,
      executionBearing,
    });
  }
  for (const key of sortedCopy(duplicateNodeKeys)) {
    issues.push(
      makeIssue("GRAPH_DUPLICATE_NODE", `duplicate nodeKey "${key}"`, [key], []),
    );
  }
  return { nodes, nodeKeys, shapeOk, issues };
}

interface EdgeParse {
  readonly edges: GraphEdge[];
  readonly hardEdgeCount: number;
  readonly issues: GraphIssue[];
}

/** Edges: shape, duplicates, self-edge. Endpoint resolution is graph-wide. */
function parseEdges(rawEdges: unknown[], rawEdgeCount: number): EdgeParse {
  const issues: GraphIssue[] = [];
  const edgeKeySet = new Set<string>();
  const duplicateEdgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];
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
    edges.push({ edgeKey, producerNodeKey, consumerNodeKey, kind });
  }
  for (const key of sortedCopy(duplicateEdgeKeys)) {
    issues.push(
      makeIssue("GRAPH_DUPLICATE_EDGE", `duplicate edgeKey "${key}"`, [], [key]),
    );
  }
  return { edges, hardEdgeCount, issues };
}

/**
 * Read the caller snapshot exactly once, in a hostile-safe order: schema and
 * own-data-property checks first, then raw slot counts against the policy
 * ceilings BEFORE any indexed read, so sparse or accessor-backed over-limit
 * arrays fail in constant time instead of turning the policy check itself into
 * an attacker-controlled traversal. `ok: false` means the snapshot is refused
 * outright; `ok: true` still carries accumulated record-local diagnostics.
 */
export function parseGraphInput(
  snapshot: unknown,
  policy: GraphPolicy,
): GraphInputParse {
  const raw = snapshot as unknown;
  if (!isPlainRecord(raw) || !hasOnlyOwnStringKeys(raw, SNAPSHOT_KEYS)) {
    return malformedSnapshot(
      "snapshot schema is malformed or contains unsupported fields",
    );
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
    return malformedSnapshot(
      "snapshot requires own data properties for nodes, edges, and completionNodeKey",
    );
  }
  const rawNodes = nodesProperty.value;
  const rawEdges = edgesProperty.value;
  const rawCompletion = completionProperty.value;
  if (!isPlainArray(rawNodes) || !isPlainArray(rawEdges)) {
    return malformedSnapshot("snapshot.nodes and snapshot.edges must both be arrays");
  }
  if (!isGraphKey(rawCompletion)) {
    return malformedSnapshot(
      `snapshot.completionNodeKey must be a 1..${MAX_GRAPH_KEY_CODE_UNITS}-code-unit ASCII machine identifier matching [A-Za-z0-9_][A-Za-z0-9._:@/+~-]*`,
    );
  }

  // Length checks happen before any indexed read. This makes sparse or accessor-
  // backed over-limit arrays fail in constant time instead of turning the policy
  // check itself into an attacker-controlled traversal.
  const rawNodeCount = readPlainArrayLength(rawNodes);
  const rawEdgeCount = readPlainArrayLength(rawEdges);
  if (rawNodeCount === null || rawEdgeCount === null) {
    return malformedSnapshot("snapshot collection lengths could not be read safely");
  }
  const issues: GraphIssue[] = [];
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
    return { ok: false, issues };
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

  const nodeParse = parseNodes(rawNodes, rawNodeCount);
  issues.push(...nodeParse.issues);
  const edgeParse = parseEdges(rawEdges, rawEdgeCount);
  issues.push(...edgeParse.issues);

  return {
    ok: true,
    parsed: {
      nodes: nodeParse.nodes,
      edges: edgeParse.edges,
      completionNodeKey: rawCompletion,
      nodeKeys: nodeParse.nodeKeys,
      hardEdgeCount: edgeParse.hardEdgeCount,
      nodeShapeOk: nodeParse.shapeOk,
      issues,
    },
  };
}
