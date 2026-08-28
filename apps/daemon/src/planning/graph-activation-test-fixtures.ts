/** Production-writer fixture for one or two sealed, approvable goals in one project. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "@moe/contracts";
import { applyApprovalCommand } from "@moe/core";
import type { ApprovalDecisionRecord, ApprovalPolicy } from "@moe/core";
import { SqliteEventStore } from "@moe/store";

import { BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import type { BootstrapRequest } from "../bootstrap/bootstrap-contracts.js";
import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import type { HandlerContext } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_ID,
  GRAPH_REVISION_REF,
  PROJECT_ID,
  RUN_ID,
  SEALED_SUBMISSION_HASH,
  approvalCommand,
  approvalRecord,
  closeStores as closeBootstrapStores,
  driveThrough,
  envelope,
  goalPayload,
  hex64,
  openStore,
  sealedPlanningChain,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { readCurrentActiveGraph } from "./active-graph-projection.js";
import { verifyApprovedRunBinding } from "./approval-run-binding.js";
import type { GraphActivationInput } from "./graph-activation-service.js";
import { journeyAuthority } from "./journey-authority-bodies.js";

export { GOAL_ID, GRAPH_REVISION_REF, PROJECT_ID, RUN_ID } from
  "../bootstrap/bootstrap-test-fixtures.js";

export const SECOND_GOAL_ID = "goal-2";
export const SECOND_RUN_ID = "run-2";
export const SECOND_GRAPH_REVISION_REF = "graph-revision-goal-2";

const SECOND_AUTHORITY = journeyAuthority({
  authorRef: "architect-2", criterionIds: ["criterion-c"],
  graphRevisionRef: SECOND_GRAPH_REVISION_REF,
  idPrefix: SECOND_RUN_ID, nodeIds: ["node-b"],
  stepDescription: "Land the second journey plan.",
});
export const SECOND_SUBMISSION_HASH = SECOND_AUTHORITY.submissionHash;
export const SECOND_GRAPH_CONTENT_HASH = SECOND_AUTHORITY.graphContentHash;
const fileStores: SqliteEventStore[] = [];
const fileDirectories: string[] = [];
const storePaths = new WeakMap<SqliteEventStore, string>();

export const REQUIRE_HUMAN_POLICY: ApprovalPolicy = Object.freeze({ kind: "REQUIRE_HUMAN" });

/** No caller hash: accepted controls prove the server produced the binding values. */
export function activationWitness(overrides: Record<string, unknown> = {}): JsonObject {
  return {
    activationRef: "activation-1",
    expectedGoalVersion: 1,
    truthClass: "HUMAN_APPROVED",
    ...overrides,
  } as JsonObject;
}

export function requestFor(commandId: string, payload: JsonObject = {}): BootstrapRequest {
  return {
    commandId, correlationId: "corr-1", decidedAt: "2026-08-08T00:00:00.000Z",
    expectedVersion: 0, kind: "approval.decide", payload, principalId: "principal-1",
    projectId: PROJECT_ID,
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
  };
}

/** The ledger is re-read per context: a stale one is how a concurrent-activation arm is built. */
export function contextFor(
  store: SqliteEventStore,
  request: BootstrapRequest,
): HandlerContext {
  return { ledger: readDurableLedger(store, PROJECT_ID), request, store };
}

export function decidedApproval(): ApprovalDecisionRecord {
  const verdict = applyApprovalCommand(approvalRecord(SEALED_SUBMISSION_HASH), approvalCommand());
  if (!verdict.ok) throw new Error(`fixture approval refused: ${verdict.error.code}`);
  return verdict.value;
}

export function durableRun(store: SqliteEventStore): JsonValue {
  const run = stateOf(readDurableLedger(store, PROJECT_ID), RUN_ID);
  if (run === undefined) throw new Error("fixture run is not durable");
  return run;
}

export function inputFor(
  store: SqliteEventStore,
  overrides: Partial<GraphActivationInput> = {},
): GraphActivationInput {
  const run = durableRun(store);
  const bound = verifyApprovedRunBinding({
    graphRevisionRef: GRAPH_REVISION_REF, run, runId: RUN_ID, store,
  });
  if (!bound.ok) throw new Error(`fixture run binding refused: ${bound.code}`);
  return {
    activation: activationWitness(), approval: decidedApproval(), authorityDelayMs: 0,
    binding: bound.binding, goalId: GOAL_ID, grant: null,
    graphRevisionRef: GRAPH_REVISION_REF, policy: REQUIRE_HUMAN_POLICY, run, ...overrides,
  };
}

function secondPlanningChain(): readonly Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = sealedPlanningChain().map((command, index) => ({
    ...command, commandId: `chain-second-${index + 1}`,
  }));
  const first = chain[0];
  const terminal = chain[chain.length - 1];
  if (first === undefined || terminal === undefined) throw new Error("planning chain is empty");
  chain[0] = { ...first, goalRef: SECOND_GOAL_ID, runId: SECOND_RUN_ID };
  chain[chain.length - 1] = {
    ...terminal,
    authority: SECOND_AUTHORITY.authority,
    graphContentBytesBase64: SECOND_AUTHORITY.graphContentBytesBase64,
    submissionHash: SECOND_AUTHORITY.submissionHash,
  };
  return chain;
}

