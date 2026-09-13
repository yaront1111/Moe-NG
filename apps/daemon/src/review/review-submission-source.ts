import { encodeGraphContent } from "@moe/scheduler";
import type { AcceptanceCriterionObligation } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";
import { activeCompiledGraphs, createCompiledNodeSource } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { locateSealedAuthority } from "../planning/planning-authority-reader-seal.js";

export interface ReviewSubmissionSource {
  readonly authorityRef: string;
  readonly criteria: readonly AcceptanceCriterionObligation[];
  readonly goalRef: string;
  readonly graphContentHash: string;
  readonly graphRevisionRef: string;
  readonly nodeKey: string;
  readonly planHash: string;
  readonly runId: string;
}

/** An exact activated execution identity, followed back to the approved immutable bodies. */
export function readReviewSubmissionSource(
  store: SqliteEventStore, projectId: string, nodeRef: string,
): ReviewSubmissionSource | null {
  const listed = createCompiledNodeSource({ projectId, store, workspace: null, testCommand: null }).nodes();
  if (!listed.some((node) => node.nodeRef === nodeRef)) return null;
  for (const graph of activeCompiledGraphs(store, projectId)) {
    const node = graph.content.nodeAuthority.definitions.find((definition) =>
      compiledExecutionRef(projectId, graph, definition.nodeKey) === nodeRef);
    if (node === undefined) continue;
    const authority = locateSealedAuthority(store, projectId, graph.goalRef);
    if ("ok" in authority || authority.runId !== graph.planningRunRef) return null;
    const encoded = encodeGraphContent(graph.content);
    if (!encoded.ok || authority.revision.graphBinding.graphContentHash !== encoded.value.graphContentHash
      || authority.contract.applicability.graphContentHash !== encoded.value.graphContentHash
      || !authority.contract.applicability.nodeIds.includes(node.nodeKey)) return null;
    const criteria = node.criterionBindings.map((binding) =>
      authority.contract.obligations.find((criterion) => criterion.criterionId === binding.criterionId));
    // The complete node denominator is required. Filtering a missing criterion would silently
    // turn a partial package into an apparently complete review of that node.
    if (criteria.length === 0 || criteria.some((criterion) => criterion === undefined)) return null;
    return Object.freeze({ authorityRef: authority.authorityRef,
      criteria: Object.freeze(criteria as AcceptanceCriterionObligation[]), goalRef: graph.goalRef,
      graphContentHash: encoded.value.graphContentHash,
      graphRevisionRef: authority.revision.graphBinding.graphRevisionRef,
      nodeKey: node.nodeKey, planHash: authority.revision.planHash, runId: authority.runId });
  }
  return null;
}
