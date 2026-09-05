import { createHash } from "node:crypto";

import {
  PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION,
  PRODUCT_CONTRACT_V2_VERSION,
  createProductContractCurrentRevisionSlotV2,
  createProductContractRevisionV2,
  encodeProductContractCurrentRevisionSlotV2,
  encodeProductContractRevisionV2,
} from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_CREATE_COMMAND_ID,
  GOAL_ID,
  PROJECT_ID,
  closeStores,
  driveThrough,
  envelope,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import {
  runProductContractProposeRevisionV2,
  type ProposeProductContractRevisionV2Input,
} from "./product-contract-v2-propose-service.js";
import { productContractClarificationV2AggregateId,
  runAnswerProductContractClarificationV2, runAskProductContractClarificationV2 }
  from "./product-contract-v2-clarification-service.js";
import { PRODUCT_CONTRACT_REVISION_V2_COMMAND_KIND,
  deriveProductContractCurrentRevisionSlotV2AggregateId,
  deriveProductContractRevisionV2AggregateId }
  from "./product-contract-v2-address.js";
import { PRODUCT_CONTRACT_CURRENT_SLOT_V2_EVENT_TYPE,
  PRODUCT_CONTRACT_REVISION_V2_EVENT_TYPE }
  from "./product-contract-v2-event-contract.js";
import { PRODUCT_CONTRACT_V2_WORKFLOW_EVENT_TYPE,
  PRODUCT_CONTRACT_V2_WORKFLOW_VERSION,
  deriveProductContractV2WorkflowAggregateId,
  encodeProductContractV2WorkflowHead }
  from "./product-contract-v2-workflow-contract.js";
import { readProductContractV2WorkflowHead }
  from "./product-contract-v2-workflow-reader.js";

const PRINCIPAL = "compiler-agent-v2";
const PRD = "# Product contract v2\n\nBuild the verified local product.\n";
const PRD_SHA = createHash("sha256").update(PRD, "utf8").digest("hex");
const CRITERIA = Object.freeze([
  "criterion-deployment", "criterion-keyboard", "criterion-latency",
  "criterion-login", "criterion-runtime", "criterion-session",
]);

const requirement = (requirementId: string, dependencies: readonly string[] = []) => ({
  dependsOnRequirementIds: [...dependencies], priority: "MUST" as const, requirementId,
  statement: `${requirementId} must hold.`, supersedesRequirementId: null,
});
const criterion = (criterionId: string, requirementId: string) => ({
  criterionId, requirementId, statement: `${criterionId} is observable.`,
  supersedesCriterionId: null, verification: `Run deterministic ${criterionId} verification.`,
});

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assumptions: [{ assumptionId: "assumption-browser", statement: "A browser exists.",
      validationCriterionId: "criterion-runtime" }],
    authorRef: PRINCIPAL,
    budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 30, unit: "days" }],
    contractId: "contract-v2-product",
    criteria: [criterion("criterion-deployment", "deployment-loopback"),
      criterion("criterion-keyboard", "ux-keyboard"),
      criterion("criterion-latency", "nfr-latency"),
      criterion("criterion-login", "requirement-login"),
      criterion("criterion-runtime", "technology-runtime"),
      criterion("criterion-session", "security-session")],
    deploymentRequirements: [requirement("deployment-loopback", ["technology-runtime"])],
    functionalRequirements: [requirement("requirement-login")],
    journeys: [{ criterionIds: ["criterion-login", "criterion-session"],
      journeyId: "journey-login", statement: "A user signs in.", userJobId: "job-access" }],
    lineage: null,
    materialDecisions: [{ decisionId: "decision-stack", options: [
      { optionId: "option-next", statement: "Use Next.js." },
      { optionId: "option-rust", statement: "Use Axum." },
    ], question: "Which qualified profile?", selectedOptionId: "option-next" }],
    negativeScope: [{ scopeId: "scope-native", statement: "No native client." }],
    nonFunctionalRequirements: [requirement("nfr-latency", ["requirement-login"])],
    objectives: [{ objectiveId: "objective-adoption", statement: "Enable first use." }],
    productCompleteDefinition: { criterionIds: [...CRITERIA],
      statement: "Every criterion is independently verified." },
    retiredCriterionIds: [], retiredRequirementIds: [], revisionId: "revision-v2-1",
    securityPrivacyRequirements: [requirement("security-session", ["requirement-login"])],
    sourceDocumentDigests: [PRD_SHA],
    successMetrics: [{ measurement: "Count successful sessions.", metricId: "metric-first-use",
      objectiveIds: ["objective-adoption"], statement: "Users finish.", target: "80 percent." }],
    technologyRequirements: [requirement("technology-runtime")],
    userJobs: [{ job: "Reach the product.", user: "Operator", userJobId: "job-access" }],
    uxAccessibilityRequirements: [requirement("ux-keyboard", ["requirement-login"])],
    ...overrides,
  };
}

