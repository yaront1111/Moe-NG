import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";

import { SQLITE_SCHEMA_MANIFEST_VERSION, SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { fixtureDependencies } from "../daemon-entry-fixtures.js";
import { startDaemon } from "../daemon-entry.js";
import { createDaemonV2CommandPorts } from "../daemon-v2-command-registry.js";
import {
  GOAL_CREATE_COMMAND_ID, GOAL_ID, PROJECT_ID, closeStores, driveThrough, envelope,
  openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import {
  CUTOVER_ACTIVATION_MARKER_EVENT_TYPE, composeCutoverActivationMarker,
  deriveCutoverActivationMarkerAggregateId, encodeCutoverActivationMarker,
} from "../cutover/cutover-activation-marker.js";
import {
  V2_READINESS_MANIFEST_EVENT_TYPE, V2_READINESS_MANIFEST_SCHEMA_VERSION,
  deriveV2ReadinessManifestAggregateId, digestV2ReadinessManifest,
  encodeV2ReadinessManifest,
} from "../cutover/v2-readiness-manifest.js";
import { V2_SURFACE_MANIFEST_SHA256 } from "../cutover/v2-surface-manifest.js";
import { createGoalSourceReadPort } from "../documents/document-source-full-read.js";
import { productContractGate1Authority }
  from "@moe/core";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, deriveProductContractGate1AggregateId,
  productContractGate1SubjectDigest,
} from "../product-contract/product-contract-gate-1-contract.js";
import { productContractClarificationV2AggregateId }
  from "../product-contract/product-contract-v2-clarification-contract.js";
import { runAnswerProductContractClarificationV2, runAskProductContractClarificationV2 }
  from "../product-contract/product-contract-v2-clarification-service.js";
import { commitProductContractRevisionV2 }
  from "../product-contract/product-contract-v2-store.js";
import { deriveProductContractV2GoalBindingAggregateId }
  from "../product-contract/product-contract-v2-goal-binding-contract.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { GOOD_CREDENTIAL, authenticator } from "./http-test-fixtures.js";
import {
  PRODUCT_CONTRACT_V2_PENDING_READ_CODES,
  PRODUCT_CONTRACT_V2_PENDING_READ_PATH,
  createProductContractV2PendingReadPort,
  handleProductContractV2PendingReadRequest,
  type ProductContractV2PendingView,
} from "./product-contract-v2-pending-read.js";

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
async function postJson(
  daemon: Readonly<{ origin: string; port: number }>, csrfToken: string,
  path: string, value: unknown,
): Promise<Readonly<{ body: unknown; status: number }>> {
  const payload = JSON.stringify(value);
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: {
        "content-length": Buffer.byteLength(payload), "content-type": "application/json",
        host: `127.0.0.1:${daemon.port}`, origin: daemon.origin, "x-moe-csrf": csrfToken,
        "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
        "x-moe-session-credential": GOOD_CREDENTIAL,
      },
      host: "127.0.0.1", method: "POST", path, port: daemon.port, setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        status: response.statusCode ?? 0,
      }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}
const PRD = "# Product /2 pending\n\nChoose the complete product definition.\n";
const CONTRACT_ID = "contract-v2-pending";
const AUTHOR = "agent-product-v2";
const hex = (digit: string): string => digit.repeat(64);
const requirement = (requirementId: string, dependencies: readonly string[] = []) => ({
  dependsOnRequirementIds: [...dependencies], priority: "MUST" as const, requirementId,
  statement: `${requirementId} must hold.`, supersedesRequirementId: null,
});
const criterion = (criterionId: string, requirementId: string) => ({
  criterionId, requirementId, statement: `${criterionId} is observable.`,
  supersedesCriterionId: null, verification: `Run deterministic ${criterionId} verification.`,
});
const CRITERIA = ["criterion-deployment", "criterion-keyboard", "criterion-latency",
  "criterion-login", "criterion-runtime", "criterion-session"];

