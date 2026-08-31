import { createProductContractRevisionV2 } from "@moe/core";

const hex = (digit: string): string => digit.repeat(64);

function requirement(requirementId: string, dependencies: readonly string[] = []) {
  return {
    dependsOnRequirementIds: [...dependencies],
    priority: "MUST" as const,
    requirementId,
    statement: `${requirementId} must hold.`,
    supersedesRequirementId: null,
  };
}

function criterion(criterionId: string, requirementId: string) {
  return {
    criterionId,
    requirementId,
    statement: `${criterionId} is observable.`,
    supersedesCriterionId: null,
    verification: `Verify ${criterionId} deterministically.`,
  };
}

const CRITERION_IDS = Object.freeze([
  "criterion-deployment", "criterion-keyboard", "criterion-latency",
  "criterion-login", "criterion-runtime", "criterion-session",
]);

const created = createProductContractRevisionV2({
  assumptions: [{
    assumptionId: "assumption-browser",
    statement: "Operators use a supported browser.",
    validationCriterionId: "criterion-runtime",
  }],
  authorRef: "principal-product",
  budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 30, unit: "days" }],
  contractId: "contract-1",
  criteria: [
    criterion("criterion-deployment", "deployment-loopback"),
    criterion("criterion-keyboard", "ux-keyboard"),
    criterion("criterion-latency", "nfr-latency"),
    criterion("criterion-login", "requirement-login"),
    criterion("criterion-runtime", "technology-runtime"),
    criterion("criterion-session", "security-session"),
  ],
  deploymentRequirements: [requirement("deployment-loopback", ["technology-runtime"])],
  functionalRequirements: [requirement("requirement-login")],
  journeys: [{
    criterionIds: ["criterion-login", "criterion-session"],
    journeyId: "journey-login",
    statement: "A registered operator signs in and reaches the product.",
    userJobId: "job-access",
  }],
  lineage: { parentRevisionDigest: hex("1"), parentRevisionId: "revision-parent" },
  materialDecisions: [{
    decisionId: "decision-stack",
    options: [
      { optionId: "option-next", statement: "Use Next.js and TypeScript." },
      { optionId: "option-rust", statement: "Use Rust and Axum." },
    ],
    question: "Which qualified delivery profile is required?",
    selectedOptionId: "option-next",
  }],
  negativeScope: [{ scopeId: "scope-native", statement: "No native mobile client." }],
  nonFunctionalRequirements: [requirement("nfr-latency", ["requirement-login"])],
  objectives: [{ objectiveId: "objective-adoption", statement: "Enable first-use success." }],
  productCompleteDefinition: {
    criterionIds: [...CRITERION_IDS],
    statement: "Every approved criterion is independently verified.",
  },
  retiredCriterionIds: ["criterion-retired"],
  retiredRequirementIds: ["requirement-retired"],
  revisionId: "revision-2",
  securityPrivacyRequirements: [requirement("security-session", ["requirement-login"])],
  sourceDocumentDigests: [hex("a")],
  successMetrics: [{
    measurement: "Count consented successful first sessions.",
    metricId: "metric-first-use",
    objectiveIds: ["objective-adoption"],
    statement: "Operators complete their first session.",
    target: "At least 80 percent in a cohort of at least ten.",
  }],
  technologyRequirements: [requirement("technology-runtime")],
  userJobs: [{
    job: "Reach the product with my registered identity.",
    user: "Registered operator",
    userJobId: "job-access",
  }],
  uxAccessibilityRequirements: [requirement("ux-keyboard", ["requirement-login"])],
});

if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
export const GATE1_V2_REVISION = created.revision;

function submission(commandKind: string, commandId: string, payload: Record<string, string>) {
  return Object.freeze({
    affordance: Object.freeze({
      commandEnvelopeVersion: "moe-runtime-command/1",
      commandId,
      commandKind,
      expectedVersion: commandKind === "product_contract.approve_gate_1" ? 0 : 1,
      inputSchemaVersion: commandKind === "product_contract.approve_gate_1"
        ? "moe-product-contract-gate-1/1"
        : "moe-product-contract-clarification/2",
      targetAggregateId: `aggregate-${commandId}`,
    }),
    commandId,
    correlationId: `correlation-${commandId}`,
    payload: Object.freeze(payload),
    requestDigest: hex(commandKind === "product_contract.approve_gate_1" ? "b" : "d"),
  });
}

export const GATE1_V2_APPROVAL = submission(
  "product_contract.approve_gate_1",
  "gate1-cmd-1",
  {
    contractId: GATE1_V2_REVISION.contractId,
    revisionDigest: GATE1_V2_REVISION.revisionDigest,
    revisionId: GATE1_V2_REVISION.revisionId,
  },
);

export const GATE1_V2_ANSWER = submission(
  "product_contract.answer_clarification",
  "answer-cmd-1",
  {
    answerOptionId: "option-a",
    clarificationId: "clarification-profile",
    contractId: GATE1_V2_REVISION.contractId,
  },
);

const GATE1_V2_ANSWER_ALTERNATE = submission(
  "product_contract.answer_clarification",
  "answer-cmd-2",
  {
    answerOptionId: "option-b",
    clarificationId: "clarification-profile",
    contractId: GATE1_V2_REVISION.contractId,
  },
);

const GATE1_V2_OPEN_CLARIFICATIONS = Object.freeze([{
  clarificationId: "clarification-profile",
  options: [{
    answer: GATE1_V2_ANSWER,
    label: "Use the qualified TypeScript profile",
    optionId: "option-a",
    projectionDigest: hex("e"),
    revisionDigest: hex("f"),
  }, {
    answer: GATE1_V2_ANSWER_ALTERNATE,
    label: "Use the qualified alternate profile",
    optionId: "option-b",
    projectionDigest: hex("2"),
    revisionDigest: hex("3"),
  }],
  question: "Which qualified delivery profile should planning use?",
}]);

const GATE1_V2_REF = Object.freeze({
  contractId: GATE1_V2_REVISION.contractId,
  revisionDigest: GATE1_V2_REVISION.revisionDigest,
  revisionId: GATE1_V2_REVISION.revisionId,
});

/** The only state the daemon publishes while a clarification remains open. */
export const GATE1_V2_OPEN_BODY = Object.freeze({
  approval: null,
  clarifications: GATE1_V2_OPEN_CLARIFICATIONS,
  outcome: "PENDING",
  ref: GATE1_V2_REF,
  revision: GATE1_V2_REVISION,
});

/** The distinct state published once clarification authority is satisfied. */
export const GATE1_V2_READY_BODY = Object.freeze({
  approval: GATE1_V2_APPROVAL,
  clarifications: [],
  outcome: "PENDING",
  ref: GATE1_V2_REF,
  revision: GATE1_V2_REVISION,
});

export const GATE1_V2_ANSWERED_PENDING_BODY = Object.freeze({
  approval: null,
  clarifications: [],
  outcome: "PENDING",
  ref: GATE1_V2_REF,
  revision: GATE1_V2_REVISION,
});

export const GATE1_V2_IMPOSSIBLE_BODY = Object.freeze({
  approval: GATE1_V2_APPROVAL,
  clarifications: GATE1_V2_OPEN_CLARIFICATIONS,
  outcome: "PENDING",
  ref: {
    contractId: GATE1_V2_REVISION.contractId,
    revisionDigest: GATE1_V2_REVISION.revisionDigest,
    revisionId: GATE1_V2_REVISION.revisionId,
  },
  revision: GATE1_V2_REVISION,
});