function secondFinalizeChain(): readonly Record<string, unknown>[] {
  return [{
    commandId: "chain-finalize-second", expectedVersion: 4,
    kind: "planning.finalize_submission",
    revision: {
      dependencyHash: hex64("d2"), graphContentHash: SECOND_AUTHORITY.graphContentHash,
      graphRevisionRef: SECOND_GRAPH_REVISION_REF, planHash: SECOND_AUTHORITY.submissionHash,
      qualityHash: hex64("de"),
    },
    witness: {
      attemptTerminalRef: "attempt-terminal-2", effectTerminalRef: "effect-terminal-2",
      nodeSummaries: [{ executionBearing: true, nodeKey: "node-b" }],
      providerSlotTerminalRef: "slot-terminal-2", resourcesTerminalRef: "resources-terminal-2",
      truthClass: "DAEMON_VERIFIED",
    },
  }];
}

function appendSecondGoal(store: SqliteEventStore): void {
  const requests = [
    envelope("goal.create", 0, { ...goalPayload(), title: "Second journey goal" }, "2"),
    envelope("plan.propose", 0,
      { commands: secondPlanningChain(), runId: SECOND_RUN_ID }, "cmd-propose-second"),
    envelope("plan.propose", 0,
      { commands: secondFinalizeChain(), runId: SECOND_RUN_ID }, "cmd-finalize-second"),
  ];
  for (const request of requests) {
    const outcome = send(store, request);
    if (!outcome.ok) throw new Error(`second-goal fixture refused at ${request.kind}: ${outcome.code}`);
  }
}

export function openEmptyFileStore(): SqliteEventStore {
  const directory = mkdtempSync(join(tmpdir(), "moe-active-graph-slot-"));
  const path = join(directory, "store.sqlite");
  const store = SqliteEventStore.openForProject(path, PROJECT_ID);
  fileDirectories.push(directory);
  fileStores.push(store);
  storePaths.set(store, path);
  return store;
}

export function closeStores(): void {
  while (fileStores.length > 0) fileStores.pop()?.close();
  while (fileDirectories.length > 0) {
    const directory = fileDirectories.pop();
    if (directory !== undefined) rmSync(directory, { force: true, recursive: true });
  }
  closeBootstrapStores();
}

export function inputForSecondGoal(store: SqliteEventStore): GraphActivationInput {
  const run = stateOf(readDurableLedger(store, PROJECT_ID), SECOND_RUN_ID);
  if (run === undefined) throw new Error("second fixture run is not durable");
  const bound = verifyApprovedRunBinding({
    graphRevisionRef: SECOND_GRAPH_REVISION_REF, run, runId: SECOND_RUN_ID, store,
  });
  if (!bound.ok) throw new Error(`second fixture binding refused: ${bound.code}`);
  const approval = applyApprovalCommand({
    ...approvalRecord(SECOND_AUTHORITY.submissionHash),
    approvalRef: "approval-2",
    approvedNodeScope: ["node-b"],
  }, approvalCommand());
  if (!approval.ok) throw new Error(`second fixture approval refused: ${approval.error.code}`);
  return {
    activation: activationWitness({ activationRef: "activation-2" }), approval: approval.value,
    authorityDelayMs: 0, binding: bound.binding, goalId: SECOND_GOAL_ID, grant: null,
    graphRevisionRef: SECOND_GRAPH_REVISION_REF, policy: REQUIRE_HUMAN_POLICY, run,
  };
}

export function approvableStoreWithTwoGoals(): SqliteEventStore {
  const store = openEmptyFileStore();
  driveThrough(store, "approval.decide");
  appendSecondGoal(store);
  inputFor(store);
  inputForSecondGoal(store);
  const active = readCurrentActiveGraph(store, PROJECT_ID);
  if (active.ok || active.code !== "ACTIVE_GRAPH_ABSENT") {
    throw new Error("two-goal fixture unexpectedly has an active graph");
  }
  return store;
}

export function twoHandles(store: SqliteEventStore): {
  readonly a: SqliteEventStore; readonly b: SqliteEventStore;
} {
  const path = storePaths.get(store);
  if (path === undefined) throw new Error("fixture store is not file-backed");
  const b = SqliteEventStore.openForProject(path, PROJECT_ID);
  fileStores.push(b);
  return { a: store, b };
}

type CommitLegs = SqliteEventStore["commitExpectedVersionDecisionLegs"];

export function commitSeamFacade(
  handle: SqliteEventStore, before: () => void,
): SqliteEventStore {
  let pending = true;
  return new Proxy(handle, {
    get(target, property) {
      if (property === "commitExpectedVersionDecisionLegs") {
        const intercepted: CommitLegs = (input) => {
          if (pending) { pending = false; before(); }
          return target.commitExpectedVersionDecisionLegs(input);
        };
        return intercepted;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function approvableStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "approval.decide");
  return store;
}
