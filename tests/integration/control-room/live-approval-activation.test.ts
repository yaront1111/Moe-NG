import { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it } from "vitest";

import { resolveAdmissionGate } from "../../../apps/daemon/src/activation/admission-gate-resolver.js";
import { BOOTSTRAP_SCHEMA_VERSION } from "../../../apps/daemon/src/bootstrap/bootstrap-contracts.js";
import type { HandlerTable } from "../../../apps/daemon/src/bootstrap/bootstrap-ledger.js";
import {
  BOOTSTRAP_HANDLERS, runBootstrapCommand,
} from "../../../apps/daemon/src/bootstrap/bootstrap-services.js";
import { FIXTURE_ACTIVATION_RECEIPTS }
  from "../../../apps/daemon/src/bootstrap/bootstrap-test-fixtures.js";
import { GOAL_HANDLERS } from "../../../apps/daemon/src/goals/goal-services.js";
import { PLANNING_HANDLERS } from "../../../apps/daemon/src/planning/planning-services.js";
import { deriveApprovalBudgetRef }
  from "../../../apps/daemon/src/planning/approval-budget-ref.js";
import {
  resolvePlanningAuthorities,
} from "../../../apps/daemon/src/http/affordance-planning-authorities.js";
import { frameOfSurface } from "../../../apps/control-room/src/live/live-board-feed.js";
import {
  planningPayloadFor,
} from "../../../apps/control-room/src/live/live-planning-authorities.js";
import { DEV_PAYLOADS } from "../../../apps/control-room/src/live/live-dispatch.js";

const PROJECT_ID = "project-live-approval-integration";
const PRINCIPAL_ID = "operator-local";
/**
 * THE JOURNEY IS THE SEED'S, AND IT CAN ONLY BE THE SEED'S — MEASURED, NOT ASSUMED.
 *
 * The daemon mints the goal as `goal-${commandId}` and derives that goal's planning run from it
 * (goal-identity.ts), so this identity is what the whole chain below binds to. The six
 * non-planning rows are authored from that identity through `DEV_PAYLOADS`; the two
 * authority-bearing rows are authored through `planningPayloadFor` off the daemon's own sealed
 * material for this exact run. Neither is a constant the board minted.
 *
 * A NON-SEED identity cannot complete this chain, and the reason is not a UI defect. The sealed
 * authority's `submissionHash` is a DERIVED digest of the plan body: the core re-derives it and
 * refuses a severed binding (planning-authority-submission.ts admitPlanAuthoritySubmission ->
 * severedBinding, surfacing as ILLEGAL_TRANSITION @ CORE_REDUCER at the chain's plan.propose).
 * Which goal the board addresses is proven where it is decidable - over the offer's own target,
 * in live-board-dispatch.test.tsx.
 *
 * THE JOURNEY IS NOW DYNAMIC, AND THAT IS THE POINT OF THIS ROW. It used to run on static
 * default payloads the control room SPELLED for one hard-coded journey. task-d3bfc33e retired
 * that: the daemon authors per-run material on its affordance surface and `payloadFor` answers
 * null for both authority-bearing kinds, unconditionally. So the two planning rows below are
 * authored from material this test obtains from the REAL producer, `resolvePlanningAuthorities`,
 * carries over the REAL reader, `frameOfSurface`, and hands to `planningPayloadFor` against the
 * offer record the reader minted. Nothing here is a constant the board restates, and nothing is
 * a hash this test derives: the daemon seals, the wire carries, the browser assembles, and the
 * ledger below grades the result by accepting or refusing it.
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
    // `project.activate` MINTS its witness from measured receipts and refuses without them.
    FIXTURE_ACTIVATION_RECEIPTS,
  );
}

/**
 * The daemon's per-run material for THIS run, sealed by the daemon's own producer and read back
 * through the browser's own reader. The offer record `frameOfSurface` mints is the key the
 * board's material sidecar is bound by, so it is returned rather than any literal: a
 * structurally identical offer object carries no authority at all.
 */
