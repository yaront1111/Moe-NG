import type { NodeFact } from "./topology.js";

export function graphIsCyclic(nodes: readonly NodeFact[]): boolean {
  const indegree = new Map(nodes.map((node) => [node.nodeId, node.dependencyIds.length]));
  const consumers = new Map<string, string[]>();
  for (const node of nodes) for (const dependency of node.dependencyIds) {
    const values = consumers.get(dependency) ?? [];
    values.push(node.nodeId); consumers.set(dependency, values);
  }
  const ready = [...indegree].filter(([, count]) => count === 0)
    .map(([id]) => id).sort();
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift()!; visited += 1;
    for (const consumer of consumers.get(id) ?? []) {
      const next = indegree.get(consumer)! - 1; indegree.set(consumer, next);
      if (next === 0) { ready.push(consumer); ready.sort(); }
    }
  }
  return visited !== nodes.length;
}
