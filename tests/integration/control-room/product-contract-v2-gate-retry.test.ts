import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject, RuntimeCommandEnvelope } from "@moe/contracts";
import { productContractGate1Authority } from "@moe/core";
import { SQLITE_SCHEMA_MANIFEST_VERSION, SqliteEventStore } from "@moe/store";
import type { CommandDecisionRecord } from "@moe/store";
import { afterEach, expect, it } from "vitest";

import {
  GOAL_CREATE_COMMAND_ID,
  GOAL_ID,
  PROJECT_ID,
  driveThrough,
  envelope,
  send,
} from "../../../apps/daemon/src/bootstrap/bootstrap-test-fixtures.ts";
import {
  CUTOVER_ACTIVATION_MARKER_EVENT_TYPE,
  composeCutoverActivationMarker,
  deriveCutoverActivationMarkerAggregateId,
  encodeCutoverActivationMarker,
} from "../../../apps/daemon/src/cutover/cutover-activation-marker.js";
import {
  V2_READINESS_MANIFEST_EVENT_TYPE,
  V2_READINESS_MANIFEST_SCHEMA_VERSION,
  deriveV2ReadinessManifestAggregateId,
  digestV2ReadinessManifest,
  encodeV2ReadinessManifest,
} from "../../../apps/daemon/src/cutover/v2-readiness-manifest.js";
import { V2_SURFACE_MANIFEST_SHA256 }
  from "../../../apps/daemon/src/cutover/v2-surface-manifest.js";
import { startDaemon }
  from "../../../apps/daemon/src/daemon-entry.js";
import { createStoreDependencies }
  from "../../../apps/daemon/src/daemon-store-dependencies.js";
import { createSessionAuthority }
  from "../../../apps/daemon/src/identity/session-authority.js";
import { installTestRecoveryBinding }
  from "../../../apps/daemon/src/identity/session-test-fixtures.ts";
import {
  PRODUCT_CONTRACT_GATE_1_EVENT_TYPE,
  deriveProductContractGate1AggregateId,
} from "../../../apps/daemon/src/product-contract/product-contract-gate-1-contract.js";
import {
  PRODUCT_CONTRACT_V2_WORKFLOW_EVENT_TYPE,
  decodeProductContractV2WorkflowHead,
  deriveProductContractV2WorkflowAggregateId,
} from "../../../apps/daemon/src/product-contract/product-contract-v2-workflow-contract.js";
import { runProductContractProposeRevisionV2 }
  from "../../../apps/daemon/src/product-contract/product-contract-v2-propose-service.js";
import {
  presentGate1Approval,
  readPendingContract,
  type Gate1DaemonSubmission,
  type Gate1PendingView,
} from "../../../apps/control-room/src/v2/goals/gate1-approval.js";
import {
  createCompatGate,
  createControlRoomTransport,
} from "../../../packages/control-room-client/src/index.js";
import type {
  ControlRoomClientSurface,
  ControlRoomTransport,
  FetchLike,
} from "../../../packages/control-room-client/src/index.js";
import { GENERATED_CONTRACT_PINS }
  from "../../../packages/control-room-client/src/generated/generated-client.js";

const NOW = "2026-08-31T18:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const HUMAN_ID = "operator-v2-gate-retry";
const HUMAN_CREDENTIAL = "credential-v2-gate-retry";
const CONTRACT_ID = "contract-v2-gate-retry";
const REVISION_ID = "revision-v2-gate-retry";
const PRD = "# Gate retry\n\nOne human approval must survive a daemon restart.\n";
const PRD_SHA256 = createHash("sha256").update(PRD, "utf8").digest("hex");
const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