function offeredPlanningCard(commandKind: string): Record<string, unknown> {
  const offers = [
    {
      commandId: `${RUN_ID}-plan.propose`, commandKind: "plan.propose",
      expectedVersion: 0, targetAggregateId: RUN_ID,
    },
    {
      commandId: `${RUN_ID}-approval.decide`, commandKind: "approval.decide",
      expectedVersion: 0, targetAggregateId: RUN_ID,
    },
  ];
  const planningGoalRefs = { [RUN_ID]: GOAL_ID };
  const frame = frameOfSurface({
    nextAllowedCommands: offers,
    outcome: "SURFACE",
    planningAuthorityByRun: resolvePlanningAuthorities({
      nodes: [{ nodeRef: NODE_ID }],
      offers: offers as unknown as Parameters<typeof resolvePlanningAuthorities>[0]["offers"],
      planningGoalRefs,
      principalId: PRINCIPAL_ID,
    }) as unknown as Record<string, unknown>,
    planningGoalRefs,
    steps: [],
  });
  // A frame the reader could not vouch for is LAGGING with no offers, which would make every
  // lookup below answer undefined and turn a binding failure into a missing-payload throw.
  expect(frame.connection).toBe("CONNECTED");
  const offer = frame.offers.find((candidate) => candidate["commandKind"] === commandKind);
  if (offer === undefined) throw new Error(`the reader bound no ${commandKind} offer`);
  return offer;
}

/** One authority-bearing payload, authored by production off the daemon's own material. */
function planningPayload(commandKind: string, version: number): Record<string, unknown> {
  const payload = planningPayloadFor(
    commandKind, offeredPlanningCard(commandKind), version, GOAL_ID,
  );
  if (payload === null) throw new Error(`no ${commandKind} payload for ${RUN_ID}`);
  return payload;
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
    ["plan.propose", 0, planningPayload("plan.propose", 0), "plan-propose"],
    ["plan.propose", 0, planningPayload("plan.propose", 1), "plan-finalize"],
  ] as const;

  expect(rows).toHaveLength(9);
  for (const [kind, version, payload, commandId] of rows) {
    if (payload === undefined || payload === null) throw new Error(`missing payload for ${kind}`);
    const outcome = send(store, kind, version, payload, commandId);
    expect(outcome.ok, outcome.ok ? "" : `${kind}: ${outcome.code}@${outcome.refusedBy}`).toBe(true);
  }

  // THE APPROVAL RIDES A SECOND PHASE, exactly as the board does (task-be80cb74). Its
  // `budgetRef` is a decide-time COMMITMENT over budget material that is only durable once the
  // finalize terminal above has committed, so `planningPayloadFor` — synchronous and pure —
  // carries no `budgetRef` at all and the record would be refused INPUT_INVALID @ CORE_REDUCER
  // without one.
  // In production `dispatchAffordance` reads it off `/budget/commitment/read`; that route
  // composes `deriveApprovalBudgetRef`, which is what this arm calls against its own store. The
  // board's payload and the daemon's own derivation are joined here, and the activation
  // bind-back below is the fence that grades the join.
  const commitment = deriveApprovalBudgetRef(store, PROJECT_ID, RUN_ID);
  if (!("ref" in commitment)) {
    throw new Error(`no budget commitment for ${RUN_ID}: ${JSON.stringify(commitment)}`);
  }
  const base = planningPayload("approval.decide", 4);
  const record = base["record"] as Record<string, unknown>;
  expect(record).not.toHaveProperty("budgetRef");
  const approval = { ...base, record: { ...record, budgetRef: commitment.ref } };
  const decided = send(store, "approval.decide", 0, approval, "approval");
  expect(
    decided.ok, decided.ok ? "" : `approval.decide: ${decided.code}@${decided.refusedBy}`,
  ).toBe(true);

  // The revision the JOURNEY actually bound, read off the production-authored approval rather
  // than restated as a literal. A hard-coded ref here would pass while the chain committed a
  // different one, which is the whole class of drift the static defaults used to hide.
  const graphRevisionRef = base["graphRevisionRef"];
  expect(typeof graphRevisionRef).toBe("string");
  const resolved = resolveAdmissionGate({
    goalRef: GOAL_ID,
    graphRevisionRef: String(graphRevisionRef),
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
