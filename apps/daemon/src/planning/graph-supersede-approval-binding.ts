/**
 * Binds a supersede approval to the durable successor it authorizes.
 *
 * Supersession inherits the predecessor's bound budget, quality and policy hashes while replacing
 * only the graph hash. The matcher therefore reads that predecessor binding and the sealed
 * successor/criteria bytes rather than trusting request payload copies. Comparison order is fixed:
 * the reachability arm depends on today's predecessor approval failing at REVISION first.
 */
import { replayGraphRevisionEvents } from "@moe/core";
import type { ApprovalDecisionRecord, GraphRevisionState } from "@moe/core";
import { encodeGraphContent } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { budgetCommitmentDigest, budgetCommitmentMaterialForActiveGraph }
  from "../budget/budget-commitment.js";
import { graphRevisionAggregateId } from "./active-graph-projection.js";
import { refuseSupersede } from "./graph-supersede-contracts.js";
import type {
  GraphSupersedeRefusal, GraphSupersedeRequest,
} from "./graph-supersede-contracts.js";
import type { SupersedeFacts } from "./graph-supersede-facts.js";
import { readApprovedCriteria } from "./planning-authority-reader.js";
import { readSupersessionPolicyDecision } from "./supersession-policy-decision.js";

const decoder = new TextDecoder("utf-8", { fatal: false });

function historyOf(store: SqliteEventStore, aggregateId: string): readonly unknown[] {
  return store.readEvents(aggregateId).map((event) => {
    try {
      return JSON.parse(decoder.decode(event.payload)) as unknown;
    } catch {
      return null;
    }
  });
}

const uniqueSorted = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = uniqueSorted(left);
  const rightSet = uniqueSorted(right);
  return leftSet.length === rightSet.length
    && leftSet.every((value, index) => value === rightSet[index]);
}

function predecessorState(
  store: SqliteEventStore, request: GraphSupersedeRequest, facts: SupersedeFacts,
): GraphRevisionState | GraphSupersedeRefusal {
  const aggregateId = graphRevisionAggregateId(request.projectId, facts.active.revisionId);
  const replayed = replayGraphRevisionEvents(historyOf(store, aggregateId));
  if (!replayed.ok || replayed.state.boundHashes === null) {
    return refuseSupersede("GRAPH_SUPERSEDE_PREDECESSOR_MISMATCH");
  }
  return replayed.state;
}

export function matchSupersedeApproval(
  store: SqliteEventStore,
  request: GraphSupersedeRequest,
  facts: SupersedeFacts,
  record: ApprovalDecisionRecord,
): GraphSupersedeRefusal | null {
  const successor = encodeGraphContent(facts.successorContent);
  if (!successor.ok || successor.value.graphContentHash !== record.exactRevisionHash) {
    return refuseSupersede("GRAPH_SUPERSEDE_APPROVAL_REVISION_MISMATCH");
  }
  const successorScope = facts.successorContent.nodeAuthority.authorities
    .map(({ nodeKey }) => nodeKey);
  if (!sameSet(record.approvedNodeScope, successorScope)) {
    return refuseSupersede("GRAPH_SUPERSEDE_APPROVAL_SCOPE_MISMATCH");
  }
  const predecessor = predecessorState(store, request, facts);
  if ("ok" in predecessor) return predecessor;
  // COMMITMENT TO COMMITMENT. `budgetRef` on an approval record stopped meaning the activation
  // ROOT digest when task-61a2e8ad landed the two-phase commitment: it now covers the budget
  // material that was durable when the human decided. The predecessor's persisted binding still
  // carries the root, and budgetCommitmentDigest is domain-tagged so the two can never alias --
  // so comparing against boundHashes.budgetHash refused every honest successor. The right-hand
  // side is recomputed from the predecessor's own durable material through the SHARED builder,
  // and the persisted record is only READ: boundHashes keeps its shape.
  const commitment = budgetCommitmentMaterialForActiveGraph(
    store, { goalRef: request.goalRef, projectId: request.projectId },
  );
  if (!commitment.ok) {
    return refuseSupersede("GRAPH_SUPERSEDE_APPROVAL_BUDGET_MISMATCH",
      { code: commitment.code, layer: commitment.layer });
  }
  if (record.budgetRef !== budgetCommitmentDigest(commitment.material)) {
    return refuseSupersede("GRAPH_SUPERSEDE_APPROVAL_BUDGET_MISMATCH");
  }
  const criteria = readApprovedCriteria(store, request.projectId, request.goalRef);
  if (!criteria.ok) {
    return refuseSupersede("GRAPH_SUPERSEDE_APPROVED_CRITERIA_UNREADABLE",
      { code: criteria.code, layer: criteria.layer });
  }
  if (record.criteriaRef !== criteria.criteriaDigest) {
    return refuseSupersede("GRAPH_SUPERSEDE_APPROVAL_CRITERIA_MISMATCH");
  }
  if (record.planQualityAssessmentRef !== predecessor.boundHashes?.qualityHash) {
    return refuseSupersede("GRAPH_SUPERSEDE_APPROVAL_QUALITY_MISMATCH");
  }
  const policy = readSupersessionPolicyDecision(
    store, request.projectId, request.successorRevisionRef,
  );
  if (!policy.ok) {
    return refuseSupersede("GRAPH_SUPERSEDE_APPROVAL_POLICY_DECISION_MISMATCH",
      { code: policy.code, layer: policy.layer });
  }
  if (record.applicablePolicyRef !== policy.policyRef) {
    return refuseSupersede("GRAPH_SUPERSEDE_APPROVAL_POLICY_MISMATCH");
  }
  if (record.actor !== policy.principalId || !sameSet(policy.scope, successorScope)
    || record.policyDecisionRef !== policy.decisionDigest) {
    return refuseSupersede("GRAPH_SUPERSEDE_APPROVAL_POLICY_DECISION_MISMATCH");
  }
  return null;
}
