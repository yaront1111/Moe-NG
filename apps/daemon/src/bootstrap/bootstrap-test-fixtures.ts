import { SqliteEventStore } from "@moe/store";

import { GOAL_HANDLERS } from "../goals/goal-services.js";
import { PLANNING_HANDLERS } from "../planning/planning-services.js";
import { BOOTSTRAP_SCHEMA_VERSION } from "./bootstrap-contracts.js";
import { readDurableLedger } from "./bootstrap-ledger.js";
import type { HandlerTable, ServiceOutcome } from "./bootstrap-ledger.js";
import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "./bootstrap-services.js";

/**
 * Shared request fixtures for the bootstrap, goal and planning service suites.
 *
 * This module builds inputs and drives the PRODUCTION pipeline; it deliberately reimplements
 * no rule. `send` calls `runBootstrapCommand` and `decisionCount` reads through
 * `readDurableLedger`, so an assertion here is an assertion about production code — a helper
 * that restated the ingress or sequence rules would let a suite stay green while the shipped
 * rule drifted away from it.
 */

export const PROJECT_ID = "project-1";
export const GOAL_ID = "goal-1";
export const RUN_ID = "run-1";

const encoder = new TextEncoder();
const openStores: SqliteEventStore[] = [];

export function hex64(seed: string): string {
  const base = seed.replace(/[^0-9a-f]/gu, "0");
  return (base + "0".repeat(64)).slice(0, 64);
}

export const POLICY_REF = hex64("a1b2c3");
export const SUBMISSION_HASH = hex64("dec0de");

export function openStore(): SqliteEventStore {
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  openStores.push(store);
  return store;
}

export function closeStores(): void {
  while (openStores.length > 0) openStores.pop()?.close();
}

export interface Envelope {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly expectedVersion: number;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly principalId: string;
  readonly projectId: string;
  readonly schemaVersion: string;
}

export function envelope(
  kind: string,
  expectedVersion: number,
  payload: Record<string, unknown>,
  commandId = `cmd-${kind}`,
): Envelope {
  return {
    commandId,
    correlationId: "corr-1",
    decidedAt: "2026-08-08T00:00:00.000Z",
    expectedVersion,
    kind,
    payload,
    principalId: "principal-1",
    projectId: PROJECT_ID,
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
  };
}

export const ALL_HANDLERS: HandlerTable = Object.freeze({
  ...BOOTSTRAP_HANDLERS,
  ...GOAL_HANDLERS,
  ...PLANNING_HANDLERS,
});

export function send(store: SqliteEventStore, request: Envelope): ServiceOutcome {
  return runBootstrapCommand(store, encoder.encode(JSON.stringify(request)), ALL_HANDLERS);
}

export function decisionCount(store: SqliteEventStore): number {
  return readDurableLedger(store, PROJECT_ID).decisionCount;
}

export const OBSERVATION = Object.freeze({
  baseRevisionHash: hex64("beef"),
  repositoryRef: "repo-1",
  scopeRef: "scope-1",
  truthClass: "DAEMON_VERIFIED",
});

export const ACTIVATION_WITNESS = Object.freeze({
  artifactPathRef: "artifact-1",
  backupPathRef: "backup-1",
  credentialRef: "credential-1",
  distributionManifestHash: hex64("cafe"),
  policyRevisionHash: hex64("face"),
  providerMinimumProfileRef: "provider-profile-1",
  signingKeyRef: "signing-1",
  storeDriverRef: "store-driver-1",
  truthClass: "DAEMON_VERIFIED",
});

/**
 * `sliceRef` is a 64-hex string on purpose: `validateEvaluationInput` requires
 * `policyRevisionRef` to be hex64 while `validSlice` accepts any non-empty ref, so a slice
 * installed under a human-readable ref could never be named by a valid evaluation input.
 */
export const POLICY_SLICE = Object.freeze({
  autoApprovalOptIns: [],
  rules: [],
  sliceRef: POLICY_REF,
});

export function evaluationInput(policyRevisionRef: string): Record<string, unknown> {
  return {
    action: "plan.approve",
    actor: "principal-1",
    callerRiskHint: null,
    decisionDigest: hex64("d1"),
    evaluatedAtEpochMs: 1_760_000_000_000,
    evaluatorVersion: "evaluator-1",
    facts: [],
    graphNodeRevisionRefs: [],
    policyRevisionRef,
    requiredFactIds: [],
    scope: [],
    sliceChain: [POLICY_SLICE],
    waivers: [],
  };
}

export function goalPayload(): Record<string, unknown> {
  return {
    budgetAccountRef: "budget-account-1",
    goalId: GOAL_ID,
    planningRunRef: RUN_ID,
    witness: { projectReadyRef: "ready-1", truthClass: "DAEMON_VERIFIED" },
  };
}

