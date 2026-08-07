import type {
  FrontierPartition,
  GraphKey,
  ValidatedGraph,
} from "./graph-model.js";

/** Length-frame a variable token so no value can forge a field boundary. */
function frame(token: string): string {
  return `${token.length}:${token}`;
}

function appendKeyList(
  parts: string[],
  tag: string,
  keys: readonly GraphKey[],
): void {
  parts.push(`${tag}${keys.length}`);
  for (const key of keys) {
    parts.push(frame(key));
  }
}

/**
 * Canonical, collision-free identity of every normalized fact that determines
 * one successful preview result: graph structure, resolved policy, and the
 * optional frontier partition. This is deliberately non-cryptographic and
 * grants no authority; it exists only to prevent stale result/cache mix-ups.
 */
export function computeGraphPreviewIdentity(
  graph: ValidatedGraph,
  frontier?: FrontierPartition,
): string {
  const policy = graph.policy;
  const parts = [
    "MOE-GRAPH-PREVIEW-IDENTITY/1",
    `G${frame(graph.graphIdentity)}`,
    `P${policy.maxNodes},${policy.maxHardEdges},${policy.maxTotalEdges},${policy.minGatedDescendantsForReview}`,
  ];

  if (frontier === undefined) {
    parts.push("F0");
    return parts.join("\n");
  }

  parts.push("F1");
  appendKeyList(parts, "L", frontier.logicalReady);
  appendKeyList(parts, "A", frontier.admissionReady);
  appendKeyList(parts, "D", frontier.dispatchable);
  parts.push(`B${frontier.blocked.length}`);
  for (const blocked of frontier.blocked) {
    parts.push(`N${frame(blocked.nodeKey)}R${blocked.reasons.length}`);
    for (const reason of blocked.reasons) {
      parts.push(
        frame(reason.code) +
          frame(reason.edgeKey) +
          frame(reason.producerNodeKey),
      );
    }
  }
  return parts.join("\n");
}
