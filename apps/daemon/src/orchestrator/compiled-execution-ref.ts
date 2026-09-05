import { createHash } from "node:crypto";
import { encodeGraphContent } from "@moe/scheduler";
import type { ActiveCompiledGraph } from "./compiled-node-source.js";

/** Reserved for daemon-derived subjects; operator node specs cannot claim this namespace. */
export const COMPILED_EXECUTION_REF_PREFIX = "node:v1:";

/** Local graph keys stay local. The opaque execution subject binds the complete sealed owner. */
export function compiledExecutionRef(projectId: string, graph: ActiveCompiledGraph, nodeKey: string): string {
  const encoded = encodeGraphContent(graph.content);
  if (!encoded.ok) throw new Error("COMPILED_NODE_IDENTITY_UNREADABLE");
  const tuple = ["moe-compiled-execution/1", projectId, graph.goalRef,
    graph.planningRunRef ?? null, encoded.value.graphContentHash, nodeKey];
  return `${COMPILED_EXECUTION_REF_PREFIX}${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}`;
}