function draft(sourceDigest: string, overrides: Record<string, unknown> = {}) {
  return {
    assumptions: [{ assumptionId: "assumption-browser", statement: "A browser exists.",
      validationCriterionId: "criterion-runtime" }],
    authorRef: AUTHOR,
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
    sourceDocumentDigests: [sourceDigest],
    successMetrics: [{ measurement: "Count successful sessions.", metricId: "metric-first-use",
      objectiveIds: ["objective-adoption"], statement: "Users finish.", target: "80 percent." }],
    technologyRequirements: [requirement("technology-runtime")],
    userJobs: [{ job: "Reach the product.", user: "Operator", userJobId: "job-access" }],
    uxAccessibilityRequirements: [requirement("ux-keyboard", ["requirement-login"])],
    ...overrides,
  };
}

function commitEvent(store: SqliteEventStore, aggregateId: string, commandId: string,
eventType: string, schemaVersion: string, payload: Uint8Array, expectedVersion = 0): void {
  store.commit({ aggregateId, commandBytes: payload, commandId,
    committedAt: "2026-08-31T17:00:00.000Z", events: [{ domainSchemaVersion: schemaVersion,
      eventId: `${commandId}-event`, eventType, payload }], expectedVersion });
}

function activateV2(store: SqliteEventStore): void {
  const sourceCommit = "a".repeat(40);
  const generations = { backupGenerationDigest: hex("1"),
    distributionManifestSha256: hex("2"), importGenerationSha256: hex("3"),
    quiesceRecordSha256: hex("4") };
  const readiness = { acceptanceEvidenceSha256: hex("5"), backupEvidenceSha256: hex("6"),
    ...generations, contractSchemaSha256: hex("7"),
    deliveryProfileQualificationEvidenceSha256: hex("8"), restoreDrillSha256: hex("9"),
    schemaVersion: V2_READINESS_MANIFEST_SCHEMA_VERSION, securityEvidenceSha256: hex("a"),
    sourceCommit, storeMigrationEvidenceSha256: hex("b"),
    storeSchemaVersion: SQLITE_SCHEMA_MANIFEST_VERSION,
    surfaceManifestSha256: V2_SURFACE_MANIFEST_SHA256,
    windowsPackagingEvidenceSha256: hex("c") };
  commitEvent(store, deriveV2ReadinessManifestAggregateId(PROJECT_ID), "readiness-v2",
    V2_READINESS_MANIFEST_EVENT_TYPE, V2_READINESS_MANIFEST_SCHEMA_VERSION,
    encodeV2ReadinessManifest(readiness));
  const composed = composeCutoverActivationMarker({ activatedAtEpochMs: 1, generations,
    readinessManifestSha256: digestV2ReadinessManifest(readiness), readinessManifestVersion: 1,
    sourceCommit, sourceState: "ACTIVATE_APPROVED" });
  if (!composed.ok) throw new Error("activation marker fixture refused");
  commitEvent(store, deriveCutoverActivationMarkerAggregateId(PROJECT_ID), "activation-v2",
    CUTOVER_ACTIVATION_MARKER_EVENT_TYPE, composed.marker.schemaVersion,
    encodeCutoverActivationMarker(composed.marker));
}

function world() {
  const store = openStore();
  driveThrough(store, "goal.create");
  const bound = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Build the complete v2 product.",
    source: { displayPath: "docs/product-v2.md", mediaType: "text/markdown", text: PRD },
    title: "Product v2 pending",
  }, GOAL_CREATE_COMMAND_ID));
  if (!bound.ok) throw new Error(`goal fixture refused: ${bound.code}`);
  const source = createGoalSourceReadPort({ projectId: PROJECT_ID, store }).read(GOAL_ID);
  if (!source.ok) throw new Error(`source fixture refused: ${source.code}`);
  const committed = commitProductContractRevisionV2(store, {
    commandId: "command-revision-pending", correlationId: "revision-corr",
    decidedAt: "2026-08-31T17:01:00.000Z", draft: draft(source.contentSha256),
    goalRef: GOAL_ID, principalId: AUTHOR, projectId: PROJECT_ID });
  if (!committed.ok) throw new Error(`revision fixture refused: ${committed.code}`);
  activateV2(store);
  let ordinal = 0;
  const port = createProductContractV2PendingReadPort({
    mintCommandId: ({ commandKind }) => `${commandKind}-cmd-${++ordinal}`,
    mintCorrelationId: ({ commandId }) => `correlation-${commandId}`,
    projectId: PROJECT_ID, store,
  });
  return { committed, port, source, store };
}

