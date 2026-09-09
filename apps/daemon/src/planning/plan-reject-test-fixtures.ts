/**
 * ONE durable world for the REJECT journey, shared by every consumer that has to observe it
 * (task-138fab30): the offer ladder, the compile dispatcher and the activity read.
 *
 * WHY A MODULE RATHER THAN A COPY. The world is only meaningful if every consumer sees the SAME
 * one: the successor run id is derived from (runId, commandId), the compile ids are keyed on the
 * revision digest, and the goal/run subjects are derived from the goal-create command id. Two
 * hand-copied builders that drift by a literal produce two different worlds that still both look
 * plausible, and an arm written against one would assert nothing about the other. So the builders
 * live here ONCE and `compile-dispatcher.test.ts` - which authored them (its :50-233 before this
 * module existed) - imports them rather than keeping a second copy.
 *
 * A fixture module carries no cap and needs no test of its own: steps 3-5 each smoke it, so a
 * fixture that stopped reaching PLAN_REVIEW or stopped rejecting would redden three suites.
 */
import { createHash } from "node:crypto";

import type { JsonObject } from "@moe/contracts";
import { productContractGate1Authority } from "@moe/core";
import type { ProductContractRevisionRef } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { humanReviewWitness } from "../bootstrap/bootstrap-ledger-vocabulary.js";
import {
  GOAL_CREATE_COMMAND_ID,
  GOAL_ID,
  PROJECT_ID,
  RUN_ID,
  closeStores,
  driveThrough,
  envelope,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import {
  createProductContractGate1Authority, runProductContractGate1Command,
} from "../product-contract/product-contract-gate-1-command.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
  PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
  productContractGate1SubjectDigest,
} from "../product-contract/product-contract-gate-1-contract.js";
import {
  runProductContractProposeRevision,
} from "../product-contract/product-contract-propose-service.js";
import { runApprovalIntentCommand } from "./approval-intent.js";
import { runSubmitDecomposition } from "./compile-dispatcher.js";
import { currentPlanningRun } from "./current-planning-run.js";

export const PRD = "# Build the widget\n\nRequirements the operator wrote.\n";
export const PRD_SHA = createHash("sha256").update(PRD, "utf8").digest("hex");
const NOW_MS = Date.parse("2026-08-30T12:00:00.000Z");
const encoder = new TextEncoder();

/** The principal the whole journey runs as: gate 1's operator IS the approver. */
export const OPERATOR = "principal-1";

export function boundWorld(): SqliteEventStore {
  const store = openStore();
  installTestRecoveryBinding(store);
  driveThrough(store, "goal.create");
  const outcome = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Bind a PRD for the dispatcher journey.",
    source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
    title: "Dispatcher journey goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
  return store;
}

/** The third criterion exists so a THREE-node graph can bind every criterion exactly once;
 *  it is opt-in so every single-slice arm keeps its two-criterion revision byte-identical. */
export const THIRD_CRITERION = Object.freeze({
  criterion: Object.freeze({
    criterionId: "crit-worker", requirementId: "req-worker",
    statement: "The worker refreshes the record the page renders.",
    supersedesCriterionId: null,
  }),
  requirement: Object.freeze({
    requirementId: "req-worker",
    statement: "Operators see the record stay fresh without asking.",
    supersedesRequirementId: null,
  }),
});

