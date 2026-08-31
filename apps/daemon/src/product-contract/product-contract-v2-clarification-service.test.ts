import { createHash } from "node:crypto";

import { assessProductContractClarificationMaterialityV2 } from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_CREATE_COMMAND_ID, GOAL_ID, PROJECT_ID, closeStores, driveThrough,
  envelope, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { runAskClarification } from "./product-contract-clarification-service.js";
import {
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_EVENT_TYPE,
  deriveProductContractClarificationV2Id,
  productContractClarificationV2AggregateId,
  productContractClarificationV2AskCommandId,
  productContractClarificationV2AskRequestBytes,
} from "./product-contract-v2-clarification-contract.js";
import { readProductContractClarificationV2 }
  from "./product-contract-v2-clarification-reader.js";
import { readProductContractClarificationV2Row }
  from "./product-contract-v2-clarification-row.js";
import { validateProductContractClarificationV2Provenance }
  from "./product-contract-v2-clarification-provenance.js";
import { commitProductContractClarificationV2Row }
  from "./product-contract-v2-clarification-writer.js";
import { runProductContractProposeRevisionV2 }
  from "./product-contract-v2-propose-service.js";
import { readProductContractClarificationV2Authority }
  from "./product-contract-v2-clarification-authority.js";

const service = await import("./product-contract-v2-clarification-service.js").catch(
  () => Object.freeze({}) as Record<string, unknown>,
);

type Input = Readonly<{
  correlationId: string; decidedAt: string; payload: unknown; principalId: string; projectId: string;
  targetAggregateId: string;
}>;
type Result = Readonly<Record<string, unknown>>;
type Run = (store: SqliteEventStore, input: Input) => Result;
type Row = Readonly<Record<string, unknown>>;
type Rows = (store: SqliteEventStore, projectId: string, contractId: string) => readonly Row[];

const runAsk = service["runAskProductContractClarificationV2"] as Run | undefined;
const runAnswer = service["runAnswerProductContractClarificationV2"] as Run | undefined;
const rowsFor = service["productContractClarificationsV2ForContract"] as Rows | undefined;
const aggregateIdOf = service["productContractClarificationV2AggregateId"] as
  ((projectId: string, contractId: string, clarificationId: string) => string) | undefined;
const openReader = service["createProductContractClarificationV2OpenReader"] as
  ((store: SqliteEventStore, projectId: string) => {
    openMaterialClarificationIds(contractId: string): readonly string[];
  }) | undefined;

const CONTRACT_ID = "contract-clarification-v2";
const PRD = "# Clarification v2\n\nChoose the exact verified product candidate.\n";
const PRD_SHA = createHash("sha256").update(PRD, "utf8").digest("hex");
const hex = (digit: string): string => digit.repeat(64);
const requirement = (requirementId: string, dependencies: readonly string[] = []) => ({
  dependsOnRequirementIds: [...dependencies], priority: "MUST" as const, requirementId,
  statement: `${requirementId} must hold.`, supersedesRequirementId: null,
});
const criterion = (criterionId: string, requirementId: string) => ({
  criterionId, requirementId, statement: `${criterionId} is observable.`,
  supersedesCriterionId: null, verification: `Run deterministic ${criterionId} verification.`,
});
const CRITERIA = Object.freeze([
  "criterion-deployment", "criterion-keyboard", "criterion-latency",
  "criterion-login", "criterion-runtime", "criterion-session",
]);

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assumptions: [{ assumptionId: "assumption-browser", statement: "A browser exists.",
      validationCriterionId: "criterion-runtime" }],
    authorRef: "agent-product-v2",
    budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 30, unit: "days" }],
    contractId: CONTRACT_ID,
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
    retiredCriterionIds: [], retiredRequirementIds: [], revisionId: "revision-v2-choice",
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

function askPayload(): Record<string, unknown> {
  return {
    contractId: CONTRACT_ID,
    goalRef: GOAL_ID,
    options: [
      { candidateDraft: candidate({ budgets: [{ budgetId: "budget-delivery", kind: "TIME",
        limit: 45, unit: "days" }] }), label: "Forty-five days", optionId: "a-option" },
      { candidateDraft: candidate(), label: "Thirty days", optionId: "Z-option" },
    ],
    question: "Which complete v2 product definition should govern delivery?",
  };
}