afterEach(closeStores);

function boundWorld(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "goal.create");
  const outcome = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Bind the v2 Product Contract source.",
    source: { displayPath: "docs/prd-v2.md", mediaType: "text/markdown", text: PRD },
    title: "Product Contract v2 goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
  return store;
}

function input(payload: unknown): ProposeProductContractRevisionV2Input {
  const revisionId = (payload as { draft?: { revisionId?: unknown } })?.draft?.revisionId;
  return {
    commandId: `command-product-contract-v2-${String(revisionId ?? "malformed")}`,
    correlationId: "correlation-product-contract-v2",
    decidedAt: "2026-08-31T14:00:00.000Z",
    payload,
    principalId: PRINCIPAL,
    projectId: PROJECT_ID,
    targetAggregateId: GOAL_ID,
  };
}

describe("runProductContractProposeRevisionV2", () => {
  it("commits a provenance-bound /2 revision and replays its immutable slot", () => {
    const store = boundWorld();
    const first = runProductContractProposeRevisionV2(
      store, input({ draft: draft(), goalRef: GOAL_ID }),
    );
    expect(first).toMatchObject({ disposition: "DECIDED", ok: true });
    if (!first.ok) throw new Error(`${first.code}@${first.layer}`);
    expect(first.slot.generation).toBe(1);
    expect(first.revision.sourceDocumentDigests).toEqual([PRD_SHA]);

    const replay = runProductContractProposeRevisionV2(
      store, input({ draft: draft(), goalRef: GOAL_ID }),
    );
    expect(replay).toMatchObject({ disposition: "REPLAYED", ok: true });
    if (!replay.ok) throw new Error(`${replay.code}@${replay.layer}`);
    expect(replay.slot).toEqual(first.slot);
  });

  it("forwards the durable PRD provenance fence without restamping", () => {
    const store = boundWorld();
    expect(runProductContractProposeRevisionV2(store, input({
      draft: draft({ sourceDocumentDigests: ["ab".repeat(32)] }), goalRef: GOAL_ID,
    }))).toEqual({
      code: "PRODUCT_CONTRACT_PROVENANCE_DIGEST_MISSING",
      detail: expect.stringContaining("must include the goal's own PRD sha") as string,
      layer: "PRODUCT_CONTRACT_PROVENANCE",
      ok: false,
    });
  });

  it("leaves unresolved product choices to the /2 semantic authority", () => {
    const store = boundWorld();
    const unresolved = [{ decisionId: "decision-stack", options: [
      { optionId: "option-next", statement: "Use Next.js." },
      { optionId: "option-rust", statement: "Use Axum." },
    ], question: "Which qualified profile?", selectedOptionId: null }];
    expect(runProductContractProposeRevisionV2(store, input({
      draft: draft({ materialDecisions: unresolved }), goalRef: GOAL_ID,
    }))).toEqual({
      code: "PRODUCT_CONTRACT_V2_MATERIAL_DECISION_UNRESOLVED",
      layer: "PRODUCT_CONTRACT_V2_SEMANTICS",
      ok: false,
    });
  });

  it("refuses publication while a durable material /2 clarification is open", () => {
    const store = boundWorld();
    const asked = runAskProductContractClarificationV2(store, {
      commandId: "command-open-clarification-v2",
      correlationId: "correlation-open-clarification-v2",
      decidedAt: "2026-08-31T13:59:00.000Z",
      payload: {
        contractId: "contract-v2-product",
        goalRef: GOAL_ID,
        options: [
          { candidateDraft: draft(), label: "Thirty days", optionId: "thirty-days" },
          { candidateDraft: draft({ budgets: [{ budgetId: "budget-delivery", kind: "TIME",
            limit: 45, unit: "days" }] }), label: "Forty-five days", optionId: "forty-five-days" },
        ],
        question: "Which complete delivery budget governs this revision?",
      },
      principalId: PRINCIPAL,
      projectId: PROJECT_ID,
      targetAggregateId: GOAL_ID,
    });
    expect(asked).toMatchObject({ ok: true });

    expect(runProductContractProposeRevisionV2(
      store, input({ draft: draft(), goalRef: GOAL_ID }),
    )).toEqual({
      code: "PRODUCT_CONTRACT_V2_PROPOSE_CLARIFICATION_OPEN",
      layer: "PRODUCT_CONTRACT_V2_PROPOSE",
      ok: false,
    });
  });

  it("admits only the selected candidate, then treats its durable history as satisfied", () => {
    const store = boundWorld();
    const selectionPayload = { contractId: "contract-v2-product", goalRef: GOAL_ID, options: [
      { candidateDraft: draft(), label: "Thirty days", optionId: "thirty-days" },
      { candidateDraft: draft({ budgets: [{ budgetId: "budget-delivery", kind: "TIME",
        limit: 45, unit: "days" }] }), label: "Forty-five days", optionId: "forty-five-days" },
    ], question: "Which complete candidate is authorized for publication?" };
    const asked = runAskProductContractClarificationV2(store, {
      commandId: "command-select-clarification-v2",
      correlationId: "correlation-select-clarification-v2",
      decidedAt: "2026-08-31T13:57:00.000Z",
      payload: selectionPayload,
      principalId: PRINCIPAL, projectId: PROJECT_ID, targetAggregateId: GOAL_ID,
    });
    expect(asked).toMatchObject({ ok: true });
    if (!asked.ok) throw new Error(`${asked.code}@${asked.layer}`);
    expect(runAnswerProductContractClarificationV2(store, {
      commandId: "command-answer-clarification-v2",
      correlationId: "correlation-answer-clarification-v2",
      decidedAt: "2026-08-31T13:58:00.000Z",
      payload: { answerOptionId: "thirty-days", clarificationId: asked.clarificationId,
        contractId: "contract-v2-product" },
      principalId: "human-product-owner", projectId: PROJECT_ID,
      targetAggregateId: productContractClarificationV2AggregateId(
        PROJECT_ID, "contract-v2-product", asked.clarificationId,
      ),
    })).toMatchObject({ ok: true });

    expect(runProductContractProposeRevisionV2(store, input({
      draft: draft({ budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 60,
        unit: "days" }] }), goalRef: GOAL_ID,
    }))).toEqual({ code: "PRODUCT_CONTRACT_V2_PROPOSE_CLARIFICATION_SELECTION_MISMATCH",
      layer: "PRODUCT_CONTRACT_V2_PROPOSE", ok: false });

    const selected = runProductContractProposeRevisionV2(
      store, input({ draft: draft(), goalRef: GOAL_ID }),
    );
    expect(selected).toMatchObject({ ok: true });
    if (!selected.ok) throw new Error(`${selected.code}@${selected.layer}`);
    const successor = runProductContractProposeRevisionV2(store, input({
      draft: draft({ lineage: { parentRevisionDigest: selected.revision.revisionDigest,
        parentRevisionId: selected.revision.revisionId }, revisionId: "revision-v2-2" }),
      goalRef: GOAL_ID,
    }));
    expect(successor).toMatchObject({ ok: true });
    if (!successor.ok) throw new Error(`${successor.code}@${successor.layer}`);
    expect(successor.slot.revisionHistory).toContainEqual(selected.slot.currentRevision);
    expect(runAskProductContractClarificationV2(store, {
      commandId: "command-replay-after-successor-v2",
      correlationId: "correlation-replay-after-successor-v2",
      decidedAt: "2026-08-31T14:02:00.000Z", payload: selectionPayload,
      principalId: PRINCIPAL, projectId: PROJECT_ID, targetAggregateId: GOAL_ID,
    })).toEqual({ code: "PRODUCT_CONTRACT_V2_CLARIFICATION_STATE_INVALID",
      layer: "PRODUCT_CONTRACT_V2_CLARIFICATION", ok: false });
    expect(store.getCommandDecision({ commandId: "command-replay-after-successor-v2",
      principalId: PRINCIPAL, projectId: PROJECT_ID })).toBeNull();
  });

  it("fails closed when durable answers select conflicting outstanding candidates", () => {
    const store = boundWorld();
    for (const [suffix, optionId] of [["first", "thirty-days"],
      ["second", "forty-five-days"]] as const) {
      const asked = runAskProductContractClarificationV2(store, {
        commandId: `command-conflict-${suffix}`,
        correlationId: `correlation-conflict-${suffix}`, decidedAt: "2026-08-31T13:55:00.000Z",
        payload: { contractId: "contract-v2-product", goalRef: GOAL_ID, options: [
          { candidateDraft: draft(), label: "Thirty days", optionId: "thirty-days" },
          { candidateDraft: draft({ budgets: [{ budgetId: "budget-delivery", kind: "TIME",
            limit: 45, unit: "days" }] }), label: "Forty-five days", optionId: "forty-five-days" },
        ], question: `Which candidate is ${suffix} authority?` },
        principalId: PRINCIPAL, projectId: PROJECT_ID, targetAggregateId: GOAL_ID,
      });
      expect(asked).toMatchObject({ ok: true });
      if (!asked.ok) throw new Error(`${asked.code}@${asked.layer}`);
      expect(runAnswerProductContractClarificationV2(store, {
        commandId: `command-conflict-answer-${suffix}`,
        correlationId: `correlation-conflict-answer-${suffix}`,
        decidedAt: "2026-08-31T13:56:00.000Z",
        payload: { answerOptionId: optionId, clarificationId: asked.clarificationId,
          contractId: "contract-v2-product" }, principalId: "human-product-owner",
        projectId: PROJECT_ID, targetAggregateId: productContractClarificationV2AggregateId(
          PROJECT_ID, "contract-v2-product", asked.clarificationId,
        ),
      })).toMatchObject({ ok: true });
    }
    expect(runProductContractProposeRevisionV2(
      store, input({ draft: draft(), goalRef: GOAL_ID }),
    )).toEqual({ code: "PRODUCT_CONTRACT_V2_PROPOSE_CLARIFICATION_STATE_INVALID",
      layer: "PRODUCT_CONTRACT_V2_PROPOSE", ok: false });

    const prior = readProductContractV2WorkflowHead(store, {
      contractId: "contract-v2-product", projectId: PROJECT_ID,
    });
    expect(prior).toMatchObject({ head: { clarificationStatus: "INVALID" }, ok: true });
    if (!prior.ok) return;
    const created = createProductContractRevisionV2(draft());
    if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
    const slot = createProductContractCurrentRevisionSlotV2(PROJECT_ID, created.revision);
    if (!slot.ok) throw new Error(`${slot.code}@${slot.layer}`);
    const revisionBytes = encodeProductContractRevisionV2(created.revision);
    const slotBytes = encodeProductContractCurrentRevisionSlotV2(slot.slot);
    if (!revisionBytes.ok || !slotBytes.ok) throw new Error("impossible history did not encode");
    const commandId = "command-impossible-revision-after-invalid";
    const workflow = Object.freeze({ ...prior.head,
      cause: Object.freeze({ clarificationId: null, commandId, kind: "REVISION" as const,
        revisionRef: slot.slot.currentRevision }),
      clarificationIds: Object.freeze([]), clarificationStatus: "SATISFIED" as const,
      currentRevision: slot.slot.currentRevision, currentSlotDigest: slot.slot.slotDigest,
      currentSlotGeneration: slot.slot.generation, effectiveGateRef: null,
      generation: prior.head.generation + 1 });
    const committed = store.commitExpectedVersionDecisionLegs({
      commandKind: PRODUCT_CONTRACT_REVISION_V2_COMMAND_KIND,
      committedResultBytes: slotBytes.bytes,
      correlationId: "correlation-impossible-revision-after-invalid",
      decidedAt: "2026-08-31T13:57:00.000Z",
      key: { commandId, principalId: PRINCIPAL, projectId: PROJECT_ID },
      legs: [{ aggregateId: deriveProductContractRevisionV2AggregateId(
        PROJECT_ID, created.revision.contractId, created.revision.revisionId,
      ), events: [{ domainSchemaVersion: PRODUCT_CONTRACT_V2_VERSION,
        eventId: `${commandId}-revision`, eventType: PRODUCT_CONTRACT_REVISION_V2_EVENT_TYPE,
        payload: revisionBytes.bytes }], expectedVersion: 0 }, {
        aggregateId: deriveProductContractCurrentRevisionSlotV2AggregateId(
          PROJECT_ID, created.revision.contractId,
        ), events: [{ domainSchemaVersion: PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION,
          eventId: `${commandId}-slot`, eventType: PRODUCT_CONTRACT_CURRENT_SLOT_V2_EVENT_TYPE,
          payload: slotBytes.bytes }], expectedVersion: 0 }, {
        aggregateId: deriveProductContractV2WorkflowAggregateId(
          PROJECT_ID, created.revision.contractId,
        ), events: [{ domainSchemaVersion: PRODUCT_CONTRACT_V2_WORKFLOW_VERSION,
          eventId: `${commandId}-workflow`, eventType: PRODUCT_CONTRACT_V2_WORKFLOW_EVENT_TYPE,
          payload: encodeProductContractV2WorkflowHead(workflow) }],
        expectedVersion: prior.head.generation }],
      requestBytes: revisionBytes.bytes,
    });
    expect(committed.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
    expect(readProductContractV2WorkflowHead(store, {
      contractId: created.revision.contractId, projectId: PROJECT_ID,
    })).toEqual({ code: "PRODUCT_CONTRACT_V2_WORKFLOW_INVALID",
      layer: "PRODUCT_CONTRACT_V2_WORKFLOW", ok: false });
  });

  it("binds the target goal and author to authenticated server facts", () => {
    const store = boundWorld();
    expect(runProductContractProposeRevisionV2(store, {
      ...input({ draft: draft(), goalRef: GOAL_ID }),
      targetAggregateId: "another-goal",
    })).toEqual({
      code: "PRODUCT_CONTRACT_V2_PROPOSE_TARGET_MISMATCH",
      layer: "PRODUCT_CONTRACT_V2_PROPOSE",
      ok: false,
    });
    expect(runProductContractProposeRevisionV2(store, input({
      draft: draft({ authorRef: "another-principal" }), goalRef: GOAL_ID,
    }))).toEqual({
      code: "PRODUCT_CONTRACT_V2_PROPOSE_AUTHOR_MISMATCH",
      layer: "PRODUCT_CONTRACT_V2_PROPOSE",
      ok: false,
    });
  });

  it("refuses every inexact ingress shape before provenance or storage", () => {
    const store = boundWorld();
    for (const payload of [null, [], "x", {}, { draft: draft() },
      { draft: draft(), extra: true, goalRef: GOAL_ID },
      { draft: "not-an-object", goalRef: GOAL_ID }]) {
      expect(runProductContractProposeRevisionV2(store, input(payload))).toEqual({
        code: "PRODUCT_CONTRACT_V2_PROPOSE_MALFORMED",
        layer: "PRODUCT_CONTRACT_V2_PROPOSE",
        ok: false,
      });
    }
  });
});
