/**
 * The three-layer readiness projection of design 8.2, composed on top of the
 * landed `partitionFrontier`. This module is the caller that partitioner is
 * documented to wait for: it derives the two availability booleans from
 * classified caller facts (see ./readiness-cursor.ts) and never reimplements
 * hard-edge satisfaction.
 *
 * The layers never collapse. `logical` comes from the partition's own
 * logicalReady/blocked output and depends on hard-edge facts alone; `admission`
 * and `dispatch` are each weakened by the layer above, so
 * dispatch ⊆ admission ⊆ logical holds by construction rather than by
 * convention. This module decides readiness; ./readiness-explanation.ts only
 * explains what was decided, so there is exactly one source of truth.
 */
import { deepFreeze } from "../admission/admission-model.js";
import { partitionFrontier } from "../frontier.js";
import { hasValidatedGraphProvenance } from "../graph-provenance.js";
import type {
  BlockedNode,
  BlockedReason,
  FrontierPartition,
  GraphKey,
  ValidatedGraph,
} from "../graph-model.js";
import type { ReadinessPredicateFact, NodeReadinessFacts } from "./readiness-facts.js";
import {
  buildReadinessCursor,
  makeReadinessIssue,
  refuseReadiness,
} from "./readiness-cursor.js";
import {
  READINESS_LAYERS,
  type FactConfidence,
  type ReadinessIssue,
  type ReadinessReason,
  type ReadinessWithholdReason,
} from "./readiness-model.js";

export interface NodeReadinessProjection {
  readonly nodeKey: GraphKey;
  readonly executionBearing: boolean;
  readonly logical: FactConfidence;
  readonly admission: FactConfidence;
  readonly dispatch: FactConfidence;
  /** Every outstanding or refusing predicate, with provenance. */
  readonly reasons: readonly ReadinessReason[];
  readonly waitCurrent: boolean;
}

export interface ReadinessProjection {
  readonly graphIdentity: string;
  /** Structural and always exact: a function of hard-edge facts alone. */
  readonly logicalReady: readonly GraphKey[];
  readonly blocked: readonly BlockedNode[];
  /** CONFIRMED members only. A lower bound while `withheld` is set. */
  readonly admissionReady: readonly GraphKey[];
  readonly dispatchable: readonly GraphKey[];
  /** `null` when withheld, so analysis widths stay UNKNOWN. */
  readonly partition: FrontierPartition | null;
  readonly withheld: ReadinessWithholdReason | null;
  readonly nodes: readonly NodeReadinessProjection[];
}

export type ReadinessProjectionResult =
  | { readonly ok: true; readonly projection: ReadinessProjection }
  | { readonly ok: false; readonly issues: readonly ReadinessIssue[] };

/** No layer may be stronger than the one that contains it. */
function weaken(inner: FactConfidence, outer: FactConfidence): FactConfidence {
  if (inner === "CONFIRMED_FALSE" || outer === "CONFIRMED_FALSE") {
    return "CONFIRMED_FALSE";
  }
  return inner === "UNKNOWN" || outer === "UNKNOWN" ? "UNKNOWN" : "CONFIRMED_TRUE";
}

function logicalConfidence(
  executionBearing: boolean,
  logicalReady: ReadonlySet<string>,
  blocked: BlockedNode | undefined,
  nodeKey: string,
): FactConfidence {
  if (!executionBearing) {
    return "CONFIRMED_FALSE";
  }
  if (logicalReady.has(nodeKey)) {
    return "CONFIRMED_TRUE";
  }
  return blocked?.reasons.some((reason) => reason.code === "HARD_DEPENDENCY_UNKNOWN") === true
    ? "UNKNOWN"
    : "CONFIRMED_FALSE";
}

function blockedReason(nodeKey: GraphKey, reason: BlockedReason): ReadinessReason {
  return {
    code: reason.code,
    layer: "LOGICAL",
    confidence: reason.code === "HARD_DEPENDENCY_UNKNOWN" ? "UNKNOWN" : "CONFIRMED_FALSE",
    nodeKey,
    edgeKey: reason.edgeKey,
    provenance: null,
    recoveryRef: reason.producerNodeKey,
  };
}

function predicateReason(
  nodeKey: GraphKey,
  predicate: ReadinessPredicateFact,
): ReadinessReason {
  return {
    code: predicate.code,
    layer: predicate.layer,
    confidence: predicate.confidence,
    nodeKey,
    edgeKey: null,
    provenance: predicate.provenance,
    recoveryRef: predicate.recoveryRef,
  };
}