export function committedRevision(
  store: SqliteEventStore, thirdCriterion = false,
): ProductContractRevisionRef {
  const committed = runProductContractProposeRevision(store, {
    correlationId: "corr-dispatch-writer",
    decidedAt: "2026-08-30T12:00:00.000Z",
    payload: {
      draft: {
        authorRef: "compiler-agent-1",
        contractId: "contract-widget",
        criteria: [
          {
            criterionId: "crit-api", requirementId: "req-api",
            statement: "The API answers a signed request with the record.",
            supersedesCriterionId: null,
          },
          {
            criterionId: "crit-ui", requirementId: "req-ui",
            statement: "The page renders the record the API answered.",
            supersedesCriterionId: null,
          },
          ...(thirdCriterion ? [THIRD_CRITERION.criterion] : []),
        ],
        lineage: null,
        requirements: [
          {
            requirementId: "req-api",
            statement: "Operators can read the record over the API.",
            supersedesRequirementId: null,
          },
          {
            requirementId: "req-ui",
            statement: "Operators can see the record in the page.",
            supersedesRequirementId: null,
          },
          ...(thirdCriterion ? [THIRD_CRITERION.requirement] : []),
        ],
        retiredCriterionIds: [],
        retiredRequirementIds: [],
        revisionId: "revision-0001",
        sourceDocumentDigests: [PRD_SHA],
      },
      goalRef: GOAL_ID,
    },
    principalId: "compiler-agent-1",
    projectId: PROJECT_ID,
  });
  if (!committed.ok) throw new Error(`writer refused: ${committed.code}`);
  return committed.ref;
}

/** Gate 1 through the PRODUCTION command: a real paired session approves over the
 *  BEARER arm, which the transport-origin fence now admits from MCP transports only
 *  (the browser journey signs instead - task-ffa05408 family). */
export function approveGate1(store: SqliteEventStore, ref: ProductContractRevisionRef): void {
  const minted = createOperatorSessionHandshakePort({
    capabilities: OPERATOR_CAPABILITIES,
    clock: () => NOW_MS,
    operatorPrincipalId: OPERATOR,
    projectId: PROJECT_ID,
    sessionTtlMs: 60 * 60 * 1000,
    store,
  }).mint();
  if (!minted.ok) throw new Error(`pairing mint refused: ${minted.code}`);
  const authority = createProductContractGate1Authority({
    projectId: PROJECT_ID,
    sessions: createSessionAuthority(store, { clock: () => NOW_MS, projectId: PROJECT_ID }),
    store,
  });
  const gate = productContractGate1Authority(ref);
  const commandId = "cmd-gate1-approve";
  const requestDigest = productContractGate1SubjectDigest({
    commandId, projectId: PROJECT_ID, workRef: gate.workRef,
  });
  const outcome = runProductContractGate1Command(store, encoder.encode(JSON.stringify({
    commandId,
    correlationId: "corr-gate1",
    decidedAt: "2026-08-30T12:00:30.000Z",
    expectedVersion: 0,
    kind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
    payload: {
      authentication: { issuedAt: NOW_MS, kind: "BEARER", requestDigest, requestId: commandId },
      contractId: ref.contractId,
      revisionDigest: ref.revisionDigest,
      revisionId: ref.revisionId,
    },
    principalId: minted.principalId,
    projectId: PROJECT_ID,
    schemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
  })), authority, { sessionId: minted.principalId, transportOrigin: "MCP_HTTP" });
  if (!outcome.ok) throw new Error(`gate 1 refused: ${outcome.code}`);
}

const NODE_SCOPES = Object.freeze({
  capability: "capability-implement",
  readScopes: ["services/api/src"],
  resources: ["resource-a"],
  verificationRecipeRefs: ["recipe-a"],
  writeScopes: ["services/api/src/node"],
});

export function nodeOf(
  nodeKey: string,
  criterionIds: readonly string[],
  dependsOn: readonly string[] = [],
  objective = `Land the ${nodeKey} slice.`,
): Record<string, unknown> {
  return {
    ...NODE_SCOPES, criterionIds: [...criterionIds], dependsOn: [...dependsOn], nodeKey, objective,
  };
}

/** The SINGLE-SLICE default, unchanged: N=1 is one shape the compiler admits, not the only one. */
export function structureOf(
  nodes: readonly Record<string, unknown>[] = [
    nodeOf("node-slice", ["crit-api", "crit-ui"], [], "Land the record read and its page."),
  ],
  completionNodeKey = "node-slice",
): Record<string, unknown> {
  return { completionNodeKey, nodes: nodes.map((node) => ({ ...node })) };
}

