/** Graph-independent planning composition for NodeDefinition creation. */
import {
  createAcceptanceCriterionContent, createPlanExecutionContent,
} from "@moe/core";

import { NODE_AUTHORITY_LIMITS, ok, passthrough, refuse } from "./node-authority-contract.js";
import type { AdmittedPlanning } from "./node-authority-compose.js";
import type { Read } from "./node-authority-contract.js";

/** Re-admits both content bodies and recomputes both identities; no digest enters as input. */
export function admitPlanningContent(
  plan: unknown,
  acceptance: unknown,
): Read<AdmittedPlanning> {
  const execution = createPlanExecutionContent(plan);
  if (!execution.ok) return passthrough("PLANNING_SOURCE", [execution]);
  const criteria = createAcceptanceCriterionContent(acceptance);
  if (!criteria.ok) return passthrough("PLANNING_SOURCE", [criteria]);
  if (criteria.criteria.length > NODE_AUTHORITY_LIMITS.maxCriterionBindings) {
    return refuse("NODE_AUTHORITY_LIMIT_EXCEEDED", "NODE_AUTHORITY_LIMITS",
      "criterion bindings exceed their bound");
  }
  return ok({
    criteria: criteria.criteria,
    criterionIds: execution.content.affectedCriterionIds,
    nodeIds: execution.content.affectedNodeIds,
    planExecutionContentDigest: execution.planExecutionContentDigest,
    recipeRefs: execution.content.verificationRecipeRefs,
  });
}