function collectReasons(
  nodeKey: GraphKey,
  executionBearing: boolean,
  supplied: NodeReadinessFacts,
  blocked: BlockedNode | undefined,
): ReadinessReason[] {
  const reasons: ReadinessReason[] = [];
  if (!executionBearing) {
    reasons.push({
      code: "READINESS_NOT_EXECUTION_BEARING",
      layer: "LOGICAL",
      confidence: "CONFIRMED_FALSE",
      nodeKey,
      edgeKey: null,
      provenance: null,
      recoveryRef: null,
    });
  }
  for (const reason of blocked?.reasons ?? []) {
    reasons.push(blockedReason(nodeKey, reason));
  }
  for (const predicate of supplied.predicates) {
    if (predicate.confidence !== "CONFIRMED_TRUE") {
      reasons.push(predicateReason(nodeKey, predicate));
    }
  }
  return reasons.sort((a, b) => {
    const byLayer = READINESS_LAYERS.indexOf(a.layer) - READINESS_LAYERS.indexOf(b.layer);
    if (byLayer !== 0) {
      return byLayer;
    }
    const byCode = a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
    if (byCode !== 0) {
      return byCode;
    }
    // Code units, never localeCompare: collation depends on the host's ICU data,
    // so two machines would order the same reasons differently — and that failure
    // never reproduces locally. Same form as the code tie-break directly above.
    return 0;
  });
}

/**
 * Project one validated graph plus caller-supplied frontier and node facts into
 * the three readiness layers. Fails closed: a malformed input, an incomplete
 * bundle set, or a frontier refusal returns issues under stable codes, with
 * `FRONTIER_*` and `GRAPH_*` codes passed through unchanged.
 */
export function projectReadiness(
  graph: ValidatedGraph,
  input: unknown,
): ReadinessProjectionResult {
  // Before ANY graph property is read: a hand-built object cast past
  // validateGraphSnapshot must be refused here, not read for its node list.
  // The landed code is passed through, never re-coded as a readiness synonym.
  if (!hasValidatedGraphProvenance(graph)) {
    return refuseReadiness([
      makeReadinessIssue(
        "GRAPH_VALIDATION_PROVENANCE_INVALID",
        "graph was not produced by this runtime's validateGraphSnapshot",
      ),
    ]);
  }
  const built = buildReadinessCursor(graph, input);
  if (!built.ok) {
    return built;
  }
  const partitioned = partitionFrontier(graph, built.cursor);
  if (!partitioned.ok) {
    return refuseReadiness(
      partitioned.issues.map((issue) =>
        makeReadinessIssue(issue.code, issue.message, issue.nodeKeys)),
    );
  }

  const { logicalReady, blocked } = partitioned.partition;
  const readySet = new Set<string>(logicalReady);
  const blockedByNode = new Map(blocked.map((entry) => [entry.nodeKey, entry]));
  const nodes: NodeReadinessProjection[] = [];
  const admissionReady: GraphKey[] = [];
  const dispatchable: GraphKey[] = [];
  for (const node of graph.nodes) {
    const supplied = built.facts.get(node.nodeKey)!;
    const logical = logicalConfidence(
      node.executionBearing,
      readySet,
      blockedByNode.get(node.nodeKey),
      node.nodeKey,
    );
    const admission = weaken(supplied.admission, logical);
    const dispatch = weaken(supplied.dispatch, admission);
    if (admission === "CONFIRMED_TRUE") {
      admissionReady.push(node.nodeKey);
    }
    if (dispatch === "CONFIRMED_TRUE") {
      dispatchable.push(node.nodeKey);
    }
    nodes.push({
      nodeKey: node.nodeKey,
      executionBearing: node.executionBearing,
      logical,
      admission,
      dispatch,
      reasons: collectReasons(
        node.nodeKey,
        node.executionBearing,
        supplied,
        blockedByNode.get(node.nodeKey),
      ),
      waitCurrent: supplied.waitCurrent,
    });
  }

  return deepFreeze({
    ok: true,
    projection: {
      graphIdentity: partitioned.partition.graphIdentity,
      logicalReady: [...logicalReady],
      blocked: [...blocked],
      admissionReady: admissionReady.sort(),
      dispatchable: dispatchable.sort(),
      partition: built.withheld === null ? partitioned.partition : null,
      withheld: built.withheld,
      nodes: nodes.sort((a, b) => (a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0)),
    },
  });
}
