import { createHash } from "node:crypto";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { productContractGate1Authority } from "@moe/core";
import { SQLITE_SCHEMA_MANIFEST_VERSION, type SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  CUTOVER_ACTIVATION_MARKER_EVENT_TYPE,
  composeCutoverActivationMarker,
  deriveCutoverActivationMarkerAggregateId,
  encodeCutoverActivationMarker,
} from "./cutover/cutover-activation-marker.js";
import {
  V2_READINESS_MANIFEST_EVENT_TYPE,
  V2_READINESS_MANIFEST_SCHEMA_VERSION,
  deriveV2ReadinessManifestAggregateId,
  digestV2ReadinessManifest,
  encodeV2ReadinessManifest,
} from "./cutover/v2-readiness-manifest.js";
import { V2_SURFACE_MANIFEST_SHA256 } from "./cutover/v2-surface-manifest.js";
import {
  PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND,
  PRODUCT_CONTRACT_PROPOSE_REVISION_V2_PAYLOAD_KEYS,
} from "./product-contract/product-contract-v2-propose-service.js";
import {
  PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND,
  PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND,
} from "./product-contract/product-contract-command-contracts.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
  PRODUCT_CONTRACT_GATE_1_PAYLOAD_KEYS,
  deriveProductContractGate1AggregateId,
  productContractGate1SubjectDigest,
} from "./product-contract/product-contract-gate-1-contract.js";
import { productContractClarificationV2AggregateId }
  from "./product-contract/product-contract-v2-clarification-contract.js";
import { readCurrentProductContractRevisionV2 }
  from "./product-contract/product-contract-v2-reader.js";
import { CAPABILITIES, PAYLOAD_KEYS } from "./daemon-command-vocabulary.js";
import { OPERATOR_CAPABILITIES } from "./daemon-command-registry.js";
import {
  createDaemonV2CommandPorts,
  type DaemonV2CommandPortOptions,
} from "./daemon-v2-command-registry.js";
import { handleCommandRequest } from "./http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION, type CommandAdapterDeps, type TransportOrigin }
  from "./http/http-contract.js";
import { createSessionAuthority } from "./identity/session-authority.js";
import { createSessionAuthenticator, credentialSha256Of }
  from "./identity/session-authenticator.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { FOUNDATION_DISPATCH_COMMAND_KIND }
  from "./work/foundation-attempt-contracts.js";
import {
  GOAL_CREATE_COMMAND_ID,
  GOAL_ID,
  PROJECT_ID,
  closeStores,
  driveThrough,
  envelope,
  openStore,
  send,
} from "./bootstrap/bootstrap-test-fixtures.js";

const V2_NOW = "2026-08-31T14:30:00.000Z";
const V2_NOW_MS = Date.parse(V2_NOW);
const V2_AGENT = "agent-v2-registry";
const V2_AGENT_CREDENTIAL = "credential-agent-v2-registry";
const V2_OPERATOR = "operator-v2";
const V2_OPERATOR_CREDENTIAL = "credential-operator-v2";
const V2_CONTRACT_ID = "contract-v2-registry";
const V2_PRD = "# Product Contract /2 registry\n\nShip the exact durable workflow.\n";
const V2_PRD_SHA256 = createHash("sha256").update(V2_PRD, "utf8").digest("hex");
const hex = (digit: string): string => digit.repeat(64);
const requirement = (requirementId: string, dependencies: readonly string[] = []) => ({
  dependsOnRequirementIds: [...dependencies], priority: "MUST" as const, requirementId,
  statement: `${requirementId} must hold.`, supersedesRequirementId: null,
});
const criterion = (criterionId: string, requirementId: string) => ({
  criterionId, requirementId, statement: `${criterionId} is observable.`,
  supersedesCriterionId: null, verification: `Run deterministic ${criterionId} verification.`,
});
const V2_CRITERIA = Object.freeze([
  "criterion-deployment", "criterion-keyboard", "criterion-latency",
  "criterion-login", "criterion-runtime", "criterion-session",
]);

