import type {
  ProductCheck, ProductCriterion, ProductCriterionModel, ProductImplementationLink, ProductRequirementModel,
  ProductRequirementsInput, ProductRequirementsModel, ProductRequirementState,
} from "./contracts.js";
import { sameProductContract, sameProductScope } from "./identity.js";

function applies(input: ProductRequirementsInput, item: ProductCheck | ProductImplementationLink): boolean {
  return sameProductScope(input.scope, item.scope) && sameProductContract(input.contractRef, item.contractRef)
    && input.planningRunRef !== null && input.planningRunRef === item.planningRunRef
    && input.graphContentHash !== null && input.graphContentHash === item.graphContentHash;
}

function criterionModel(input: ProductRequirementsInput, criterion: ProductCriterion): ProductCriterionModel {
  const links = input.implementationLinks.filter((item) => item.criterionId === criterion.criterionId && applies(input, item));
  const checks = input.checks.filter((item) => item.criterionId === criterion.criterionId && applies(input, item));
  const current = input.sha === null ? [] : checks.filter((item) => item.sha === input.sha);
  let state: ProductRequirementState = "NOT_IMPLEMENTED";
  if (input.availability !== "PRESENT" || input.contractRef === null
    || input.planningRunRef === null || input.graphContentHash === null) state = "UNKNOWN";
  else if (current.some((item) => item.status === "FAILED")) state = "FAILED";
  else if (current.some((item) => item.status === "UNKNOWN")) state = "UNKNOWN";
  else if (current.length > 0) state = "PASSED";
  else if (input.sha !== null && checks.length > 0) state = "NEEDS_CHECKING_AGAIN";
  else if (links.some((item) => item.state === "UNKNOWN")) state = "UNKNOWN";
  else if (links.length > 0 && links.every((item) => item.state === "IMPLEMENTED")) state = "IMPLEMENTED_UNCHECKED";
  else if (links.length > 0) state = "IN_PROGRESS";
  return Object.freeze({ ...criterion, state,
    implementationNodes: Object.freeze([...new Set(links.map((item) => item.nodeKey))]),
    receiptIds: Object.freeze([...new Set(current.map((item) => item.receiptId))]),
  });
}

function requirementState(criteria: readonly ProductCriterionModel[]): ProductRequirementState {
  if (criteria.some((item) => item.state === "FAILED")) return "FAILED";
  if (criteria.length === 0 || criteria.some((item) => item.state === "UNKNOWN")) return "UNKNOWN";
  if (criteria.every((item) => item.state === "PASSED")) return "PASSED";
  if (criteria.some((item) => item.state === "NEEDS_CHECKING_AGAIN")) return "NEEDS_CHECKING_AGAIN";
  if (criteria.every((item) => item.state === "IMPLEMENTED_UNCHECKED" || item.state === "PASSED")) return "IMPLEMENTED_UNCHECKED";
  if (criteria.every((item) => item.state === "NOT_IMPLEMENTED")) return "NOT_IMPLEMENTED";
  return "IN_PROGRESS";
}

/** Read-only interpretation of explicitly bound records; no command or approval authority. */
export function buildProductRequirements(input: ProductRequirementsInput): ProductRequirementsModel {
  const occurrences = new Map<string, number>();
  for (const row of input.requirements) for (const criterion of row.criteria) {
    occurrences.set(criterion.criterionId, (occurrences.get(criterion.criterionId) ?? 0) + 1);
  }
  const requirements: readonly ProductRequirementModel[] = Object.freeze(input.requirements.map((requirement) => {
    const criteria = Object.freeze(requirement.criteria.map((criterion) => criterionModel(
      occurrences.get(criterion.criterionId) === 1 ? input : { ...input, availability: "UNREADABLE" }, criterion,
    )));
    return Object.freeze({ requirementId: requirement.requirementId, statement: requirement.statement,
      criteria, state: requirementState(criteria), relationshipNote: "No design or preview location link recorded.",
    });
  }));
  const criteria = [...new Map(requirements.flatMap((item) => item.criteria).map((item) => [item.criterionId, item])).values()];
  const passed = criteria.filter((item) => item.state === "PASSED").length;
  const failed = criteria.filter((item) => item.state === "FAILED").length;
  const total = criteria.length;
  const state = input.availability !== "PRESENT" || input.contractRef === null || total === 0 ? "UNKNOWN"
    : failed > 0 ? "FAILED" : criteria.some((item) => item.state === "UNKNOWN") ? "UNKNOWN"
    : passed === total ? "PASSED" : "INCOMPLETE";
  const label = input.sha === null ? `No candidate selected; ${total} criterion checks defined`
    : `${passed} of ${total} criterion checks passed for this candidate`;
  return Object.freeze({ advisoryOnly: true, requirements, readiness: Object.freeze({ state, passed, failed, total, label }) });
}