/** The core planning-run commands that carry a fresh run to PLANNING and then propose. */
export function planningChain(): readonly Record<string, unknown>[] {
  return [
    {
      commandId: "chain-create",
      expectedVersion: 0,
      goalRef: GOAL_ID,
      kind: "planning.create_draft",
      runId: RUN_ID,
      runKind: "INITIAL",
    },
    {
      commandId: "chain-ready",
      expectedVersion: 1,
      kind: "planning.ready",
      witness: {
        acceptanceCriteriaRef: "criteria-1",
        intentBaseRef: "intent-1",
        planningBudgetRef: "budget-1",
        truthClass: "DAEMON_VERIFIED",
      },
    },
    {
      commandId: "chain-claim",
      expectedVersion: 2,
      kind: "planning.claim",
      witness: {
        attemptRef: "attempt-1",
        contextRef: "context-1",
        leaseRef: "lease-1",
        providerSlotRef: "slot-1",
        truthClass: "DAEMON_VERIFIED",
      },
    },
    {
      commandId: "chain-propose",
      effectTerminalProof: {
        effectTerminalRef: "effect-terminal-1",
        resourcesTerminalRef: "resources-terminal-1",
        truthClass: "DAEMON_VERIFIED",
      },
      expectedVersion: 3,
      kind: "plan.propose",
      proposalKind: "INITIAL",
      submissionHash: SUBMISSION_HASH,
      witness: {
        attemptRef: "attempt-1",
        submissionRef: "submission-1",
        truthClass: "DAEMON_VERIFIED",
      },
    },
  ];
}

export function approvalCommand(): Record<string, unknown> {
  return {
    decision: "APPROVE",
    decisionReason: "reason-1",
    kind: "approval.decide",
    stepUpAuthRef: "stepup-1",
  };
}

export const GRAPH_REVISION_REF = "graph-revision-1";

/**
 * The core's `PlanningActivationWitness` (planning-command-contract.ts:117). The daemon consumes
 * `expectedGoalVersion` and hands it to `reduceGoal`; every other field is the caller's evidence.
 * `expectedGoalVersion` is 1 because the approval follows `goal.create`, which leaves the goal at
 * domain version 1.
 */
export function planningActivation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    activationRef: "activation-1",
    budgetHash: hex64("b0"),
    expectedGoalVersion: 1,
    goalDraftNoActiveRevision: true,
    graphHash: hex64("6a"),
    policyHash: hex64("b1"),
    qualityHash: hex64("dd"),
    truthClass: "HUMAN_APPROVED",
    ...overrides,
  };
}

/** J1's second human action: one approval that also activates the initial graph (design 299). */
export function approvalPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    activation: planningActivation(),
    command: approvalCommand(),
    graphRevisionRef: GRAPH_REVISION_REF,
    record: approvalRecord(SUBMISSION_HASH),
    runId: RUN_ID,
    ...overrides,
  };
}

/** The core's `AcceptanceClosureWitness`: the verified result and the obligations that hold. */
export function closureWitness(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    acceptanceClosureRef: "acceptance-1",
    completionNodeAcceptedRef: "completion-node-1",
    noCurrentPreparationGeneration: true,
    noPendingDraftOrSupersession: true,
    obligationsHoldRef: "obligations-1",
    truthClass: "HUMAN_APPROVED",
    ...overrides,
  };
}

/** The core's `ZeroAuthorityWitness`: no authority outlives the accepted goal. */
export function zeroAuthorityWitness(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    truthClass: "DAEMON_VERIFIED",
    zeroAuthorityProofRef: "zero-authority-1",
    ...overrides,
  };
}

/** J1's third human action: final acceptance of the verified, reviewed result. */
export function acceptancePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    closureWitness: closureWitness(),
    goalId: GOAL_ID,
    zeroAuthorityWitness: zeroAuthorityWitness(),
    ...overrides,
  };
}

export function approvalRecord(exactRevisionHash: string): Record<string, unknown> {
  return {
    actor: "human-1",
    actorKind: "HUMAN",
    applicablePolicyRef: hex64("aa"),
    approvalRef: "approval-1",
    approvedNodeScope: ["node-1"],
    budgetRef: hex64("bb"),
    criteriaRef: hex64("cc"),
    decision: null,
    decisionReason: null,
    dependencyChanges: { additions: [], challenges: [], removals: [] },
    exactRevisionHash,
    lifecycle: "PENDING",
    planQualityAssessmentRef: hex64("dd"),
    policyDecisionRef: null,
    riskTier: "R2",
    stepUpAuthRef: "stepup-1",
    truthClass: "HUMAN_APPROVED",
    validity: "CURRENT",
  };
}

/** The ten owned commands in durable order; every other fixture is derived from this list. */
export function bootstrapSequence(): readonly Envelope[] {
  return [
    envelope("project.register", 0, { owner: "owner-1" }),
    envelope("project.bind_repository", 1, { observation: OBSERVATION }),
    envelope("provider.probe", 0, {
      observation: {
        providerMinimumProfileRef: "provider-profile-1",
        truthClass: "DAEMON_VERIFIED",
      },
    }),
    envelope("policy.install", 0, { slice: POLICY_SLICE }),
    envelope("policy.validate", 1, { input: evaluationInput(POLICY_REF) }),
    envelope("project.activate", 2, { witness: ACTIVATION_WITNESS }),
    envelope("goal.create", 0, goalPayload()),
    envelope("plan.propose", 0, { commands: planningChain(), runId: RUN_ID }),
    envelope("approval.decide", 0, approvalPayload()),
    // The goal is at domain version 2 here: `goal.create` left it at 1 and the approval's
    // activation half advanced it to 2 in the same decision.
    envelope("goal.close", 2, acceptancePayload()),
  ];
}

/**
 * Drives the durable sequence up to but NOT including `upToKind`, through the production
 * pipeline. It throws rather than swallowing a setup refusal, so a fixture that silently stops
 * short cannot leave a later assertion testing an empty store.
 */
export function driveThrough(store: SqliteEventStore, upToKind: string): void {
  for (const request of bootstrapSequence()) {
    if (request.kind === upToKind) return;
    const outcome = send(store, request);
    if (!outcome.ok) {
      throw new Error(`fixture setup failed at ${request.kind}: ${outcome.code}`);
    }
  }
}