function v2Draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assumptions: [{ assumptionId: "assumption-browser", statement: "A browser exists.",
      validationCriterionId: "criterion-runtime" }],
    authorRef: V2_AGENT,
    budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 30, unit: "days" }],
    contractId: V2_CONTRACT_ID,
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
    productCompleteDefinition: { criterionIds: [...V2_CRITERIA],
      statement: "Every criterion is independently verified." },
    retiredCriterionIds: [], retiredRequirementIds: [], revisionId: "revision-v2-registry",
    securityPrivacyRequirements: [requirement("security-session", ["requirement-login"])],
    sourceDocumentDigests: [V2_PRD_SHA256],
    successMetrics: [{ measurement: "Count successful sessions.", metricId: "metric-first-use",
      objectiveIds: ["objective-adoption"], statement: "Users finish.", target: "80 percent." }],
    technologyRequirements: [requirement("technology-runtime")],
    userJobs: [{ job: "Reach the product.", user: "Operator", userJobId: "job-access" }],
    uxAccessibilityRequirements: [requirement("ux-keyboard", ["requirement-login"])],
    ...overrides,
  };
}

function commitEvent(store: SqliteEventStore, aggregateId: string, commandId: string,
eventType: string, schemaVersion: string, payload: Uint8Array): void {
  store.commit({ aggregateId, commandBytes: payload, commandId, committedAt: V2_NOW,
    events: [{ domainSchemaVersion: schemaVersion, eventId: `${commandId}-event`,
      eventType, payload }], expectedVersion: 0 });
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
  commitEvent(store, deriveV2ReadinessManifestAggregateId(PROJECT_ID), "readiness-v2-registry",
    V2_READINESS_MANIFEST_EVENT_TYPE, V2_READINESS_MANIFEST_SCHEMA_VERSION,
    encodeV2ReadinessManifest(readiness));
  const composed = composeCutoverActivationMarker({ activatedAtEpochMs: V2_NOW_MS, generations,
    readinessManifestSha256: digestV2ReadinessManifest(readiness), readinessManifestVersion: 1,
    sourceCommit, sourceState: "ACTIVATE_APPROVED" });
  if (!composed.ok) throw new Error("v2 registry activation fixture refused");
  commitEvent(store, deriveCutoverActivationMarkerAggregateId(PROJECT_ID),
    "activation-v2-registry", CUTOVER_ACTIVATION_MARKER_EVENT_TYPE,
    composed.marker.schemaVersion, encodeCutoverActivationMarker(composed.marker));
}

function activeWorld(): { deps: CommandAdapterDeps; store: SqliteEventStore } {
  const store = openStore();
  driveThrough(store, "goal.create");
  const bound = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Bind the Product Contract /2 registry workflow.",
    source: { displayPath: "docs/registry-v2.md", mediaType: "text/markdown", text: V2_PRD },
    title: "Product Contract /2 registry",
  }, GOAL_CREATE_COMMAND_ID));
  if (!bound.ok) throw new Error(`v2 registry source fixture refused: ${bound.code}`);
  installTestRecoveryBinding(store);
  activateV2(store);
  const sessions = createSessionAuthority(store, { clock: () => V2_NOW_MS,
    projectId: PROJECT_ID });
  const agent = sessions.createPrincipal({ commandId: "create-v2-registry-agent",
    correlationId: "correlate-v2-registry-agent", kind: "AGENT", principalId: V2_AGENT,
    profileRevisionId: "profile-v2-registry-agent" });
  if (!agent.ok) throw new Error(`v2 registry agent fixture refused: ${agent.code}`);
  const human = sessions.createPrincipal({ commandId: "create-v2-registry-human",
    correlationId: "correlate-v2-registry-human", kind: "HUMAN",
    principalId: V2_OPERATOR, profileRevisionId: "profile-v2-registry-human" });
  if (!human.ok) throw new Error(`v2 registry human fixture refused: ${human.code}`);
  const ports = createDaemonV2CommandPorts({ clock: () => V2_NOW,
    operatorPrincipalId: V2_OPERATOR, projectId: PROJECT_ID, store });
  const deps = Object.freeze({
    authenticator: createSessionAuthenticator(store, {
      clock: () => V2_NOW_MS,
      operatorCapabilities: OPERATOR_CAPABILITIES,
      operatorCredential: V2_OPERATOR_CREDENTIAL,
      operatorPrincipalId: V2_OPERATOR,
      projectId: PROJECT_ID,
    }),
    decisions: ports.decisions,
    registry: ports.registry,
  });
  const opened = dispatchV2(deps, {
    commandId: "command-v2-registry-open-agent",
    commandKind: "session.open",
    credential: V2_OPERATOR_CREDENTIAL,
    origin: "HTTP_LISTENER",
    payload: {
      capabilities: [CAPABILITIES.PLANNING],
      credentialSha256: credentialSha256Of(V2_AGENT_CREDENTIAL),
      expiresAt: "2027-01-01T00:00:00.000Z",
      sessionId: V2_AGENT,
    },
    targetAggregateId: V2_AGENT,
  });
  if (opened.outcome !== "ACCEPTED") {
    throw new Error("v2 registry agent session fixture refused");
  }
  return { deps, store };
}