const hex = (digit: string): string => digit.repeat(64);
const requirement = (requirementId: string, dependencies: readonly string[] = []) => ({
  dependsOnRequirementIds: [...dependencies],
  priority: "MUST" as const,
  requirementId,
  statement: `${requirementId} must hold.`,
  supersedesRequirementId: null,
});
const criterion = (criterionId: string, requirementId: string) => ({
  criterionId,
  requirementId,
  statement: `${criterionId} is observable.`,
  supersedesCriterionId: null,
  verification: `Run deterministic ${criterionId} verification.`,
});
const CRITERIA = Object.freeze([
  "criterion-deployment", "criterion-keyboard", "criterion-latency",
  "criterion-login", "criterion-runtime", "criterion-session",
]);

function draft(): Record<string, unknown> {
  return {
    assumptions: [{ assumptionId: "assumption-browser", statement: "A browser exists.",
      validationCriterionId: "criterion-runtime" }],
    authorRef: HUMAN_ID,
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
    retiredCriterionIds: [],
    retiredRequirementIds: [],
    revisionId: REVISION_ID,
    securityPrivacyRequirements: [requirement("security-session", ["requirement-login"])],
    sourceDocumentDigests: [PRD_SHA256],
    successMetrics: [{ measurement: "Count successful sessions.", metricId: "metric-first-use",
      objectiveIds: ["objective-adoption"], statement: "Users finish.", target: "80 percent." }],
    technologyRequirements: [requirement("technology-runtime")],
    userJobs: [{ job: "Reach the product.", user: "Operator", userJobId: "job-access" }],
    uxAccessibilityRequirements: [requirement("ux-keyboard", ["requirement-login"])],
  };
}

function commitEvent(
  store: SqliteEventStore,
  aggregateId: string,
  commandId: string,
  eventType: string,
  schemaVersion: string,
  payload: Uint8Array,
): void {
  store.commit({
    aggregateId,
    commandBytes: payload,
    commandId,
    committedAt: NOW,
    events: [{ domainSchemaVersion: schemaVersion, eventId: `${commandId}-event`,
      eventType, payload }],
    expectedVersion: 0,
  });
}

function activateV2(store: SqliteEventStore): void {
  const sourceCommit = "a".repeat(40);
  const generations = {
    backupGenerationDigest: hex("1"),
    distributionManifestSha256: hex("2"),
    importGenerationSha256: hex("3"),
    quiesceRecordSha256: hex("4"),
  };
  const readiness = {
    acceptanceEvidenceSha256: hex("5"),
    backupEvidenceSha256: hex("6"),
    ...generations,
    contractSchemaSha256: hex("7"),
    deliveryProfileQualificationEvidenceSha256: hex("8"),
    restoreDrillSha256: hex("9"),
    schemaVersion: V2_READINESS_MANIFEST_SCHEMA_VERSION,
    securityEvidenceSha256: hex("a"),
    sourceCommit,
    storeMigrationEvidenceSha256: hex("b"),
    storeSchemaVersion: SQLITE_SCHEMA_MANIFEST_VERSION,
    surfaceManifestSha256: V2_SURFACE_MANIFEST_SHA256,
    windowsPackagingEvidenceSha256: hex("c"),
  };
  commitEvent(
    store,
    deriveV2ReadinessManifestAggregateId(PROJECT_ID),
    "readiness-v2-gate-retry",
    V2_READINESS_MANIFEST_EVENT_TYPE,
    V2_READINESS_MANIFEST_SCHEMA_VERSION,
    encodeV2ReadinessManifest(readiness),
  );
  const composed = composeCutoverActivationMarker({
    activatedAtEpochMs: NOW_MS,
    generations,
    readinessManifestSha256: digestV2ReadinessManifest(readiness),
    readinessManifestVersion: 1,
    sourceCommit,
    sourceState: "ACTIVATE_APPROVED",
  });
  if (!composed.ok) throw new Error("v2 activation fixture refused");
  commitEvent(
    store,
    deriveCutoverActivationMarkerAggregateId(PROJECT_ID),
    "activation-v2-gate-retry",
    CUTOVER_ACTIVATION_MARKER_EVENT_TYPE,
    composed.marker.schemaVersion,
    encodeCutoverActivationMarker(composed.marker),
  );
}

