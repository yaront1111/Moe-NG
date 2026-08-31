/**
 * Public coordinator for the N-node planning-authority producer.
 *
 * Structure admission and stable refusal mapping stay at this boundary. The
 * private policy and approval producers retain their separate codec authority;
 * no clock, randomness, or alternate canonicalization enters composition.
 */
import { createCompiledApprovalAuthorityBody } from "./compiled-approval-authority-body.js";
import {
  CompiledPolicyAdmissionError,
  createCompiledPolicyAuthorityBody,
} from "./compiled-policy-authority-body.js";
import { COMPILED_PLAN_NODE_BUDGET } from "./compiled-authority-contracts.js";
import type {
  CompiledPlanCode,
  CompiledPlanInput,
  CompiledPlanResult,
} from "./compiled-authority-contracts.js";

const LAYER = "COMPILED_PLAN_PRODUCER";
const KEY = /^[a-z0-9][a-z0-9-]{0,120}$/u;

function refused(code: CompiledPlanCode, detail: string): CompiledPlanResult {
  return Object.freeze({ code, detail, layer: LAYER, ok: false });
}

function nonEmptyStrings(value: readonly string[]): boolean {
  return value.every((entry) => typeof entry === "string" && entry.length > 0);
}

/** Structure admission: everything the private codecs do not already own. */
function shapeRefusal(input: CompiledPlanInput): CompiledPlanResult | null {
  if (input.nodes.length === 0) return refused("COMPILED_PLAN_MALFORMED", "no nodes");
  if (input.nodes.length > COMPILED_PLAN_NODE_BUDGET) {
    return refused(
      "COMPILED_PLAN_BUDGET_EXCEEDED",
      `${input.nodes.length} nodes exceed the compile budget of ${COMPILED_PLAN_NODE_BUDGET}`,
    );
  }
  if (input.criteria.length === 0) return refused("COMPILED_PLAN_MALFORMED", "no criteria");
  const nodeKeys = new Set<string>();
  for (const node of input.nodes) {
    if (!KEY.test(node.nodeKey) || nodeKeys.has(node.nodeKey)) {
      return refused("COMPILED_PLAN_MALFORMED", `node key ${node.nodeKey}`);
    }
    nodeKeys.add(node.nodeKey);
    if (node.objective.length === 0 || node.capability.length === 0
      || !nonEmptyStrings(node.readScopes) || !nonEmptyStrings(node.writeScopes)
      || !nonEmptyStrings(node.resources) || !nonEmptyStrings(node.verificationRecipeRefs)
      || node.verificationRecipeRefs.length === 0) {
      return refused("COMPILED_PLAN_MALFORMED", `node ${node.nodeKey}`);
    }
  }
  if (!nodeKeys.has(input.completionNodeKey)) {
    return refused("COMPILED_PLAN_MALFORMED", "completion node is not a listed node");
  }
  const criterionIds = new Set(input.criteria.map((criterion) => criterion.criterionId));
  if (criterionIds.size !== input.criteria.length) {
    return refused("COMPILED_PLAN_MALFORMED", "duplicate criterion id");
  }
  const covered = new Set<string>();
  for (const node of input.nodes) {
    for (const dependency of node.dependsOn) {
      if (!nodeKeys.has(dependency) || dependency === node.nodeKey) {
        return refused("COMPILED_PLAN_MALFORMED", `dependsOn ${dependency} of ${node.nodeKey}`);
      }
      if (dependency === input.completionNodeKey) {
        return refused(
          "COMPILED_PLAN_MALFORMED",
          `node ${node.nodeKey} depends on the completion node`,
        );
      }
    }
    for (const criterionId of node.criterionIds) {
      if (!criterionIds.has(criterionId)) {
        return refused(
          "COMPILED_PLAN_CRITERION_UNBOUND",
          `node ${node.nodeKey} cites unknown criterion ${criterionId}`,
        );
      }
      covered.add(criterionId);
    }
  }
  for (const criterion of input.criteria) {
    if (!covered.has(criterion.criterionId)) {
      return refused(
        "COMPILED_PLAN_CRITERION_UNBOUND",
        `criterion ${criterion.criterionId} is satisfied by no node`,
      );
    }
  }
  if (input.knownCapabilities !== null) {
    const known = new Set(input.knownCapabilities);
    for (const node of input.nodes) {
      if (!known.has(node.capability)) {
        return refused(
          "COMPILED_PLAN_CAPABILITY_UNCATALOGED",
          `no verification command for capability ${node.capability} (node ${node.nodeKey})`,
        );
      }
    }
  }
  return null;
}

export function compiledPlanAuthority(input: CompiledPlanInput): CompiledPlanResult {
  const shape = shapeRefusal(input);
  if (shape !== null) return shape;
  try {
    const graph = createCompiledPolicyAuthorityBody(input);
    const approval = createCompiledApprovalAuthorityBody(input, graph.graphContentHash);
    if (!approval.ok) {
      return refused("COMPILED_PLAN_ADMISSION_REFUSED", `${approval.code}@${approval.layer}`);
    }
    return Object.freeze({
      authority: {
        acceptanceContract: approval.acceptanceContract,
        planRevision: approval.planRevision,
      },
      graphContentBytesBase64: Buffer.from(graph.bytes).toString("base64"),
      graphContentHash: graph.graphContentHash,
      ok: true as const,
      submissionHash: approval.submissionHash,
    });
  } catch (error) {
    if (error instanceof CompiledPolicyAdmissionError) {
      return refused("COMPILED_PLAN_ADMISSION_REFUSED", error.message);
    }
    throw error;
  }
}