export function submit(
  store: SqliteEventStore, ref: ProductContractRevisionRef,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof runSubmitDecomposition> {
  return runSubmitDecomposition(store, {
    correlationId: "corr-submit-decomp",
    decidedAt: "2026-08-30T12:01:00.000Z",
    payload: {
      gateRef: {
        contractId: ref.contractId, revisionDigest: ref.revisionDigest,
        revisionId: ref.revisionId,
      },
      goalRef: GOAL_ID,
      structure: structureOf(),
      ...overrides,
    },
    principalId: OPERATOR,
    projectId: PROJECT_ID,
  });
}

/** The dependency assertion every intent carries, spelled as approval-intent.test.ts:128 does. */
const dependencyChanges = (): JsonObject =>
  ({ additions: [], challenges: [], removals: [] });

function decide(
  store: SqliteEventStore, runId: string, decision: string,
  decisionReason: string, commandId: string,
): void {
  const outcome = runApprovalIntentCommand({
    commandId,
    correlationId: "corr-plan-decision",
    decidedAt: "2026-08-30T12:02:00.000Z",
    // The seam fences on the run's OWN current version and refuses a stale one under
    // BOOTSTRAP_EXPECTED_VERSION_STALE, so the fixture reads it rather than hard-coding a number
    // that would rot the first time the compile fold's event count changed.
    expectedVersion: store.getAggregateVersion(runId),
    humanReview: humanReviewWitness(OPERATOR, commandId),
    payload: { decision, decisionReason, dependencyChanges: dependencyChanges(), runId },
    principalId: OPERATOR,
    projectId: PROJECT_ID,
    store,
    targetAggregateId: runId,
  });
  if (!outcome.ok) {
    throw new Error(`${decision} refused: ${outcome.code} @ ${String(outcome.refusedBy)}`);
  }
}

/**
 * Rejects `runId` and answers the SUCCESSOR the rejection minted - read back through the
 * PRODUCTION resolver, never recomputed here: a fixture that re-derived the id from
 * `successorRunIdFor` would keep answering after the resolver stopped following the chain, and
 * every arm built on it would be asserting the fixture's arithmetic instead of the product's.
 */
export function rejectPlan(
  store: SqliteEventStore, runId: string, reason: string,
  commandId = `cmd-reject-${runId}`,
): string {
  decide(store, runId, "REJECT", reason, commandId);
  return currentPlanningRun(store, runId).runId;
}

/** The APPROVE half, same seam and same witness: an approval commits a GoalState. */
export function approvePlan(
  store: SqliteEventStore, runId: string, commandId = `cmd-approve-${runId}`,
): void {
  decide(store, runId, "APPROVE", "the plan is sound", commandId);
}

export interface RejectedWorld {
  readonly goalId: string;
  readonly originalRunId: string;
  readonly ref: ProductContractRevisionRef;
  readonly store: SqliteEventStore;
  readonly successorRunId: string;
}

/** bound goal -> revision -> gate 1 -> compiled INITIAL plan at PLAN_REVIEW -> REJECTED. */
export function rejectedWorld(reason: string): RejectedWorld {
  const store = boundWorld();
  const ref = committedRevision(store);
  approveGate1(store, ref);
  const sealed = submit(store, ref);
  if (!sealed.ok) throw new Error(`fixture submit refused: ${sealed.code} @ ${sealed.layer}`);
  const originalRunId = sealed.runId;
  const successorRunId = rejectPlan(store, originalRunId, reason);
  if (successorRunId === originalRunId) {
    throw new Error("fixture reject minted no successor: the resolver still answers the old run");
  }
  return Object.freeze({ goalId: GOAL_ID, originalRunId, ref, store, successorRunId });
}

/** Re-exported so a consumer names ONE module for the world and its teardown, not two. */
export { GOAL_ID, PROJECT_ID, RUN_ID, closeStores };