function input(payload: unknown, principalId = "agent-product-v2", suffix = "ask"): Input {
  return {
    correlationId: `correlation-v2-${suffix}`,
    decidedAt: suffix === "ask" ? "2026-08-31T15:00:00.000Z" : "2026-08-31T15:01:00.000Z",
    payload, principalId, projectId: PROJECT_ID, targetAggregateId: GOAL_ID,
  };
}

function answerInput(payload: unknown, principalId = "human-one", suffix = "answer"): Input {
  const record = payload as Readonly<{ clarificationId: string; contractId: string }>;
  return { ...input(payload, principalId, suffix), targetAggregateId:
    productContractClarificationV2AggregateId(
      PROJECT_ID, record.contractId, record.clarificationId,
    ) };
}

function boundStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "goal.create");
  const outcome = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Bind clarification candidates to the durable source.",
    source: { displayPath: "docs/clarification-v2.md", mediaType: "text/markdown", text: PRD },
    title: "Clarification v2 goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
  return store;
}

function requireFunctions(): { ask: Run; answer: Run; rows: Rows } {
  expect(typeof runAsk).toBe("function");
  expect(typeof runAnswer).toBe("function");
  expect(typeof rowsFor).toBe("function");
  if (runAsk === undefined || runAnswer === undefined || rowsFor === undefined) {
    return { ask: () => ({ ok: false }), answer: () => ({ ok: false }), rows: () => [] };
  }
  return { ask: runAsk, answer: runAnswer, rows: rowsFor };
}

function askedWorld(): { clarificationId: string; store: SqliteEventStore } {
  const store = boundStore();
  const { ask } = requireFunctions();
  const result = ask(store, input(askPayload()));
  if (!result["ok"]) throw new Error(`ask fixture refused: ${String(result["code"])}`);
  return { clarificationId: String(result["clarificationId"]), store };
}

function admittedRow(overrides: Record<string, unknown> = {}): {
  readonly clarificationId: string; readonly row: Parameters<
    typeof commitProductContractClarificationV2Row
  >[3]["row"];
} {
  const question = "Which exact candidate is authorized by the human answer?";
  const materiality = assessProductContractClarificationMaterialityV2({
    options: askPayload()["options"], question,
  });
  if (!materiality.ok) throw new Error(`${materiality.code}@${materiality.layer}`);
  const clarificationId = deriveProductContractClarificationV2Id(
    GOAL_ID, materiality.sharedIdentity, question, materiality.optionDigests,
  );
  return { clarificationId, row: Object.freeze({
    answerDecision: null,
    askDecision: Object.freeze({ correlationId: "correlation-v2-row",
      decidedAt: "2026-08-31T15:01:00.000Z", principalId: "agent-product-v2" }),
    clarificationId, contractId: CONTRACT_ID, goalRef: GOAL_ID,
    optionDigests: materiality.optionDigests, question,
    schemaVersion: "moe-product-contract-clarification/2",
    sharedIdentity: materiality.sharedIdentity,
    ...overrides,
  }) };
}

afterEach(closeStores);