afterEach(closeStores);

describe("Product Contract /2 pending read HTTP edge", () => {
  it("publishes exactly the refusal codes owned by this reader", () => {
    expect(PRODUCT_CONTRACT_V2_PENDING_READ_CODES).toEqual([
      "PRODUCT_CONTRACT_V2_PENDING_READ_CAPABILITY_DENIED",
      "PRODUCT_CONTRACT_V2_PENDING_READ_PROJECT_MISMATCH",
      "PRODUCT_CONTRACT_V2_PENDING_READ_CLARIFICATION_CHANGED",
      "PRODUCT_CONTRACT_V2_PENDING_READ_MINT_INVALID",
      "PRODUCT_CONTRACT_V2_PENDING_READ_CONFIG_INVALID",
    ]);
  });

  it("uses the activated /2 path and forwards one exact goal reference", () => {
    const seen: string[] = [];
    expect(PRODUCT_CONTRACT_V2_PENDING_READ_PATH).toBe("/v2/product-contract/pending/read");
    expect(handleProductContractV2PendingReadRequest({
      authenticator: authenticator([CAPABILITIES.PLANNING]),
      productContractV2Pending: {
        boundProjectId: "proj-0001",
        readPending: (goalRef) => { seen.push(goalRef); return { outcome: "NONE" }; },
      },
    }, {
      body: bytes({ goalRef: "goal-v2" }), credential: GOOD_CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    })).toEqual({ body: { outcome: "NONE" }, httpStatus: 200, kind: "REPLY" });
    expect(seen).toEqual(["goal-v2"]);
  });

  it("refuses capability, cross-project, inexact bodies, and hostile accessors", () => {
    const readPending = () => ({ outcome: "NONE" as const });
    const base = { body: bytes({ goalRef: "goal-v2" }), credential: GOOD_CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION };
    expect(handleProductContractV2PendingReadRequest({ authenticator: authenticator([]),
      productContractV2Pending: { boundProjectId: "proj-0001", readPending } }, base))
      .toMatchObject({ body: { code: "PRODUCT_CONTRACT_V2_PENDING_READ_CAPABILITY_DENIED",
        layer: "PRODUCT_CONTRACT_V2_PENDING_READ" }, kind: "REPLY" });
    expect(handleProductContractV2PendingReadRequest({
      authenticator: authenticator([CAPABILITIES.PLANNING]),
      productContractV2Pending: { boundProjectId: "another-project", readPending },
    }, base)).toMatchObject({ body: {
      code: "PRODUCT_CONTRACT_V2_PENDING_READ_PROJECT_MISMATCH" }, kind: "REPLY" });
    for (const value of [{}, { goalRef: "" }, { goalRef: "goal-v2", extra: true },
      { goalRef: "e\u0301" }]) {
      expect(handleProductContractV2PendingReadRequest({
        authenticator: authenticator([CAPABILITIES.PLANNING]),
        productContractV2Pending: { boundProjectId: "proj-0001", readPending },
      }, { ...base, body: bytes(value) })).toEqual({
        code: "LISTENER_PRODUCT_CONTRACT_V2_PENDING_REQUEST_INVALID",
        kind: "LISTENER_REFUSAL",
      });
    }
    let touched = 0;
    const hostile = new Proxy(new Uint8Array([1]), { get() { touched += 1; throw new Error(); } });
    expect(handleProductContractV2PendingReadRequest({
      authenticator: authenticator([CAPABILITIES.PLANNING]),
      productContractV2Pending: { boundProjectId: "proj-0001", readPending },
    }, { ...base, body: hostile })).toEqual({
      code: "LISTENER_PRODUCT_CONTRACT_V2_PENDING_REQUEST_INVALID", kind: "LISTENER_REFUSAL",
    });
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "goalRef", { enumerable: true, get() {
      touched += 1; throw new Error("accessor reached");
    } });
    expect(handleProductContractV2PendingReadRequest({
      authenticator: authenticator([CAPABILITIES.PLANNING]),
      productContractV2Pending: { boundProjectId: "proj-0001", readPending },
    }, { ...base, body: accessor })).toEqual({
      code: "LISTENER_PRODUCT_CONTRACT_V2_PENDING_REQUEST_INVALID", kind: "LISTENER_REFUSAL",
    });
    expect(touched).toBe(0);
  });
});

