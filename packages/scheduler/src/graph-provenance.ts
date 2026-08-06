import type { FrontierPartition, ValidatedGraph } from "./graph-model.js";

// Package-internal capability registry. The supported `@moe/scheduler` export
// does not expose this module or either registrar; package-internal subpaths are
// blocked by `exports`. This prevents public-API fabrication and accidental
// cross-graph reuse. It is not a sandbox against code that already has direct
// filesystem import and arbitrary in-process execution authority.
const validatedGraphs = new WeakSet<object>();
const frontierBindings = new WeakMap<object, object>();

export function registerValidatedGraph(graph: ValidatedGraph): ValidatedGraph {
  validatedGraphs.add(graph);
  return graph;
}

export function hasValidatedGraphProvenance(value: unknown): value is ValidatedGraph {
  return typeof value === "object" && value !== null && validatedGraphs.has(value);
}

export function registerFrontierPartition(
  graph: ValidatedGraph,
  partition: FrontierPartition,
): FrontierPartition {
  if (!hasValidatedGraphProvenance(graph)) {
    throw new Error("GRAPH_VALIDATION_PROVENANCE_INVALID: unregistered graph");
  }
  frontierBindings.set(partition, graph);
  return partition;
}

export function isFrontierPartitionForGraph(
  frontier: unknown,
  graph: ValidatedGraph,
): frontier is FrontierPartition {
  return (
    typeof frontier === "object" &&
    frontier !== null &&
    frontierBindings.get(frontier) === graph
  );
}
