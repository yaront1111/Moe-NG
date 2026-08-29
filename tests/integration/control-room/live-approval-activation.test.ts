import { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it } from "vitest";

import { resolveAdmissionGate } from "../../../apps/daemon/src/activation/admission-gate-resolver.js";
import { BOOTSTRAP_SCHEMA_VERSION } from "../../../apps/daemon/src/bootstrap/bootstrap-contracts.js";
import type { HandlerTable } from "../../../apps/daemon/src/bootstrap/bootstrap-ledger.js";
import {
  BOOTSTRAP_HANDLERS, runBootstrapCommand,
} from "../../../apps/daemon/src/bootstrap/bootstrap-services.js";
import { GOAL_HANDLERS } from "../../../apps/daemon/src/goals/goal-services.js";
import { PLANNING_HANDLERS } from "../../../apps/daemon/src/planning/planning-services.js";
import { DEV_PAYLOADS, payloadFor } from "../../../apps/control-room/src/live/live-dispatch.js";

const PROJECT_ID = "project-live-approval-integration";
const PRINCIPAL_ID = "operator-local";
/**
 * THE JOURNEY IS THE SEED'S, AND IT CAN ONLY BE THE SEED'S — MEASURED, NOT ASSUMED.
 *
 * The daemon mints the goal as `goal-${commandId}` and derives that goal's planning run from it
 * (goal-identity.ts), so this identity is what the whole chain below binds to, and every payload
 * is authored from it through `payloadFor` rather than from any constant inside the board.
 *
 * A NON-SEED identity cannot complete this chain, and the reason is not a UI defect. The sealed
 * authority's `submissionHash` is a DERIVED digest of the plan body: the core re-derives it and
 * refuses a severed binding (planning-authority-submission.ts admitPlanAuthoritySubmission ->
 * severedBinding, surfacing as ILLEGAL_TRANSITION @ CORE_REDUCER at the chain's plan.propose).
 * The control room cannot import the daemon and must not grow a second implementation of a
 * security-relevant canonicalisation, so it SPELLS the producer's bytes for the one journey
 * dev-payload-parity.test.ts pins to `journeyAuthority`. Measured 2026-08-29 by driving both
 * identities through this exact chain: `live-1` reaches approval.decide, `sibling-7c1f` refuses
 * ILLEGAL_TRANSITION @ CORE_REDUCER at plan.propose. Which goal the board addresses is proven
 * where it is decidable - over the offer's own target, in live-board-dispatch.test.tsx.
 */
const CREATE_COMMAND_ID = "live-1";
const GOAL_ID = `goal-${CREATE_COMMAND_ID}`;
const RUN_ID = `run-${CREATE_COMMAND_ID}`;
const NODE_ID = "node-code-1";
const encoder = new TextEncoder();
const stores: SqliteEventStore[] = [];
const handlers: HandlerTable = Object.freeze({
  ...BOOTSTRAP_HANDLERS,
  ...GOAL_HANDLERS,
  ...PLANNING_HANDLERS,
});

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function send(
  store: SqliteEventStore,
  kind: string,
  expectedVersion: number,
  payload: Record<string, unknown>,
  commandId: string,
) {
  const bytes = encoder.encode(JSON.stringify({
    commandId,
    correlationId: `corr-${commandId}`,
    decidedAt: "2026-08-24T00:00:00.000Z",
    expectedVersion,
    kind,
    payload,
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
  }));
  return runBootstrapCommand(
    store,
    bytes,
    handlers,
    kind === "approval.decide" ? Object.freeze({ principalId: PRINCIPAL_ID }) : undefined,
  );
}

it("the shipped journey activates its exact human-approved execution node", () => {
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  stores.push(store);
  const rows = [
    ["project.register", 0, DEV_PAYLOADS["project.register"], "register"],
    ["project.bind_repository", 1, DEV_PAYLOADS["project.bind_repository"], "bind"],
    ["provider.probe", 0, DEV_PAYLOADS["provider.probe"], "probe"],
    ["policy.install", 0, DEV_PAYLOADS["policy.install"], "policy-install"],
    ["policy.validate", 1, DEV_PAYLOADS["policy.validate"], "policy-validate"],
    ["project.activate", 2, DEV_PAYLOADS["project.activate"], "project-activate"],
    // The daemon mints the goal as `goal-${commandId}` and derives its planning run from THAT
    // goal (goal-identity.ts), so this command identity is what lands on GOAL_ID / RUN_ID.
    ["goal.create", 0, DEV_PAYLOADS["goal.create"], CREATE_COMMAND_ID],
    ["plan.propose", 0, payloadFor("plan.propose", RUN_ID, 0, GOAL_ID), "plan-propose"],
    ["plan.propose", 0, payloadFor("plan.propose", RUN_ID, 1, GOAL_ID), "plan-finalize"],
    ["approval.decide", 0, payloadFor("approval.decide", RUN_ID, 4), "approval"],
  ] as const;

  expect(rows).toHaveLength(10);
  for (const [kind, version, payload, commandId] of rows) {
    if (payload === undefined || payload === null) throw new Error(`missing payload for ${kind}`);
    const outcome = send(store, kind, version, payload, commandId);
    expect(outcome.ok, outcome.ok ? "" : `${kind}: ${outcome.code}@${outcome.refusedBy}`).toBe(true);
  }

  const resolved = resolveAdmissionGate({
    goalRef: GOAL_ID,
    graphRevisionRef: "graph-revision-1",
    nodeKey: NODE_ID,
    policySliceHash: "unused-by-human-approval",
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    store,
    witnessField: "approval",
  });
  expect(resolved.ok, resolved.ok ? "" : `${resolved.code}@${resolved.layer}`).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.gate.approval).toMatchObject({
    approvalRef: "approval-1",
    decision: "APPROVE",
    validity: "CURRENT",
  });
});