describe("Product Contract /2 pending durable projection", () => {
  it("keeps byte-identical goal sources bound to their own Product Contracts", () => {
    const { port, source, store } = world();
    const secondGoalRef = "goal-2";
    const second = send(store, envelope("goal.create_with_source", 0, {
      instructions: "Build the other complete v2 product.",
      source: { displayPath: "docs/product-v2-copy.md", mediaType: "text/markdown", text: PRD },
      title: "Other product v2 pending",
    }, "2"));
    if (!second.ok) throw new Error(`second goal fixture refused: ${second.code}`);
    const secondSource = createGoalSourceReadPort({ projectId: PROJECT_ID, store })
      .read(secondGoalRef);
    if (!secondSource.ok) throw new Error(`second source fixture refused: ${secondSource.code}`);
    expect(secondSource.contentSha256).toBe(source.contentSha256);
    const secondContractId = "contract-v2-pending-other";
    const committed = commitProductContractRevisionV2(store, {
      commandId: "command-revision-pending-other",
      correlationId: "revision-corr-other", decidedAt: "2026-08-31T17:01:30.000Z",
      draft: draft(secondSource.contentSha256, { contractId: secondContractId,
        revisionId: "revision-v2-choice-other" }),
      goalRef: secondGoalRef, principalId: AUTHOR, projectId: PROJECT_ID,
    });
    if (!committed.ok) throw new Error(`second revision fixture refused: ${committed.code}`);

    const firstView = port.readPending(GOAL_ID);
    const secondView = port.readPending(secondGoalRef);
    expect(firstView).toMatchObject({ outcome: "PENDING", ref: { contractId: CONTRACT_ID } });
    expect(secondView).toMatchObject({ outcome: "PENDING",
      ref: { contractId: secondContractId } });
  });

  it("captures the project, store, and mint authorities exactly once", () => {
    const { store } = world(); let ordinal = 0;
    const config = {
      mintCommandId: () => `captured-command-${++ordinal}`,
      mintCorrelationId: ({ commandId }: { commandId: string }) => `captured-${commandId}`,
      projectId: PROJECT_ID, store,
    };
    const port = createProductContractV2PendingReadPort(config);
    config.mintCommandId = () => "mutated-command";
    config.mintCorrelationId = () => "mutated-correlation";
    config.projectId = "project-retargeted";
    config.store = openStore();
    const result = port.readPending(GOAL_ID);
    if (result.outcome !== "PENDING" || result.approval === null) {
      throw new Error(`expected captured PENDING authority, got ${result.outcome}`);
    }
    expect(port.boundProjectId).toBe(PROJECT_ID);
    expect(result.approval.commandId).toBe("captured-command-1");
    expect(result.approval.correlationId).toBe("captured-captured-command-1");
  });

  it("rejects hostile or structurally invalid factory configuration without invoking traps", () => {
    const { store } = world(); let traps = 0;
    const valid = { mintCommandId: () => "command", mintCorrelationId: () => "correlation",
      projectId: PROJECT_ID, store };
    const proxied = new Proxy(valid, { get() { traps += 1; throw new Error("trap invoked"); } });
    const proxiedMint = new Proxy(() => "command", { apply() {
      traps += 1; throw new Error("mint trap invoked");
    } });
    const proxiedStore = new Proxy(store, { getPrototypeOf() {
      traps += 1; throw new Error("store trap invoked");
    } });
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, "projectId", { enumerable: true, get() {
      traps += 1; throw new Error("accessor invoked");
    } });
    const invalid = [proxied, accessor, { ...valid, extra: true },
      { ...valid, projectId: " project-1" }, { ...valid, mintCommandId: "not-a-function" },
      { ...valid, mintCommandId: proxiedMint }, { ...valid, store: proxiedStore },
      { ...valid, store: {} }];
    for (const config of invalid) {
      const port = createProductContractV2PendingReadPort(config as never);
      expect(port.boundProjectId).toBe("");
      expect(port.readPending(GOAL_ID)).toEqual({
        code: "PRODUCT_CONTRACT_V2_PENDING_READ_CONFIG_INVALID",
        layer: "PRODUCT_CONTRACT_V2_PENDING_READ", outcome: "REFUSED",
      });
    }
    expect(traps).toBe(0);
  });

  it("admits only active /2 and returns the entire current revision with approval facts", () => {
    const inactive = openStore();
    expect(createProductContractV2PendingReadPort({ mintCommandId: () => "command",
      mintCorrelationId: () => "correlation", projectId: PROJECT_ID, store: inactive })
      .readPending(GOAL_ID)).toEqual({ code: "CUTOVER_V2_NOT_ACTIVE",
        layer: "DAEMON_CUTOVER_V2_AUTHORITY", outcome: "REFUSED" });
    closeStores();
    const { committed, port } = world();
    const result = port.readPending(GOAL_ID);
    if (result.outcome !== "PENDING" || result.approval === null) {
      throw new Error(`expected approved-ready PENDING, got ${result.outcome}`);
    }
    expect(result.revision).toEqual(committed.revision);
    expect(result.revision).toMatchObject({ functionalRequirements: expect.any(Array),
      technologyRequirements: expect.any(Array), version: "moe-product-contract-revision/2" });
    expect(result.ref).toEqual({ contractId: committed.revision.contractId,
      revisionDigest: committed.revision.revisionDigest,
      revisionId: committed.revision.revisionId });
    expect(result.clarifications).toEqual([]);
    const authority = productContractGate1Authority(result.ref);
    expect(result.approval).toEqual({
      affordance: {
        commandEnvelopeVersion: "moe-runtime-command/1",
        commandId: "product_contract.approve_gate_1-cmd-1",
        commandKind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
        expectedVersion: 0,
        inputSchemaVersion: "moe-product-contract-gate-1/1",
        targetAggregateId: deriveProductContractGate1AggregateId(authority.workRef),
      },
      commandId: "product_contract.approve_gate_1-cmd-1",
      correlationId: "correlation-product_contract.approve_gate_1-cmd-1",
      payload: result.ref,
      requestDigest: productContractGate1SubjectDigest({
        commandId: "product_contract.approve_gate_1-cmd-1", projectId: PROJECT_ID,
        workRef: authority.workRef,
      }),
    });
  });

  it("returns only open rows and one exact daemon-authored answer per immutable option", () => {
    const { committed, port, source, store } = world();
    const successor = { lineage: {
      parentRevisionDigest: committed.revision.revisionDigest,
      parentRevisionId: committed.revision.revisionId,
    }, revisionId: "revision-v2-pending-choice" };
    const alternative = draft(source.contentSha256, { ...successor,
      budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 45, unit: "days" }] });
    const asked = runAskProductContractClarificationV2(store, {
      commandId: "command-pending-ask",
      correlationId: "ask-correlation", decidedAt: "2026-08-31T17:02:00.000Z",
      payload: { contractId: CONTRACT_ID, goalRef: GOAL_ID, options: [
        { candidateDraft: alternative, label: "Forty-five days", optionId: "option-45" },
        { candidateDraft: draft(source.contentSha256, successor), label: "Thirty days",
          optionId: "option-30" },
      ], question: "Which complete delivery budget should govern?" },
      principalId: AUTHOR, projectId: PROJECT_ID, targetAggregateId: GOAL_ID,
    });
    if (!asked.ok) throw new Error(`ask refused: ${asked.code}`);
    const result = port.readPending(GOAL_ID);
    if (result.outcome !== "PENDING") throw new Error(`expected PENDING, got ${result.outcome}`);
    expect(result.approval).toBeNull();
    expect(result.revision).toEqual(committed.revision);
    expect(result.clarifications).toHaveLength(1);
    const row = result.clarifications[0]!;
    expect(Object.isFrozen(result.clarifications)).toBe(true);
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.options)).toBe(true);
    expect(row.clarificationId).toBe(asked.clarificationId);
    expect(row.options.map((option) => option.label))
      .toEqual(["Thirty days", "Forty-five days"]);
    for (const option of row.options) {
      expect(Object.isFrozen(option)).toBe(true);
      expect(Object.isFrozen(option.answer)).toBe(true);
      expect(Object.isFrozen(option.answer.affordance)).toBe(true);
      expect(Object.isFrozen(option.answer.payload)).toBe(true);
      expect(option.answer.payload).toEqual({ answerOptionId: option.optionId,
        clarificationId: asked.clarificationId, contractId: CONTRACT_ID });
      expect(option.answer.affordance).toMatchObject({
        commandKind: "product_contract.answer_clarification", expectedVersion: 1,
        inputSchemaVersion: "moe-product-contract-clarification/2",
        targetAggregateId: productContractClarificationV2AggregateId(
          PROJECT_ID, CONTRACT_ID, asked.clarificationId,
        ),
      });
      expect(option.answer.commandId).toMatch(/-cmd-[12]$/u);
      expect(option.answer.correlationId).toBe(`correlation-${option.answer.commandId}`);
      expect(option.answer.requestDigest).toBe(createHash("sha256")
        .update(JSON.stringify(option.answer.payload)).digest("hex"));
    }
    expect(createProductContractV2PendingReadPort({
      mintCommandId: () => "duplicate-command",
      mintCorrelationId: () => "duplicate-correlation", projectId: PROJECT_ID, store,
    }).readPending(GOAL_ID)).toEqual({ code: "PRODUCT_CONTRACT_V2_PENDING_READ_MINT_INVALID",
      layer: "PRODUCT_CONTRACT_V2_PENDING_READ", outcome: "REFUSED" });
  });

  it("serves PENDING at the daemon entry and follows its answer through /2", async () => {
    const { committed, source, store } = world();
    const successor = { lineage: {
      parentRevisionDigest: committed.revision.revisionDigest,
      parentRevisionId: committed.revision.revisionId,
    }, revisionId: "revision-v2-pending-roundtrip" };
    const alternative = draft(source.contentSha256, { ...successor,
      budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 45, unit: "days" }] });
    const asked = runAskProductContractClarificationV2(store, {
      commandId: "command-pending-roundtrip-ask",
      correlationId: "pending-roundtrip-ask", decidedAt: "2026-08-31T17:02:00.000Z",
      payload: { contractId: CONTRACT_ID, goalRef: GOAL_ID, options: [
        { candidateDraft: draft(source.contentSha256, successor), label: "Thirty days",
          optionId: "thirty-days" },
        { candidateDraft: alternative, label: "Alternative", optionId: "alternative" },
      ], question: "Which complete revision should govern?" }, principalId: AUTHOR,
      projectId: PROJECT_ID, targetAggregateId: GOAL_ID,
    });
    if (!asked.ok) throw new Error(`ask refused: ${asked.code}`);
    let mint = 0;
    const pendingPort = createProductContractV2PendingReadPort({
      mintCommandId: ({ commandKind }) => `${commandKind}-roundtrip-${mint += 1}`,
      mintCorrelationId: ({ commandId }) => `${commandId}-correlation`,
      projectId: PROJECT_ID, store,
    });
    const ports = createDaemonV2CommandPorts({
      clock: () => "2026-08-31T17:03:00.000Z", operatorPrincipalId: "prin-0001",
      projectId: PROJECT_ID, store,
    });
    const projectAuthenticator = Object.freeze({
      authenticate: (credential: string | null) => credential === GOOD_CREDENTIAL
        ? Object.freeze({ principal: Object.freeze({
          capabilities: Object.freeze([CAPABILITIES.PLANNING]), principalId: "prin-0001",
          projectId: PROJECT_ID,
        }), verdict: "AUTHENTICATED" as const })
        : Object.freeze({ verdict: "UNAUTHENTICATED" as const }),
    });
    const csrfToken = "product-contract-v2-pending-roundtrip-csrf";
    const started = await startDaemon({
      csrfToken,
      dependencies: {
        productContractV2Pending: () => pendingPort,
        provide: () => ({ ...fixtureDependencies(),
          authenticator: projectAuthenticator }),
        provideV2: () => ({ authenticator: projectAuthenticator,
          decisions: ports.decisions, registry: ports.registry }),
      },
    });
    if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
    try {
      const pendingReply = await postJson(
        started, csrfToken, PRODUCT_CONTRACT_V2_PENDING_READ_PATH, { goalRef: GOAL_ID },
      );
      expect(pendingReply.status).toBe(200);
      const pending = pendingReply.body;
      if (typeof pending !== "object" || pending === null
        || Reflect.get(pending, "outcome") !== "PENDING") {
        throw new Error(`expected PENDING, got ${JSON.stringify(pending)}`);
      }
      const pendingView = pending as ProductContractV2PendingView;
      const selected = pendingView.clarifications[0]?.options.find(
        ({ optionId }) => optionId === "alternative",
      )?.answer;
      if (selected === undefined) throw new Error("missing emitted alternative answer");
      const command = {
        commandId: selected.commandId,
        commandKind: selected.affordance.commandKind,
        correlationId: selected.correlationId,
        expectedVersion: selected.affordance.expectedVersion,
        payload: selected.payload,
        requestDigest: selected.requestDigest,
        schemaVersion: selected.affordance.commandEnvelopeVersion,
        sessionCredential: GOOD_CREDENTIAL,
        targetAggregateId: selected.affordance.targetAggregateId,
      };
      expect(await postJson(started, csrfToken, "/v2/command", command)).toEqual({
        body: {
          decision: {
            commandId: selected.commandId,
            disposition: "DECIDED",
            effectId: asked.clarificationId,
            resultCode: "PRODUCT_CONTRACT_CLARIFICATION_ANSWERED",
          },
          httpStatus: 200,
          ok: true,
          outcome: "ACCEPTED",
        },
        status: 200,
      });
      expect((await postJson(started, csrfToken, "/v2/command", command)).body)
        .toMatchObject({ decision: { commandId: selected.commandId, disposition: "REPLAYED" },
          ok: true, outcome: "ACCEPTED" });
      expect(pendingPort.readPending(GOAL_ID)).toMatchObject({
        approval: null, clarifications: [], outcome: "PENDING",
      });
    } finally {
      await started.shutdown();
    }
  });

  it("refuses one identity reused as both command and correlation", () => {
    const { store } = world();
    expect(createProductContractV2PendingReadPort({
      mintCommandId: () => "same-identity",
      mintCorrelationId: () => "same-identity", projectId: PROJECT_ID, store,
    }).readPending(GOAL_ID)).toEqual({ code: "PRODUCT_CONTRACT_V2_PENDING_READ_MINT_INVALID",
      layer: "PRODUCT_CONTRACT_V2_PENDING_READ", outcome: "REFUSED" });
  });

  it("withholds both answer rows and approval while a selected revision is pending", () => {
    const { committed, source, store } = world();
    const successor = { lineage: {
      parentRevisionDigest: committed.revision.revisionDigest,
      parentRevisionId: committed.revision.revisionId,
    }, revisionId: "revision-v2-pending-selection" };
    const alternative = draft(source.contentSha256, { ...successor,
      budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 45, unit: "days" }] });
    const asked = runAskProductContractClarificationV2(store, {
      commandId: "command-pending-selection-ask",
      correlationId: "pending-ask", decidedAt: "2026-08-31T17:03:00.000Z",
      payload: { contractId: CONTRACT_ID, goalRef: GOAL_ID, options: [
        { candidateDraft: draft(source.contentSha256, successor), label: "Thirty days",
          optionId: "thirty-days" },
        { candidateDraft: alternative, label: "Alternative", optionId: "alternative" },
      ], question: "Which revision must become current?" }, principalId: AUTHOR,
      projectId: PROJECT_ID, targetAggregateId: GOAL_ID,
    });
    if (!asked.ok) throw new Error(`ask refused: ${asked.code}`);
    const answered = runAnswerProductContractClarificationV2(store, {
      commandId: "command-pending-selection-answer",
      correlationId: "pending-answer", decidedAt: "2026-08-31T17:04:00.000Z",
      payload: { answerOptionId: "alternative", clarificationId: asked.clarificationId,
        contractId: CONTRACT_ID }, principalId: "human-product-owner", projectId: PROJECT_ID,
      targetAggregateId: productContractClarificationV2AggregateId(
        PROJECT_ID, CONTRACT_ID, asked.clarificationId,
      ),
    });
    if (!answered.ok) throw new Error(`answer refused: ${answered.code}`);
    let mints = 0;
    const result = createProductContractV2PendingReadPort({
      mintCommandId: () => { mints += 1; return "unexpected-command"; },
      mintCorrelationId: () => { mints += 1; return "unexpected-correlation"; },
      projectId: PROJECT_ID, store,
    }).readPending(GOAL_ID);
    expect(result).toMatchObject({ approval: null, clarifications: [], outcome: "PENDING" });
    expect(mints).toBe(0);
  });

  it("fails closed without rows when the durable clarification scan is unreadable", () => {
    const { port, store } = world();
    const brokenCore = new Proxy(store, { get(target, key, receiver) {
      if (key === "readCommandDecisionsAfter") return () => { throw new Error("unreadable"); };
      const value = Reflect.get(target, key, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const broken = Reflect.construct(
      SqliteEventStore as unknown as Function, [brokenCore],
    ) as SqliteEventStore;
    const result = createProductContractV2PendingReadPort({
      mintCommandId: () => "must-not-mint", mintCorrelationId: () => "must-not-correlate",
      projectId: PROJECT_ID, store: broken,
    }).readPending(GOAL_ID);
    expect(result).toEqual({ code: "STORAGE_DEGRADED", layer: "DURABLE_STORE",
      outcome: "REFUSED" });
    expect(port.readPending("goal-unknown")).toEqual({ outcome: "NONE" });
  });

  it("refuses a malformed goal index before minting or returning a partial card", () => {
    const { store } = world();
    commitEvent(store, deriveProductContractV2GoalBindingAggregateId(PROJECT_ID, GOAL_ID),
      "hostile-v2-goal-binding", "HostileGoalBinding", "hostile/1", bytes({}), 1);
    const minted: string[] = [];
    const result = createProductContractV2PendingReadPort({
      mintCommandId: () => { minted.push("command"); return "command"; },
      mintCorrelationId: () => { minted.push("correlation"); return "correlation"; },
      projectId: PROJECT_ID, store,
    }).readPending(GOAL_ID);
    expect(result).toEqual({ code: "PRODUCT_CONTRACT_V2_GOAL_BINDING_INVALID",
      layer: "PRODUCT_CONTRACT_V2_GOAL_BINDING", outcome: "REFUSED" });
    expect(minted).toEqual([]);
  });
});