describe("Product Contract /2 durable clarification", () => {
  it("records the canonical material ask with v2 provenance and a distinct event namespace", () => {
    const { clarificationId, store } = askedWorld();
    const { rows } = requireFunctions();
    const row = rows(store, PROJECT_ID, CONTRACT_ID)[0];
    expect(clarificationId).toMatch(/^clar-v2-[0-9a-f]{64}$/u);
    expect(typeof aggregateIdOf).toBe("function");
    if (aggregateIdOf === undefined) return;
    const aggregateId = aggregateIdOf(PROJECT_ID, CONTRACT_ID, clarificationId);
    const stored = JSON.parse(new TextDecoder().decode(store.readEvents(aggregateId)[0]!.payload));
    const decoded = readProductContractClarificationV2Row(stored);
    expect(decoded).not.toBeNull();
    if (decoded !== null) {
      expect(validateProductContractClarificationV2Provenance(
        store, PROJECT_ID, aggregateId, decoded,
      )).toEqual({ kind: "VALID" });
    }
    expect(row).toMatchObject({
      answerDecision: null,
      askDecision: {
        correlationId: "correlation-v2-ask", decidedAt: "2026-08-31T15:00:00.000Z",
        principalId: "agent-product-v2",
      },
      clarificationId,
      contractId: CONTRACT_ID,
      goalRef: GOAL_ID,
      question: "Which complete v2 product definition should govern delivery?",
      schemaVersion: "moe-product-contract-clarification/2",
    });
    const options = row?.["optionDigests"] as readonly Record<string, unknown>[];
    expect(options.map((option) => option["optionId"])).toEqual(["Z-option", "a-option"]);
    expect(options.map((option) => option["projectionDigest"])).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/u), expect.stringMatching(/^[0-9a-f]{64}$/u),
    ]);
    expect(options.map((option) => option["revisionDigest"])).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/u), expect.stringMatching(/^[0-9a-f]{64}$/u),
    ]);
    expect(aggregateId).toMatch(/^product-contract-clarification-v2:[0-9a-f]{64}$/u);
    expect(store.readEvents(aggregateId)).toMatchObject([{
      domainSchemaVersion: "moe-product-contract-clarification/2",
      eventType: "ProductContractClarificationV2Asked",
    }]);
  });

  it("replays the canonical re-ask without replacing first-ask provenance", () => {
    const { clarificationId, store } = askedWorld();
    const { ask, rows } = requireFunctions();
    const reordered = askPayload();
    (reordered["options"] as unknown[]).reverse();
    expect(ask(store, input(reordered, "agent-product-v2", "reask"))).toEqual({
      clarificationId, disposition: "REPLAYED", ok: true,
    });
    expect(rows(store, PROJECT_ID, CONTRACT_ID)).toHaveLength(1);
    expect(rows(store, PROJECT_ID, CONTRACT_ID)[0]?.["askDecision"]).toEqual({
      correlationId: "correlation-v2-ask", decidedAt: "2026-08-31T15:00:00.000Z",
      principalId: "agent-product-v2",
    });
  });

  it("accepts an option id, derives its digest, and makes the first human answer final", () => {
    const { clarificationId, store } = askedWorld();
    const { answer, rows } = requireFunctions();
    const first = answer(store, answerInput({
      answerOptionId: "Z-option", clarificationId, contractId: CONTRACT_ID,
    }, "human-one", "answer"));
    expect(first).toEqual({ clarificationId, disposition: "DECIDED", ok: true });
    const row = rows(store, PROJECT_ID, CONTRACT_ID)[0];
    const selected = (row?.["optionDigests"] as readonly Record<string, unknown>[])[0];
    expect(row?.["answerDecision"]).toEqual({
      answeredAt: "2026-08-31T15:01:00.000Z",
      correlationId: "correlation-v2-answer",
      optionId: "Z-option",
      principalId: "human-one",
      projectionDigest: selected?.["projectionDigest"],
      revisionDigest: selected?.["revisionDigest"],
    });
    expect(answer(store, answerInput({
      answerOptionId: "Z-option", clarificationId, contractId: CONTRACT_ID,
    }, "human-two", "answer"))).toEqual({
      clarificationId, disposition: "REPLAYED", ok: true,
    });
    expect(answer(store, answerInput({
      answerOptionId: "a-option", clarificationId, contractId: CONTRACT_ID,
    }, "human-three", "answer"))).toEqual({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_ALREADY_ANSWERED",
      layer: "PRODUCT_CONTRACT_V2_CLARIFICATION",
      ok: false,
    });
    expect(rows(store, PROJECT_ID, CONTRACT_ID)[0]?.["answerDecision"]).toEqual(
      row?.["answerDecision"],
    );
  });

  it("rejects caller-supplied digest authority and unknown options", () => {
    const { clarificationId, store } = askedWorld();
    const { answer } = requireFunctions();
    expect(answer(store, answerInput({
      answerProjectionDigest: hex("f"), clarificationId, contractId: CONTRACT_ID,
    }, "human-one", "answer"))).toEqual({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_MALFORMED",
      layer: "PRODUCT_CONTRACT_V2_CLARIFICATION",
      ok: false,
    });
    expect(answer(store, answerInput({
      answerOptionId: "not-recorded", clarificationId, contractId: CONTRACT_ID,
    }, "human-one", "answer"))).toMatchObject({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_ANSWER_UNKNOWN_OPTION", ok: false,
    });
  });

  it("rejects a goal-level ANSWER target even when the question belongs to that goal", () => {
    const { clarificationId, store } = askedWorld();
    const { answer } = requireFunctions();
    expect(answer(store, input({ answerOptionId: "Z-option", clarificationId,
      contractId: CONTRACT_ID }, "human-one", "answer"))).toEqual({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_TARGET_MISMATCH",
      layer: "PRODUCT_CONTRACT_V2_CLARIFICATION", ok: false,
    });
    expect(readProductContractClarificationV2(
      store, PROJECT_ID, CONTRACT_ID, clarificationId,
    )).toMatchObject({ kind: "PRESENT", row: { answerDecision: null } });
  });

  it("serves only unanswered /2 rows through the proposal-fence port", () => {
    const { clarificationId, store } = askedWorld();
    expect(typeof openReader).toBe("function");
    if (openReader === undefined) return;
    const reader = openReader(store, PROJECT_ID);

    // A real /1 row with the same contract cannot satisfy or contaminate `/2`.
    const v1 = runAskClarification(store, input({
      contractId: CONTRACT_ID,
      options: [
        { label: "Email", optionId: "email", projection: { criteria: [{ criterionId: "c1",
          requirementId: "r1", statement: "Email login.", supersedesCriterionId: null }],
          requirements: [{ requirementId: "r1", statement: "Login.",
            supersedesRequirementId: null }] } },
        { label: "SSO", optionId: "sso", projection: { criteria: [{ criterionId: "c1",
          requirementId: "r1", statement: "SSO login.", supersedesCriterionId: null }],
          requirements: [{ requirementId: "r1", statement: "Login.",
            supersedesRequirementId: null }] } },
      ],
      question: "Which v1 login?",
    }, "legacy-agent"));
    expect(v1.ok).toBe(true);
    expect(reader.openMaterialClarificationIds(CONTRACT_ID)).toEqual([clarificationId]);

    const { answer } = requireFunctions();
    expect(answer(store, answerInput({
      answerOptionId: "Z-option", clarificationId, contractId: CONTRACT_ID,
    }, "human-one", "answer"))).toMatchObject({ ok: true });
    expect(reader.openMaterialClarificationIds(CONTRACT_ID)).toEqual([]);
  });

  it("publishes exact OPEN, ANSWERED_PENDING, and SATISFIED authority states", () => {
    const { clarificationId, store } = askedWorld();
    expect(readProductContractClarificationV2Authority(store, {
      contractId: CONTRACT_ID, goalRef: GOAL_ID, projectId: PROJECT_ID,
    })).toEqual({ clarificationIds: [clarificationId], status: "OPEN" });
    const { answer, rows } = requireFunctions();
    expect(answer(store, answerInput({ answerOptionId: "Z-option", clarificationId,
      contractId: CONTRACT_ID }, "human-one", "answer"))).toMatchObject({ ok: true });
    const row = rows(store, PROJECT_ID, CONTRACT_ID)[0]!;
    const option = (row["optionDigests"] as readonly Record<string, string>[])[0]!;
    expect(readProductContractClarificationV2Authority(store, {
      contractId: CONTRACT_ID, goalRef: GOAL_ID, projectId: PROJECT_ID,
    })).toEqual({ selection: { clarificationId, contractId: CONTRACT_ID, goalRef: GOAL_ID,
      optionId: "Z-option", projectionDigest: option["projectionDigest"],
      revisionDigest: option["revisionDigest"], revisionId: "revision-v2-choice" },
    status: "ANSWERED_PENDING" });
    expect(runProductContractProposeRevisionV2(store, {
      ...input({ draft: candidate(), goalRef: GOAL_ID }), principalId: "agent-product-v2",
    })).toMatchObject({ ok: true });
    expect(readProductContractClarificationV2Authority(store, {
      contractId: CONTRACT_ID, goalRef: GOAL_ID, projectId: PROJECT_ID,
    })).toEqual({ status: "SATISFIED" });
  });

  it("forwards materiality refusals without writing a row", () => {
    const store = openStore();
    const { ask, rows } = requireFunctions();
    const identical = askPayload();
    const options = identical["options"] as Record<string, unknown>[];
    options[0]!["candidateDraft"] = structuredClone(options[1]!["candidateDraft"]);
    expect(ask(store, input(identical))).toEqual({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_IMMATERIAL",
      layer: "PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY",
      ok: false,
    });
    expect(rows(store, PROJECT_ID, CONTRACT_ID)).toEqual([]);
  });

  it("refuses hostile proxy and inexact payloads before durable work", () => {
    const store = openStore();
    const { ask } = requireFunctions();
    for (const payload of [null, {}, { ...askPayload(), extra: true }, new Proxy(askPayload(), {})]) {
      expect(ask(store, input(payload))).toEqual({
        code: "PRODUCT_CONTRACT_V2_CLARIFICATION_MALFORMED",
        layer: "PRODUCT_CONTRACT_V2_CLARIFICATION",
        ok: false,
      });
    }
    expect(store.readCommandDecisionsAfter(0n, 20).items).toEqual([]);
  });

  it("returns only a fail-closed sentinel when any durable /2 row is corrupt", () => {
    const { clarificationId, store } = askedWorld();
    expect(typeof openReader).toBe("function");
    if (openReader === undefined) return;
    const corruptAggregateId = `product-contract-clarification-v2:${"f".repeat(64)}`;
    const corruptBytes = new TextEncoder().encode(JSON.stringify({
      clarificationId: `clar-v2-${"e".repeat(64)}`,
      contractId: CONTRACT_ID,
      schemaVersion: "moe-product-contract-clarification/2",
    }));
    const planted = store.commitExpectedVersionDecision({
      commandKind: "product_contract.ask_clarification",
      committedResultBytes: corruptBytes,
      correlationId: "correlation-corrupt-v2",
      decidedAt: "2026-08-31T15:02:00.000Z",
      events: [{ domainSchemaVersion: "moe-product-contract-clarification/2",
        eventId: "corrupt-v2-event", eventType: "ProductContractClarificationV2Asked",
        payload: corruptBytes }],
      expectedVersion: 0,
      key: { commandId: "corrupt-v2-command", principalId: "hostile-writer",
        projectId: PROJECT_ID },
      requestBytes: corruptBytes,
      targetAggregateId: corruptAggregateId,
    });
    expect(planted.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
    const roster = openReader(store, PROJECT_ID).openMaterialClarificationIds(CONTRACT_ID);
    expect(roster).toEqual(["product-contract-v2-clarification-state-invalid"]);
    expect(roster).not.toContain(clarificationId);
    expect(rowsFor?.(store, PROJECT_ID, CONTRACT_ID)).toEqual([]);
    expect(readProductContractClarificationV2Authority(store, {
      contractId: CONTRACT_ID, goalRef: GOAL_ID, projectId: PROJECT_ID,
    })).toEqual({ code: "PRODUCT_CONTRACT_V2_CLARIFICATION_AUTHORITY_INVALID",
      layer: "PRODUCT_CONTRACT_V2_CLARIFICATION_AUTHORITY", status: "INVALID" });
  });

  it("refuses target, author, source, and current-lineage forgery before writing", () => {
    const targetStore = boundStore();
    const { ask, rows } = requireFunctions();
    expect(ask(targetStore, { ...input(askPayload()), targetAggregateId: "another-goal" }))
      .toMatchObject({ code: "PRODUCT_CONTRACT_V2_CLARIFICATION_TARGET_MISMATCH", ok: false });
    expect(rows(targetStore, PROJECT_ID, CONTRACT_ID)).toEqual([]);

    const authorStore = boundStore();
    expect(ask(authorStore, input(askPayload(), "forged-author"))).toMatchObject({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_AUTHOR_MISMATCH", ok: false,
    });
    expect(rows(authorStore, PROJECT_ID, CONTRACT_ID)).toEqual([]);

    const sourceStore = boundStore();
    const forgedSource = askPayload();
    for (const option of forgedSource["options"] as Record<string, unknown>[]) {
      option["candidateDraft"] = { ...(option["candidateDraft"] as Record<string, unknown>),
        sourceDocumentDigests: [hex("f")] };
    }
    expect(ask(sourceStore, input(forgedSource))).toEqual({
      code: "PRODUCT_CONTRACT_PROVENANCE_DIGEST_MISSING",
      layer: "PRODUCT_CONTRACT_PROVENANCE", ok: false,
    });
    expect(rows(sourceStore, PROJECT_ID, CONTRACT_ID)).toEqual([]);

    const currentStore = boundStore();
    const committed = runProductContractProposeRevisionV2(currentStore, {
      ...input({ draft: candidate(), goalRef: GOAL_ID }), principalId: "agent-product-v2",
    });
    expect(committed).toMatchObject({ ok: true });
    const excludesCurrent = askPayload();
    const candidates = excludesCurrent["options"] as Record<string, unknown>[];
    candidates[1]!["candidateDraft"] = candidate({ budgets: [{ budgetId: "budget-delivery",
      kind: "TIME", limit: 60, unit: "days" }] });
    expect(ask(currentStore, input(excludesCurrent))).toMatchObject({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_CURRENT_MISMATCH", ok: false,
    });
    expect(rows(currentStore, PROJECT_ID, CONTRACT_ID)).toEqual([]);
  });

  it("rejects non-derived ids, forged decision keys, and correlation claims", () => {
    const nonDerivedStore = boundStore();
    const admitted = admittedRow({ clarificationId: `clar-v2-${hex("f")}` });
    const nonDerivedAggregate = productContractClarificationV2AggregateId(
      PROJECT_ID, CONTRACT_ID, admitted.row.clarificationId,
    );
    expect(commitProductContractClarificationV2Row(
      nonDerivedStore, input({}, "agent-product-v2", "row"), nonDerivedAggregate, {
        commandId: productContractClarificationV2AskCommandId(
          PROJECT_ID, CONTRACT_ID, admitted.row.clarificationId,
        ), commandKind: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
        eventType: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_EVENT_TYPE, expectedVersion: 0,
        requestBytes: productContractClarificationV2AskRequestBytes(admitted.row), row: admitted.row,
      },
    )).toBe("DECIDED");
    expect(readProductContractClarificationV2(
      nonDerivedStore, PROJECT_ID, CONTRACT_ID, admitted.row.clarificationId,
    )).toMatchObject({ kind: "INVALID" });

    const correlationStore = boundStore();
    const correlation = admittedRow();
    const correlationAggregate = productContractClarificationV2AggregateId(
      PROJECT_ID, CONTRACT_ID, correlation.clarificationId,
    );
    expect(commitProductContractClarificationV2Row(correlationStore, {
      ...input({}, "agent-product-v2", "row"), correlationId: "forged-correlation",
    }, correlationAggregate, {
      commandId: productContractClarificationV2AskCommandId(
        PROJECT_ID, CONTRACT_ID, correlation.clarificationId,
      ), commandKind: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
      eventType: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_EVENT_TYPE, expectedVersion: 0,
      requestBytes: productContractClarificationV2AskRequestBytes(correlation.row),
      row: correlation.row,
    })).toBe("DECIDED");
    expect(readProductContractClarificationV2(
      correlationStore, PROJECT_ID, CONTRACT_ID, correlation.clarificationId,
    )).toMatchObject({ kind: "INVALID" });

    const keyStore = boundStore();
    const keyed = admittedRow();
    const keyedAggregate = productContractClarificationV2AggregateId(
      PROJECT_ID, CONTRACT_ID, keyed.clarificationId,
    );
    const expectedCommandId = productContractClarificationV2AskCommandId(
      PROJECT_ID, CONTRACT_ID, keyed.clarificationId,
    );
    const bytes = new TextEncoder().encode(JSON.stringify(keyed.row));
    keyStore.commitExpectedVersionDecision({ commandKind: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
      committedResultBytes: bytes, correlationId: keyed.row.askDecision.correlationId,
      decidedAt: keyed.row.askDecision.decidedAt,
      events: [{ domainSchemaVersion: "moe-product-contract-clarification/2",
        eventId: `${expectedCommandId}-event`, eventType: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_EVENT_TYPE,
        payload: bytes }], expectedVersion: 0,
      key: { commandId: "forged-command-key", principalId: keyed.row.askDecision.principalId,
        projectId: PROJECT_ID },
      requestBytes: productContractClarificationV2AskRequestBytes(keyed.row),
      targetAggregateId: keyedAggregate });
    expect(readProductContractClarificationV2(
      keyStore, PROJECT_ID, CONTRACT_ID, keyed.clarificationId,
    )).toMatchObject({ kind: "INVALID" });
  });

  it("rejects self-consistent low-level rows that bypass author or source admission", () => {
    for (const kind of ["AUTHOR", "EMPTY_SOURCES", "UNBOUND_SOURCE"] as const) {
      const store = boundStore();
      const admitted = admittedRow();
      const sharedIdentity = Object.freeze({ ...admitted.row.sharedIdentity,
        ...(kind === "AUTHOR" ? { authorRef: "forged-author" }
          : { sourceDocumentDigests: Object.freeze(
            kind === "EMPTY_SOURCES" ? [] : [hex("f")],
          ) }) });
      const clarificationId = deriveProductContractClarificationV2Id(
        GOAL_ID, sharedIdentity, admitted.row.question, admitted.row.optionDigests,
      );
      const row = Object.freeze({ ...admitted.row, clarificationId, sharedIdentity });
      const aggregateId = productContractClarificationV2AggregateId(
        PROJECT_ID, CONTRACT_ID, clarificationId,
      );
      expect(commitProductContractClarificationV2Row(
        store, input({}, "agent-product-v2", "row"), aggregateId, {
          commandId: productContractClarificationV2AskCommandId(
            PROJECT_ID, CONTRACT_ID, clarificationId,
          ), commandKind: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
          eventType: PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_EVENT_TYPE, expectedVersion: 0,
          requestBytes: productContractClarificationV2AskRequestBytes(row), row,
        },
      )).toBe("DECIDED");
      expect(readProductContractClarificationV2(
        store, PROJECT_ID, CONTRACT_ID, clarificationId,
      )).toMatchObject({ kind: "INVALID" });
    }
  });

  it("classifies malformed ids before I/O and durable read failure as unreadable", () => {
    const store = boundStore();
    store.close();
    const { answer } = requireFunctions();
    expect(answer(store, answerInput({ answerOptionId: "Z-option", clarificationId: "clar-v2-bad",
      contractId: CONTRACT_ID }, "human", "answer"))).toEqual({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_MALFORMED",
      layer: "PRODUCT_CONTRACT_V2_CLARIFICATION", ok: false,
    });
    expect(readProductContractClarificationV2(
      store, PROJECT_ID, CONTRACT_ID, `clar-v2-${hex("a")}`,
    )).toEqual({ code: "STORE_CLOSED", kind: "UNREADABLE", layer: "DURABLE_STORE" });
    expect(readProductContractClarificationV2Authority(store, {
      contractId: CONTRACT_ID, goalRef: GOAL_ID, projectId: PROJECT_ID,
    })).toEqual({ code: "STORE_CLOSED", layer: "DURABLE_STORE", status: "UNREADABLE" });
  });

  it("never exposes clarification state across project boundaries", () => {
    const { store } = askedWorld();
    expect(typeof openReader).toBe("function");
    if (openReader === undefined || rowsFor === undefined) return;
    expect(openReader(store, "another-project").openMaterialClarificationIds(CONTRACT_ID))
      .toEqual([]);
    expect(rowsFor(store, "another-project", CONTRACT_ID)).toEqual([]);
  });
});
