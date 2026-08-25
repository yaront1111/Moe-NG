/**
 * The world `activateApprovedGraph` is called against, built ENTIRELY by production writers.
 *
 * `driveThrough(store, "approval.decide")` runs the shipped bootstrap sequence up to but not
 * including the approval, so the run reaches PLAN_REVIEW with its `sealedHashes` written by the
 * core's own submission fold and its graph body written by `plan.propose`'s body leg. NOTHING
 * here hand-commits a graph revision: the aggregate under test must be empty when the service is
 * called, because an initial activation IS its whole history.
 *
 * The approval record is the CORE's decided one (`applyApprovalCommand`), not a payload copy, and
 * the run binding is `verifyApprovedRunBinding`'s — the same two facts the transport will hold.
 */
import type { JsonObject, JsonValue } from "@moe/contracts";
import { applyApprovalCommand } from "@moe/core";
import type { ApprovalDecisionRecord, ApprovalPolicy } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

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
  driveThrough,
  openStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { verifyApprovedRunBinding } from "./approval-run-binding.js";
import type { GraphActivationInput } from "./graph-activation-service.js";

export {
  GOAL_ID,
  GRAPH_REVISION_REF,
  PROJECT_ID,
  RUN_ID,
  closeStores,
} from "../bootstrap/bootstrap-test-fixtures.js";

/** The daemon's own settings with no `MOE_APPROVAL_MODE` set: a human decides. */
export const REQUIRE_HUMAN_POLICY: ApprovalPolicy = Object.freeze({ kind: "REQUIRE_HUMAN" });

/**
 * The caller's witness carries NO hash at all by default. Every hash the binding needs is
 * server-derived, so the default world is the one where the caller supplied nothing to compare —
 * which is what makes an accepted control evidence that the server produced the values itself.
 */
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
    commandId,
    correlationId: "corr-1",
    decidedAt: "2026-08-08T00:00:00.000Z",
    expectedVersion: 0,
    kind: "approval.decide",
    payload,
    principalId: "principal-1",
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
    activation: activationWitness(),
    approval: decidedApproval(),
    authorityDelayMs: 0,
    binding: bound.binding,
    goalId: GOAL_ID,
    grant: null,
    graphRevisionRef: GRAPH_REVISION_REF,
    policy: REQUIRE_HUMAN_POLICY,
    run,
    ...overrides,
  };
}

/** A store driven to the point where the next durable move is the activation itself. */
export function approvableStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "approval.decide");
  return store;
}
