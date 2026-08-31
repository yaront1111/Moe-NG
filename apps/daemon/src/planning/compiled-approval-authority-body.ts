import { createAcceptanceContract, createPlanRevision } from "@moe/core";

import type {
  CompiledNodeInput,
  CompiledPlanInput,
} from "./compiled-authority-contracts.js";

interface CompiledApprovalRefusal {
  readonly code: string;
  readonly layer: string;
  readonly ok: false;
}

interface CompiledApprovalAuthorityBody {
  readonly acceptanceContract: Record<string, unknown>;
  readonly ok: true;
  readonly planRevision: Record<string, unknown>;
  readonly submissionHash: string;
}

type CompiledApprovalResult =
  | CompiledApprovalAuthorityBody
  | CompiledApprovalRefusal;

const NODE_GRAPH_HASH = "a".repeat(64);
const NODE_GRAPH_REF = "graph-revision-a";

/** BYTE-EQUAL from the approved revision: finalize compares statements verbatim. */
function statementOf(input: CompiledPlanInput, criterionId: string): string {
  const criterion = input.criteria.find((entry) => entry.criterionId === criterionId);
  if (criterion === undefined) throw new Error(`unknown criterion ${criterionId}`);
  return criterion.statement;
}

/** The definition's planning pair binds a different graph from the compiled graph. */
export function createCompiledNodePlanning(
  input: CompiledPlanInput,
  node: CompiledNodeInput,
): Record<string, unknown> {
  const plan = createPlanRevision({
    affectedCriterionIds: [...node.criterionIds],
    affectedNodeIds: [node.nodeKey],
    approvalState: "APPROVED",
    authorRef: input.authorRef,
    graphBinding: { graphContentHash: NODE_GRAPH_HASH, graphRevisionRef: NODE_GRAPH_REF },
    parentRevisionId: null,
    rejectionRef: null,
    revisionId: `${input.idPrefix}-${node.nodeKey}-plan`,
    steps: [{ description: node.objective, kind: "IMPLEMENTATION", stepId: "step-a" }],
    verificationRecipeRefs: [...node.verificationRecipeRefs],
  });
  if (!plan.ok) throw new Error(`compiled node plan refused: ${plan.code}@${plan.layer}`);
  const accepted = createAcceptanceContract({
    applicability: {
      graphContentHash: NODE_GRAPH_HASH,
      graphRevisionRef: NODE_GRAPH_REF,
      nodeIds: [node.nodeKey],
      nodeKind: "LEAF",
    },
    authorRef: input.authorRef,
    contractId: `${input.idPrefix}-${node.nodeKey}-contract`,
    obligations: node.criterionIds.map((criterionId) => ({
      criterionId,
      evidenceRequirements: [{
        evidenceRef: `${criterionId}-evidence`,
        kind: "VERIFICATION_RECEIPT",
        requirementId: `${criterionId}-requirement`,
      }],
      statement: statementOf(input, criterionId),
      verificationRecipeRefs: [...node.verificationRecipeRefs],
    })),
  });
  if (!accepted.ok) {
    throw new Error(`compiled node acceptance refused: ${accepted.code}@${accepted.layer}`);
  }
  return { acceptanceContract: accepted.contract, planRevision: plan.revision };
}

export function createCompiledApprovalAuthorityBody(
  input: CompiledPlanInput,
  graphContentHash: string,
): CompiledApprovalResult {
  const planRevision = createPlanRevision({
    affectedCriterionIds: input.criteria.map((criterion) => criterion.criterionId),
    affectedNodeIds: input.nodes.map((node) => node.nodeKey),
    approvalState: "PENDING_APPROVAL",
    authorRef: input.authorRef,
    graphBinding: { graphContentHash, graphRevisionRef: input.graphRevisionRef },
    parentRevisionId: null,
    rejectionRef: null,
    revisionId: `${input.idPrefix}-revision`,
    steps: input.nodes.map((node, index) => ({
      description: node.objective,
      kind: "IMPLEMENTATION",
      stepId: `step-${String(index + 1).padStart(5, "0")}`,
    })),
    verificationRecipeRefs: [`${input.idPrefix}-recipe`],
  });
  if (!planRevision.ok) return planRevision;
  const acceptance = createAcceptanceContract({
    applicability: {
      graphContentHash,
      graphRevisionRef: input.graphRevisionRef,
      nodeIds: input.nodes.map((node) => node.nodeKey),
      nodeKind: "LEAF",
    },
    authorRef: input.authorRef,
    contractId: `${input.idPrefix}-contract`,
    obligations: input.criteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      evidenceRequirements: [{
        evidenceRef: `${criterion.criterionId}-evidence`,
        kind: "VERIFICATION_RECEIPT",
        requirementId: `${criterion.criterionId}-requirement`,
      }],
      statement: criterion.statement,
      verificationRecipeRefs: [`${input.idPrefix}-recipe`],
    })),
  });
  if (!acceptance.ok) return acceptance;
  const revision = planRevision.revision as unknown as Record<string, unknown>;
  return {
    acceptanceContract: acceptance.contract as unknown as Record<string, unknown>,
    ok: true,
    planRevision: revision,
    submissionHash: revision["planHash"] as string,
  };
}
