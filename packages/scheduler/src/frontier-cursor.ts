import { makeIssue, sortedCopy } from "./graph-internal.js";
import { isGraphKey } from "./graph-key.js";
import { ABSOLUTE_MAX_GRAPH_NODES, ABSOLUTE_MAX_GRAPH_TOTAL_EDGES } from "./graph-policy.js";
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
  GraphIssue,
  HardEdgeSatisfaction,
  ValidatedGraph,
} from "./graph-model.js";

/**
 * The hostile front half of `partitionFrontier`: everything between "a caller
 * handed us an arbitrary value" and "the HARD-edge facts are understood".
 *
 * Owns NO readiness rule and NO final outcome. It never sorts or freezes a
 * result, never registers provenance, and is not on the package root — so
 * refusal ordering and canonical shaping stay decided in `frontier.ts` alone.
 *
 * The order below is security-significant and preserved from the pre-split
 * source: exact cursor schema, safe length reads, absolute ceilings BEFORE any
 * indexed read, dense-shape validation, and only then per-element access. A
 * ceiling checked after an indexed read is not a ceiling.
 */
const CURSOR_KEYS = Object.freeze([
  "hardEdgeFacts",
  "nodeAvailabilityFacts",
] as const);
const HARD_EDGE_FACT_KEYS = Object.freeze(["edgeKey", "state"] as const);

function isSatisfaction(value: unknown): value is HardEdgeSatisfaction {
  return value === "SATISFIED" || value === "UNSATISFIED" || value === "UNKNOWN";
}

/**
 * Two outcomes, deliberately distinct.
 *
 * `ok: false` is FATAL — a schema, count or density refusal the pre-split code
 * answered with an immediate `fail`, before any node fact was read. It must stay
 * immediate: continuing would read elements past a ceiling that just failed.
 *
 * `ok: true` still carries `issues`, the ACCUMULATED HARD-edge problems. Not a
 * refusal by themselves — the caller keeps parsing node facts and appends to this
 * same list, because combined ordering (HARD before node) is observable through
 * the canonical sort.
 */
export type CursorAdmission =
  | { readonly ok: false; readonly issues: readonly GraphIssue[] }
  | {
      readonly ok: true;
      readonly issues: readonly GraphIssue[];
      readonly edgeState: ReadonlyMap<string, HardEdgeSatisfaction>;
      /** Already proven a dense plain array within the node ceiling. */
      readonly nodeAvailabilityFacts: unknown[];
      readonly nodeAvailabilityFactCount: number;
    };

function malformed(detail: string): GraphIssue {
  return makeIssue("FRONTIER_MALFORMED_CURSOR", detail, [], []);
}

/** Every HARD edge key in the graph, which is the universe a fact may name. */
function hardEdgeKeysOf(graph: ValidatedGraph): Set<string> {
  const hardEdgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind === "HARD") {
      hardEdgeKeys.add(edge.edgeKey);
    }
  }
  return hardEdgeKeys;
}

/**
 * Read the two cursor collections without invoking a single accessor: the shape
 * check rejects anything that is not a plain record with exactly the two own
 * string keys, and each read goes through `readOwnDataProperty`, so a getter or
 * proxy trap is refused rather than executed.
 */
function readCollections(rawCursor: unknown): {
  readonly hardEdgeFacts: unknown;
  readonly nodeAvailabilityFacts: unknown;
} {
  const cursorShape = isPlainRecord(rawCursor) && hasOnlyOwnStringKeys(rawCursor, CURSOR_KEYS);
  const hardFactsProperty = cursorShape
    ? readOwnDataProperty(rawCursor, "hardEdgeFacts")
    : { ok: false as const };
  const nodeFactsProperty = cursorShape
    ? readOwnDataProperty(rawCursor, "nodeAvailabilityFacts")
    : { ok: false as const };
  return {
    hardEdgeFacts: hardFactsProperty.ok && hardFactsProperty.present
      ? hardFactsProperty.value
      : undefined,
    nodeAvailabilityFacts: nodeFactsProperty.ok && nodeFactsProperty.present
      ? nodeFactsProperty.value
      : undefined,
  };
}