function eventCount(store: SqliteEventStore, eventType: string): number {
  const page = store.readEventsByTypeAfter(eventType, 0n, 100);
  if (page.hasMore) throw new Error(`${eventType} exceeded the bounded integration page`);
  return page.items.length;
}

function seed(storePath: string): Readonly<{ markerEvents: number; workflowEvents: number }> {
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try {
    driveThrough(store, "goal.create");
    const bound = send(store, envelope("goal.create_with_source", 0, {
      instructions: "Prove one browser Gate retry across daemon reconstruction.",
      source: { displayPath: "docs/gate-retry.md", mediaType: "text/markdown", text: PRD },
      title: "Product Contract v2 Gate retry",
    }, GOAL_CREATE_COMMAND_ID));
    if (!bound.ok) throw new Error(`source-bound goal refused: ${bound.code}`);
    installTestRecoveryBinding(store);
    activateV2(store);
    const sessions = createSessionAuthority(store, { clock: () => NOW_MS, projectId: PROJECT_ID });
    const human = sessions.createPrincipal({
      commandId: "create-v2-gate-retry-human",
      correlationId: "correlate-v2-gate-retry-human",
      kind: "HUMAN",
      principalId: HUMAN_ID,
      profileRevisionId: "profile-v2-gate-retry-human",
    });
    if (!human.ok) throw new Error(`durable human refused: ${human.code}`);
    const proposed = runProductContractProposeRevisionV2(store, {
      commandId: "command-v2-gate-retry-propose",
      correlationId: "correlation-v2-gate-retry-propose",
      decidedAt: NOW,
      payload: { draft: draft(), goalRef: GOAL_ID },
      principalId: HUMAN_ID,
      projectId: PROJECT_ID,
      targetAggregateId: GOAL_ID,
    });
    if (!proposed.ok) throw new Error(`v2 proposal refused: ${proposed.code}@${proposed.layer}`);
    return Object.freeze({
      markerEvents: eventCount(store, "SessionAuthorityReplayObserved"),
      workflowEvents: eventCount(store, PRODUCT_CONTRACT_V2_WORKFLOW_EVENT_TYPE),
    });
  } finally {
    store.close();
  }
}

function client(): ControlRoomClientSurface {
  const gate = createCompatGate({
    apiCompatibilityRange: {
      commandEnvelopeVersion: GENERATED_CONTRACT_PINS.commandEnvelopeVersion,
      errorRegistryVersion: GENERATED_CONTRACT_PINS.errorRegistryVersion,
      queryEnvelopeVersion: GENERATED_CONTRACT_PINS.queryEnvelopeVersion,
    },
    buildToolVersions: { node: "24.16.0", typescript: "7.0.2" },
    contractSchemaHash: GENERATED_CONTRACT_PINS.contractDigest,
  });
  if (!gate.ok) throw new Error("matching generated Control Room surface refused");
  return gate.client;
}

function fetchSupplyingOrigin(origin: string): FetchLike {
  return async (input, init) => {
    const headers = new Headers(init.headers);
    headers.set("origin", origin);
    return await fetch(input, { ...init, headers });
  };
}

function transportFor(
  daemon: Readonly<{ csrfToken: string; origin: string }>,
  surface: ControlRoomClientSurface,
): ControlRoomTransport {
  return createControlRoomTransport({
    commandAuthorityPlane: "V2",
    csrfToken: daemon.csrfToken,
    fetch: fetchSupplyingOrigin(daemon.origin),
    origin: daemon.origin,
    sessionCredential: HUMAN_CREDENTIAL,
    wireProtocolVersion: surface.wireProtocolVersion,
  });
}

