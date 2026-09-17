import { createHash } from "node:crypto";
import { encodeGraphContent } from "@moe/scheduler";
import type { ActiveCompiledGraph } from "./compiled-node-source.js";

/** Reserved for daemon-derived subjects; operator node specs cannot claim this namespace. */
export const COMPILED_EXECUTION_REF_PREFIX = "node:v1:";

/**
 * ONE encode per graph, not one per node.
 *
 * `encodeGraphContent` canonicalises every node's authority to produce the hash, and every
 * caller of `compiledExecutionRef` calls it in a loop over the graph's nodes — the read routes
 * map each definition to its ref, and three `.find` sites encode the whole graph per node just to
 * locate one. So each request was encoding the entire graph N times for N nodes: O(N²)
 * canonicalisations to produce N copies of the same hash.
 *
 * Measured on UnAI 2026-09-17 with a 15 s CPU profile of the live stack host: 84% on-CPU while
 * "nothing to staff", 51.5% of it under this function (`canonicalText` alone 21% of all self
 * time), the control room's affordance poll taking 3–4 s of synchronous work per request behind
 * it, and the control room sitting on "Coming online" behind the queue those polls formed.
 *
 * The content object is immutable and its identity is what the loops share, so it is the key. A
 * WeakMap keeps nothing alive: a graph read for one request is collected with that request.
 */
const graphContentHashes = new WeakMap<ActiveCompiledGraph["content"], string>();

function graphContentHashOf(content: ActiveCompiledGraph["content"]): string {
  const cached = graphContentHashes.get(content);
  if (cached !== undefined) return cached;
  const encoded = encodeGraphContent(content);
  if (!encoded.ok) throw new Error("COMPILED_NODE_IDENTITY_UNREADABLE");
  graphContentHashes.set(content, encoded.value.graphContentHash);
  return encoded.value.graphContentHash;
}

/** Local graph keys stay local. The opaque execution subject binds the complete sealed owner. */
export function compiledExecutionRef(projectId: string, graph: ActiveCompiledGraph, nodeKey: string): string {
  const tuple = ["moe-compiled-execution/1", projectId, graph.goalRef,
    graph.planningRunRef ?? null, graphContentHashOf(graph.content), nodeKey];
  return `${COMPILED_EXECUTION_REF_PREFIX}${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}`;
}