/** The ceilings, applied to declared lengths before any element is touched. */
function countRefusals(hardEdgeFactCount: number, nodeAvailabilityFactCount: number): GraphIssue[] {
  const countIssues: GraphIssue[] = [];
  if (hardEdgeFactCount > ABSOLUTE_MAX_GRAPH_TOTAL_EDGES) {
    countIssues.push(
      malformed(
        `cursor declares ${hardEdgeFactCount} HARD-edge facts; parser ceiling is ${ABSOLUTE_MAX_GRAPH_TOTAL_EDGES}`,
      ),
    );
  }
  if (nodeAvailabilityFactCount > ABSOLUTE_MAX_GRAPH_NODES) {
    countIssues.push(
      malformed(
        `cursor declares ${nodeAvailabilityFactCount} node facts; parser ceiling is ${ABSOLUTE_MAX_GRAPH_NODES}`,
      ),
    );
  }
  return countIssues;
}

/**
 * Parse the HARD-edge facts into a satisfaction map, accumulating one issue per
 * malformed, unknown or duplicate fact rather than refusing on the first, then
 * report every HARD edge left without a fact in sorted key order.
 */
function readHardEdgeFacts(
  hardEdgeFacts: unknown[],
  hardEdgeFactCount: number,
  hardEdgeKeys: ReadonlySet<string>,
  issues: GraphIssue[],
): Map<string, HardEdgeSatisfaction> {
  const edgeState = new Map<string, HardEdgeSatisfaction>();
  const seenEdgeFacts = new Set<string>();
  for (let i = 0; i < hardEdgeFactCount; i += 1) {
    const factProperty = readOwnArrayElement(hardEdgeFacts, i);
    const fact = factProperty.ok && factProperty.present
      ? factProperty.value
      : undefined;
    const factShape = isPlainRecord(fact) && hasOnlyOwnStringKeys(fact, HARD_EDGE_FACT_KEYS);
    const edgeKeyProperty = factShape
      ? readOwnDataProperty(fact, "edgeKey")
      : { ok: false as const };
    const stateProperty = factShape
      ? readOwnDataProperty(fact, "state")
      : { ok: false as const };
    const edgeKey = edgeKeyProperty.ok && edgeKeyProperty.present
      ? edgeKeyProperty.value
      : undefined;
    const state = stateProperty.ok && stateProperty.present
      ? stateProperty.value
      : undefined;
    if (!factShape || !isGraphKey(edgeKey) || !isSatisfaction(state)) {
      issues.push(malformed(`hardEdgeFacts[${i}] is malformed or has an invalid state`));
      continue;
    }
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
    edgeState.set(edgeKey, state);
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
  return edgeState;
}

/**
 * Admit a caller-supplied cursor as far as its HARD-edge facts, handing back the
 * satisfaction map plus the node-fact array that survived the ceilings. Node
 * facts are deliberately NOT parsed here: `frontier.ts` owns node readiness, and
 * splitting that decision across two modules is the drift this avoids.
 */
export function admitFrontierCursor(graph: ValidatedGraph, cursor: unknown): CursorAdmission {
  const { hardEdgeFacts, nodeAvailabilityFacts } = readCollections(cursor as unknown);
  if (!isPlainArray(hardEdgeFacts) || !isPlainArray(nodeAvailabilityFacts)) {
    return {
      ok: false,
      issues: [
        malformed(
          "cursor schema is malformed; it requires only own hardEdgeFacts and nodeAvailabilityFacts arrays",
        ),
      ],
    };
  }

  const hardEdgeFactCount = readPlainArrayLength(hardEdgeFacts);
  const nodeAvailabilityFactCount = readPlainArrayLength(nodeAvailabilityFacts);
  if (hardEdgeFactCount === null || nodeAvailabilityFactCount === null) {
    return { ok: false, issues: [malformed("cursor collection lengths could not be read safely")] };
  }
  const countIssues = countRefusals(hardEdgeFactCount, nodeAvailabilityFactCount);
  if (countIssues.length > 0) {
    return { ok: false, issues: countIssues };
  }
  if (
    !hasExactDenseArrayShape(hardEdgeFacts, hardEdgeFactCount) ||
    !hasExactDenseArrayShape(nodeAvailabilityFacts, nodeAvailabilityFactCount)
  ) {
    return {
      ok: false,
      issues: [malformed("cursor collections must contain only dense own data elements")],
    };
  }

  const issues: GraphIssue[] = [];
  const edgeState = readHardEdgeFacts(
    hardEdgeFacts,
    hardEdgeFactCount,
    hardEdgeKeysOf(graph),
    issues,
  );
  return { ok: true, issues, edgeState, nodeAvailabilityFacts, nodeAvailabilityFactCount };
}