function approvalEnvelope(
  surface: ControlRoomClientSurface,
  submission: Gate1DaemonSubmission,
  payload: Readonly<Record<string, unknown>>,
): RuntimeCommandEnvelope {
  const built = surface.commands["product_contract.approve_gate_1"](
    submission.affordance as never,
    {
      correlationId: submission.correlationId,
      payload: payload as JsonObject,
      requestDigest: submission.requestDigest,
      sessionCredential: HUMAN_CREDENTIAL,
    },
  );
  if (!built.ok) throw new Error(`generated Gate builder refused: ${built.error.code}`);
  return built.envelope;
}

async function pendingFrom(
  daemon: Readonly<{ csrfToken: string; origin: string }>,
  surface: ControlRoomClientSurface,
): Promise<Gate1PendingView> {
  const headers = {
    "content-type": "application/json",
    origin: daemon.origin,
    "x-moe-csrf": daemon.csrfToken,
    "x-moe-protocol-version": surface.wireProtocolVersion,
    "x-moe-session-credential": HUMAN_CREDENTIAL,
  };
  const pending = await readPendingContract(
    headers, GOAL_ID, PROJECT_ID, async (body) => await fetch(
      `${daemon.origin}/v2/product-contract/pending/read`,
      { body, headers, method: "POST" },
    ),
  );
  if (pending.status !== "PENDING") {
    throw new Error(`daemon pending read refused: ${JSON.stringify(pending)}`);
  }
  return pending;
}