interface V2DispatchInput {
  readonly commandId: string;
  readonly commandKind: string;
  readonly credential: string;
  readonly origin?: TransportOrigin;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly targetAggregateId: string;
}

function dispatchV2(deps: CommandAdapterDeps, input: V2DispatchInput):
ReturnType<typeof handleCommandRequest> {
  const body = new TextEncoder().encode(JSON.stringify({
    commandId: input.commandId,
    commandKind: input.commandKind,
    correlationId: `correlation-${input.commandId}`,
    expectedVersion: 0,
    payload: input.payload,
    requestDigest: createHash("sha256").update(JSON.stringify({
      commandId: input.commandId, payload: input.payload,
    }), "utf8").digest("hex"),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: input.credential,
    targetAggregateId: input.targetAggregateId,
  }));
  const request = { body, credential: input.credential, protocolVersion: WIRE_PROTOCOL_VERSION };
  return input.origin === undefined
    ? handleCommandRequest(deps, request)
    : handleCommandRequest(deps, request, input.origin);
}

describe("daemon /2 command registry", () => {
  it("snapshots the /2 authority dependencies exactly once at construction", () => {
    const store = openStore();
    const reads = { clock: 0, operatorPrincipalId: 0, projectId: 0, store: 0 };
    const options = {
      get clock(): () => string {
        reads.clock += 1;
        return () => "2026-08-31T14:30:00.000Z";
      },
      get operatorPrincipalId(): string {
        reads.operatorPrincipalId += 1;
        return "operator-v2";
      },
      get projectId(): string {
        reads.projectId += 1;
        return reads.projectId === 1 ? PROJECT_ID : "project-retargeted";
      },
      get store(): typeof store {
        reads.store += 1;
        return store;
      },
    } satisfies DaemonV2CommandPortOptions;
    try {
      const ports = createDaemonV2CommandPorts(options);
      // FOURTH roster: the /2 plane composes from the SAME `PAYLOAD_KEYS`, so a kind wired on
      // the /1 side moves this count too. 52 -> 53 for `design.submit` (task-06ac0da1); the /2
      // registry stays one short of /1's 54 because it withholds `planning.submit_decomposition`
      // until that kind's /2 service lands.
      expect(ports.registry.size).toBe(61);
      expect(reads).toEqual({ clock: 1, operatorPrincipalId: 1, projectId: 1, store: 1 });
    } finally {
      closeStores();
    }
  });

  it("uses the /2 clarification payloads rather than the forensic /1 answer digest", () => {
    const store = openStore();
    const ports = createDaemonV2CommandPorts({
      clock: () => "2026-08-31T14:30:00.000Z", operatorPrincipalId: "operator-v2",
      projectId: PROJECT_ID, store,
    });
    try {
      expect(ports.registry.get(PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND)?.payloadKeys)
        .toEqual(["contractId", "goalRef", "options", "question"]);
      expect(ports.registry.get(PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND)?.payloadKeys)
        .toEqual(["answerOptionId", "clarificationId", "contractId"]);
      expect(ports.registry.get(PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND)?.payloadKeys)
        .not.toBe(PAYLOAD_KEYS[PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND]);
      expect(ports.registry.get(PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND)?.payloadKeys)
        .not.toBe(PAYLOAD_KEYS[PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND]);
    } finally {
      closeStores();
    }
  });

  it("serves every safe command with exact /2 overrides and withholds the legacy planner", () => {
    const store = openStore();
    const ports = createDaemonV2CommandPorts({
      clock: () => "2026-08-31T14:30:00.000Z", operatorPrincipalId: "operator-v2",
      projectId: PROJECT_ID, store,
    });
    try {
      expect([...ports.registry.keys()].sort()).toEqual(Object.keys(PAYLOAD_KEYS)
        .filter((kind) => kind !== "planning.submit_decomposition").sort());
      expect(ports.registry.has("planning.submit_decomposition")).toBe(false);
      const entry = ports.registry.get(PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND);
      expect(entry).toMatchObject({
        kind: "product_contract.propose_revision",
        payloadKeys: PRODUCT_CONTRACT_PROPOSE_REVISION_V2_PAYLOAD_KEYS,
        requiredCapability: CAPABILITIES.PLANNING,
      });
      const v2Payloads = new Map<string, readonly string[]>([
        [PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND,
          ["answerOptionId", "clarificationId", "contractId"]],
        [PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_PAYLOAD_KEYS],
        [PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND,
          ["contractId", "goalRef", "options", "question"]],
        [PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND,
          PRODUCT_CONTRACT_PROPOSE_REVISION_V2_PAYLOAD_KEYS],
      ]);
      for (const [kind, entry] of ports.registry) {
        const versioned = v2Payloads.get(kind);
        if (versioned === undefined) {
          expect(entry.payloadKeys).toBe(PAYLOAD_KEYS[kind as keyof typeof PAYLOAD_KEYS]);
        } else {
          expect(entry.payloadKeys).toEqual(versioned);
        }
      }
      const overrideKinds = new Set<string>([
        PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND,
        PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
        PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND,
        PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND,
      ]);
      expect([...ports.registry.values()].filter(({ kind }) => overrideKinds.has(kind))
        .map(({ kind, payloadKeys, requiredCapability }) => ({
        kind, payloadKeys, requiredCapability,
      })).sort((left, right) => left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0))
        .toEqual([
          {
            kind: PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND,
            payloadKeys: ["answerOptionId", "clarificationId", "contractId"],
            requiredCapability: CAPABILITIES.PLANNING,
          },
          {
            kind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
            payloadKeys: PRODUCT_CONTRACT_GATE_1_PAYLOAD_KEYS,
            requiredCapability: CAPABILITIES.ADMIN,
          },
          {
            kind: PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND,
            payloadKeys: ["contractId", "goalRef", "options", "question"],
            requiredCapability: CAPABILITIES.PLANNING,
          },
          {
            kind: PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND,
            payloadKeys: PRODUCT_CONTRACT_PROPOSE_REVISION_V2_PAYLOAD_KEYS,
            requiredCapability: CAPABILITIES.PLANNING,
          },
        ]);
    } finally {
      closeStores();
    }
  });

  it("refuses at the named /2 activation fence before the writer can touch storage", () => {
    const store = openStore();
    const ports = createDaemonV2CommandPorts({
      clock: () => "2026-08-31T14:30:00.000Z", operatorPrincipalId: "operator-v2",
      projectId: PROJECT_ID, store,
    });
    try {
      const entry = ports.registry.get(PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND);
      if (entry === undefined) throw new Error("missing v2 Product Contract entry");
      const result = ports.decisions.decide(
        { commandId: "command-v2-inactive", principalId: "agent-v2", projectId: PROJECT_ID },
        "a".repeat(64),
        () => entry.handler({
          envelope: {
            commandId: "command-v2-inactive",
            commandKind: PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND,
            correlationId: "correlation-v2-inactive",
            expectedVersion: 0,
            payload: { draft: {}, goalRef: "goal-v2" },
            requestDigest: "a".repeat(64),
            schemaVersion: "moe-runtime-command/1",
            sessionCredential: "credential-v2",
            targetAggregateId: "goal-v2",
          },
          principal: {
            capabilities: [CAPABILITIES.PLANNING],
            principalId: "agent-v2",
            projectId: PROJECT_ID,
          },
        }),
      );
      expect(result).toEqual({
        outcome: "REFUSED",
        refusal: {
          code: "CUTOVER_V2_NOT_ACTIVE",
          detail: "CUTOVER_V2_NOT_ACTIVE",
          httpStatus: 422,
          layer: "DAEMON_CUTOVER_V2_AUTHORITY",
        },
      });
      expect(store.getAggregateVersion("goal-v2")).toBe(0);
    } finally {
      closeStores();
    }
  });

  it("fences a shared synchronous command before its v1 writer can run", () => {
    const store = openStore();
    const ports = createDaemonV2CommandPorts({
      clock: () => "2026-08-31T14:30:00.000Z", operatorPrincipalId: "operator-v2",
      projectId: PROJECT_ID, store,
    });
    try {
      const entry = ports.registry.get("goal.create");
      if (entry === undefined) throw new Error("missing shared goal.create entry");
      const result = ports.decisions.decide(
        { commandId: "command-v2-shared-sync", principalId: "agent-v2", projectId: PROJECT_ID },
        "b".repeat(64),
        () => entry.handler({
          envelope: {
            commandId: "command-v2-shared-sync",
            commandKind: "goal.create",
            correlationId: "correlation-v2-shared-sync",
            expectedVersion: 0,
            payload: { description: "must remain unwritten" },
            requestDigest: "b".repeat(64),
            schemaVersion: "moe-runtime-command/1",
            sessionCredential: "credential-v2",
            targetAggregateId: "goal-v2-shared-sync",
          },
          principal: {
            capabilities: [CAPABILITIES.PLANNING],
            principalId: "agent-v2",
            projectId: PROJECT_ID,
          },
        }),
      );
      expect(result).toMatchObject({
        outcome: "REFUSED",
        refusal: {
          code: "CUTOVER_V2_NOT_ACTIVE",
          layer: "DAEMON_CUTOVER_V2_AUTHORITY",
        },
      });
      expect(store.getAggregateVersion("goal-v2-shared-sync")).toBe(0);
    } finally {
      closeStores();
    }
  });

  it("fences a shared asynchronous command before Foundation can launch", async () => {
    const store = openStore();
    const ports = createDaemonV2CommandPorts({
      clock: () => "2026-08-31T14:30:00.000Z", operatorPrincipalId: "operator-v2",
      projectId: PROJECT_ID, store,
    });
    try {
      const entry = ports.registry.get(FOUNDATION_DISPATCH_COMMAND_KIND);
      const handler = entry?.asyncHandler;
      const decideAsync = ports.decisions.decideAsync;
      if (handler === undefined || decideAsync === undefined) {
        throw new Error("missing shared async Foundation entry");
      }
      const result = await decideAsync(
        { commandId: "command-v2-shared-async", principalId: "agent-v2", projectId: PROJECT_ID },
        "c".repeat(64),
        async () => await handler({
          envelope: {
            commandId: "command-v2-shared-async",
            commandKind: FOUNDATION_DISPATCH_COMMAND_KIND,
            correlationId: "correlation-v2-shared-async",
            expectedVersion: 0,
            payload: {},
            requestDigest: "c".repeat(64),
            schemaVersion: "moe-runtime-command/1",
            sessionCredential: "credential-v2",
            targetAggregateId: "foundation-v2-shared-async",
          },
          principal: {
            capabilities: [CAPABILITIES.WORK],
            principalId: "agent-v2",
            projectId: PROJECT_ID,
          },
        }),
      );
      expect(result).toMatchObject({
        outcome: "REFUSED",
        refusal: {
          code: "CUTOVER_V2_NOT_ACTIVE",
          layer: "DAEMON_CUTOVER_V2_AUTHORITY",
        },
      });
      expect(store.getAggregateVersion("foundation-v2-shared-async")).toBe(0);
    } finally {
      closeStores();
    }
  });

  it("executes the active durable propose, ask, answer, and Gate 1 workflow", () => {
    try {
      const { deps, store } = activeWorld();
      const propose = {
        commandId: "command-v2-registry-propose",
        commandKind: PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND,
        credential: V2_AGENT_CREDENTIAL,
        origin: "AGENT_WRAPPER" as const,
        payload: { draft: v2Draft(), goalRef: GOAL_ID },
        targetAggregateId: GOAL_ID,
      };
      expect(dispatchV2(deps, propose)).toMatchObject({
        decision: { commandId: propose.commandId, disposition: "DECIDED",
          resultCode: "PRODUCT_CONTRACT_REVISION_V2" },
        outcome: "ACCEPTED",
      });
      expect(dispatchV2(deps, propose)).toMatchObject({
        decision: { commandId: propose.commandId, disposition: "REPLAYED",
          resultCode: "PRODUCT_CONTRACT_REVISION_V2" },
        outcome: "ACCEPTED",
      });

      const current = readCurrentProductContractRevisionV2(store, {
        contractId: V2_CONTRACT_ID, projectId: PROJECT_ID,
      });
      if (!current.ok) throw new Error(`v2 registry current revision refused: ${current.code}`);
      expect(current.slot.generation).toBe(1);
      const successor = { lineage: {
        parentRevisionDigest: current.revision.revisionDigest,
        parentRevisionId: current.revision.revisionId,
      }, revisionId: "revision-v2-registry-successor" };
      const selectedDraft = v2Draft({ ...successor,
        budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 45, unit: "days" }] });

      const ask = {
        commandId: "command-v2-registry-ask",
        commandKind: PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND,
        credential: V2_AGENT_CREDENTIAL,
        origin: "AGENT_WRAPPER" as const,
        payload: {
          contractId: V2_CONTRACT_ID,
          goalRef: GOAL_ID,
          options: [
            { candidateDraft: v2Draft(successor), label: "Thirty days",
              optionId: "option-thirty-days" },
            { candidateDraft: selectedDraft, label: "Forty-five days",
              optionId: "option-forty-five-days" },
          ],
          question: "Which complete delivery budget governs the successor revision?",
        },
        targetAggregateId: GOAL_ID,
      };
      const asked = dispatchV2(deps, ask);
      expect(asked).toMatchObject({
        decision: { commandId: ask.commandId, disposition: "DECIDED",
          resultCode: "PRODUCT_CONTRACT_CLARIFICATION" },
        outcome: "ACCEPTED",
      });
      if (asked.outcome !== "ACCEPTED" || asked.decision.effectId === null) {
        throw new Error("active /2 clarification did not return its durable identity");
      }
      const clarificationId = asked.decision.effectId;
      expect(dispatchV2(deps, ask)).toMatchObject({
        decision: { commandId: ask.commandId, disposition: "REPLAYED",
          effectId: clarificationId },
        outcome: "ACCEPTED",
      });
      const clarificationAggregateId = productContractClarificationV2AggregateId(
        PROJECT_ID, V2_CONTRACT_ID, clarificationId,
      );
      expect(store.getAggregateVersion(clarificationAggregateId)).toBe(1);

      const answerPayload = { answerOptionId: "option-forty-five-days", clarificationId,
        contractId: V2_CONTRACT_ID };
      const nonHumanAnswer = dispatchV2(deps, {
        commandId: "command-v2-registry-answer-agent",
        commandKind: PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND,
        credential: V2_AGENT_CREDENTIAL,
        origin: "AGENT_WRAPPER",
        payload: answerPayload,
        targetAggregateId: clarificationAggregateId,
      });
      expect(nonHumanAnswer).toMatchObject({
        outcome: "PORT_REFUSED",
        refusal: { code: "OPERATOR_PRINCIPAL_REQUIRED", httpStatus: 403,
          layer: "DAEMON_AUTHORIZATION" },
        stage: "DISPATCH",
      });
      expect(store.getAggregateVersion(clarificationAggregateId)).toBe(1);

      const answer = {
        commandId: "command-v2-registry-answer-human",
        commandKind: PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND,
        credential: V2_OPERATOR_CREDENTIAL,
        origin: "HTTP_LISTENER" as const,
        payload: answerPayload,
        targetAggregateId: clarificationAggregateId,
      };
      expect(dispatchV2(deps, answer)).toMatchObject({
        decision: { commandId: answer.commandId, disposition: "DECIDED",
          resultCode: "PRODUCT_CONTRACT_CLARIFICATION_ANSWERED" },
        outcome: "ACCEPTED",
      });
      expect(dispatchV2(deps, answer)).toMatchObject({
        decision: { commandId: answer.commandId, disposition: "REPLAYED" },
        outcome: "ACCEPTED",
      });
      expect(store.getAggregateVersion(clarificationAggregateId)).toBe(2);

      const selectedProposal = {
        commandId: "command-v2-registry-propose-selected",
        commandKind: PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND,
        credential: V2_AGENT_CREDENTIAL,
        origin: "AGENT_WRAPPER" as const,
        payload: { draft: selectedDraft, goalRef: GOAL_ID },
        targetAggregateId: GOAL_ID,
      };
      expect(dispatchV2(deps, selectedProposal)).toMatchObject({
        decision: { commandId: selectedProposal.commandId, disposition: "DECIDED",
          resultCode: "PRODUCT_CONTRACT_REVISION_V2" },
        outcome: "ACCEPTED",
      });
      expect(dispatchV2(deps, selectedProposal)).toMatchObject({
        decision: { commandId: selectedProposal.commandId, disposition: "REPLAYED",
          resultCode: "PRODUCT_CONTRACT_REVISION_V2" },
        outcome: "ACCEPTED",
      });
      const selectedCurrent = readCurrentProductContractRevisionV2(store, {
        contractId: V2_CONTRACT_ID, projectId: PROJECT_ID,
      });
      if (!selectedCurrent.ok) {
        throw new Error(`selected v2 registry revision refused: ${selectedCurrent.code}`);
      }
      expect(selectedCurrent.slot.generation).toBe(2);
      expect(selectedCurrent.revision.budgets).toEqual([
        { budgetId: "budget-delivery", kind: "TIME", limit: 45, unit: "days" },
      ]);
      const ref = Object.freeze({
        contractId: selectedCurrent.revision.contractId,
        revisionDigest: selectedCurrent.revision.revisionDigest,
        revisionId: selectedCurrent.revision.revisionId,
      });

      const gate = productContractGate1Authority(ref);
      const gateCommandId = "command-v2-registry-gate-1";
      const gatePayload = {
        authentication: {
          issuedAt: V2_NOW_MS,
          kind: "BEARER",
          requestDigest: productContractGate1SubjectDigest({
            commandId: gateCommandId, projectId: PROJECT_ID, workRef: gate.workRef,
          }),
          requestId: gateCommandId,
        },
        ...ref,
      };
      const gateInput = {
        commandId: gateCommandId,
        commandKind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
        credential: V2_OPERATOR_CREDENTIAL,
        payload: gatePayload,
        targetAggregateId: deriveProductContractGate1AggregateId(gate.workRef),
      };
      expect(dispatchV2(deps, gateInput)).toMatchObject({
        outcome: "PORT_REFUSED",
        refusal: { code: "PRODUCT_CONTRACT_GATE_1_TRANSPORT_ORIGIN_INVALID",
          layer: "DAEMON_PRODUCT_CONTRACT_GATE_1" },
        stage: "DISPATCH",
      });
      expect(store.getAggregateVersion(gateInput.targetAggregateId)).toBe(0);

      const gateThroughHttp = { ...gateInput, origin: "HTTP_LISTENER" as const };
      expect(dispatchV2(deps, gateThroughHttp)).toMatchObject({
        decision: { commandId: gateCommandId, disposition: "DECIDED",
          resultCode: "EFFECTS_COMMITTED" },
        outcome: "ACCEPTED",
      });
      expect(dispatchV2(deps, { ...gateThroughHttp, payload: {
        ...gatePayload, authentication: { ...gatePayload.authentication,
          issuedAt: V2_NOW_MS + 1 },
      } })).toMatchObject({
        decision: { commandId: gateCommandId, disposition: "REPLAYED",
          resultCode: "EFFECTS_COMMITTED" },
        outcome: "ACCEPTED",
      });
      expect(store.getAggregateVersion(gateInput.targetAggregateId)).toBe(1);
    } finally {
      closeStores();
    }
  });

  it("rejects the forensic /1 answer payload at the /2 registry payload fence", () => {
    try {
      const { deps, store } = activeWorld();
      const clarificationId = "clarification-v1-forensic";
      const targetAggregateId = productContractClarificationV2AggregateId(
        PROJECT_ID, V2_CONTRACT_ID, clarificationId,
      );
      expect(dispatchV2(deps, {
        commandId: "command-v2-registry-v1-answer",
        commandKind: PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND,
        credential: V2_OPERATOR_CREDENTIAL,
        origin: "HTTP_LISTENER",
        payload: { answerProjectionDigest: "d".repeat(64), clarificationId,
          contractId: V2_CONTRACT_ID },
        targetAggregateId,
      })).toMatchObject({
        error: { code: "INPUT_INVALID" }, outcome: "REFUSED", stage: "PAYLOAD_SHAPE",
      });
      expect(store.getAggregateVersion(targetAggregateId)).toBe(0);
    } finally {
      closeStores();
    }
  });
});