it("replays the daemon-issued Gate 1 card after restart when only issuedAt changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-v2-gate-retry-integration-"));
  directories.push(directory);
  const storePath = join(directory, "store.db");
  const baseline = seed(storePath);
  expect(baseline).toEqual({ markerEvents: 0, workflowEvents: 1 });
  const surface = client();
  const csrfToken = "csrf-v2-gate-retry";
  const provider = () => createStoreDependencies({
    clock: () => NOW,
    credential: HUMAN_CREDENTIAL,
    principalId: HUMAN_ID,
    projectId: PROJECT_ID,
    storePath,
  });

  let approval: Gate1DaemonSubmission | null = null;
  let firstDecision: CommandDecisionRecord | null = null;
  const firstProvider = provider();
  const firstDaemon = await startDaemon({ csrfToken, dependencies: firstProvider });
  if (!firstDaemon.ok) {
    firstProvider.close();
    throw new Error(`first daemon start refused: ${firstDaemon.code}`);
  }
  try {
    const pending = await pendingFrom(firstDaemon, surface);
    expect(pending.clarifications).toEqual([]);
    if (pending.approval === null) throw new Error("daemon withheld the ready Gate approval");
    approval = pending.approval;
    const first = await transportFor(firstDaemon, surface).sendCommand(approvalEnvelope(
      surface,
      approval,
      presentGate1Approval(approval, NOW_MS),
    ));
    expect(first).toMatchObject({
      delivered: true,
      response: {
        decision: { commandId: approval.commandId, disposition: "DECIDED",
          resultCode: "EFFECTS_COMMITTED" },
        ok: true,
        outcome: "ACCEPTED",
      },
      status: 200,
    });
    const beforeShutdown = SqliteEventStore.openForProject(storePath, PROJECT_ID);
    try {
      firstDecision = beforeShutdown.getCommandDecision({
        commandId: approval.commandId,
        principalId: HUMAN_ID,
        projectId: PROJECT_ID,
      });
      expect(firstDecision).toMatchObject({
        commandKind: "product_contract.approve_gate_1",
        effectDisposition: "EFFECTS_COMMITTED",
        key: { commandId: approval.commandId, principalId: HUMAN_ID, projectId: PROJECT_ID },
        targetAggregateId: approval.affordance.targetAggregateId,
      });
      if (firstDecision === null || firstDecision.effectDisposition !== "EFFECTS_COMMITTED") {
        throw new Error("first Gate decision was not durably readable before shutdown");
      }
      for (const digest of [firstDecision.correlationSha256, firstDecision.decisionSha256,
        firstDecision.effectSha256, firstDecision.replayRequestSha256,
        firstDecision.requestSha256, firstDecision.resultSha256]) {
        expect(digest).toMatch(/^[0-9a-f]{64}$/u);
      }
    } finally {
      beforeShutdown.close();
    }
  } finally {
    await firstDaemon.shutdown();
    firstProvider.close();
  }
  if (approval === null) throw new Error("first daemon emitted no approval");
  if (firstDecision === null) throw new Error("first daemon persisted no Gate decision");
  const emittedApproval = approval;
  const durableDecision = firstDecision;

  // A genuinely new provider and listener reopen the SQLite file; no command or
  // workflow port from the first attempt survives to answer this retry.
  const reopenedProvider = provider();
  const reopenedDaemon = await startDaemon({ csrfToken, dependencies: reopenedProvider });
  if (!reopenedDaemon.ok) {
    reopenedProvider.close();
    throw new Error(`reopened daemon start refused: ${reopenedDaemon.code}`);
  }
  try {
    const replay = await transportFor(reopenedDaemon, surface).sendCommand(approvalEnvelope(
      surface,
      emittedApproval,
      presentGate1Approval(emittedApproval, NOW_MS + 1),
    ));
    expect(replay).toMatchObject({
      delivered: true,
      response: {
        decision: { commandId: emittedApproval.commandId, disposition: "REPLAYED",
          resultCode: "EFFECTS_COMMITTED" },
        ok: true,
        outcome: "ACCEPTED",
      },
      status: 200,
    });

    const changedDigestPayload = presentGate1Approval(
      { ...emittedApproval, requestDigest: "d".repeat(64) },
      NOW_MS + 2,
    );
    // Keep the daemon-issued envelope digest and identity fixed. Only the bearer
    // subject pointer changes, so the named durable replay fence must own the refusal.
    expect((changedDigestPayload.authentication as Readonly<Record<string, unknown>>)
      .requestDigest).not.toBe(emittedApproval.requestDigest);
    const conflict = await transportFor(reopenedDaemon, surface).sendCommand(approvalEnvelope(
      surface,
      emittedApproval,
      changedDigestPayload,
    ));
    expect(conflict).toMatchObject({
      delivered: true,
      response: {
        outcome: "PORT_REFUSED",
        refusal: { code: "IDEMPOTENCY_CONFLICT", layer: "DURABLE_STORE" },
        stage: "DISPATCH",
      },
    });
  } finally {
    await reopenedDaemon.shutdown();
    reopenedProvider.close();
  }

  const reader = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try {
    const gate = productContractGate1Authority({
      contractId: CONTRACT_ID,
      revisionDigest: emittedApproval.payload.revisionDigest!,
      revisionId: REVISION_ID,
    });
    const gateEvents = reader.readEvents(deriveProductContractGate1AggregateId(gate.workRef));
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]?.eventType).toBe(PRODUCT_CONTRACT_GATE_1_EVENT_TYPE);

    const workflowEvents = reader.readEvents(
      deriveProductContractV2WorkflowAggregateId(PROJECT_ID, CONTRACT_ID),
    );
    expect(workflowEvents).toHaveLength(baseline.workflowEvents + 1);
    const workflowHeads = workflowEvents.map((event) =>
      decodeProductContractV2WorkflowHead(event.payload));
    const gateCompanions = workflowHeads.filter((head) =>
      head?.cause.kind === "GATE_1" && head.cause.commandId === emittedApproval.commandId);
    expect(gateCompanions).toHaveLength(1);
    const gateCompanion = workflowHeads.at(-1);
    expect(gateCompanion?.cause).toMatchObject({
      commandId: emittedApproval.commandId,
      kind: "GATE_1",
    });
    expect(eventCount(reader, "SessionAuthorityReplayObserved"))
      .toBe(baseline.markerEvents + 1);
    expect(reader.getCommandDecision({
      commandId: emittedApproval.commandId,
      principalId: HUMAN_ID,
      projectId: PROJECT_ID,
    })).toStrictEqual(durableDecision);
  } finally {
    reader.close();
  }
}, 120_000);
