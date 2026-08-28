/**
 * THE READ'S TRUTH ABOUT REVIEWABILITY (task-f053d212).
 *
 * The defect this suite pins: `readPlanningRun` derived `reviewable` from the run lifecycle
 * ALONE, and `approval.decide` never touches the run aggregate — it commits
 * `GoalExecutionEnabled` on the GOAL — so a run whose approval is already durably committed sat
 * in `PLAN_REVIEW` forever and the read kept answering `reviewable: true`. The control room
 * faithfully rendered "Ready for your approval" over an approval that had already been made.
 *
 * EVERY WORLD HERE IS BUILT BY PRODUCTION COMMAND HANDLERS, through `bootstrapSequence`'s own
 * envelopes, because the defect is precisely that two production WRITES disagree; a hand-shaped
 * ledger record could be made to agree with either. The only planted events are the ones
 * production cannot write — a `GoalExecutionEnabled` whose payload does not decode, and a second
 * one on the same goal — and each is planted through the store's real commit path.
 *
 * The `lifecycle` assertion rides along in every arm ON PURPOSE: the fix must refuse to offer the
 * approval WITHOUT starting to lie in the other direction. The run really is still in
 * `PLAN_REVIEW`, and a wiring that "fixed" the banner by rewriting the lifecycle would be a
 * second falsehood, not a fix.
 */
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger, versionOf } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_ID, PROJECT_ID, RUN_ID, approvalPayload, closeStores, driveThrough, envelope,
  finalizeChain, openStore, sealedPlanningChain, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { readPlanningRun } from "./planning-run-read.js";
import type { PlanningRunView } from "./planning-run-read.js";

const APPROVAL_KIND = "approval.decide";
const SECOND_RUN_ID = "run-2";
const encoder = new TextEncoder();

afterEach(() => {
  closeStores();
});

/** The RUN frame, or a throw naming the refusal — never a cast that would let a REFUSED answer
 *  reach an assertion about `reviewable` and read as a pass. */
function runFrame(store: SqliteEventStore, runId: string): PlanningRunView {
  const answer = readPlanningRun(store, PROJECT_ID, runId);
  if (answer.outcome !== "RUN") {
    throw new Error(`expected a RUN frame for ${runId}, got REFUSED ${answer.code}`);
  }
  return answer;
}

/** Drives the shipped journey to the point where the human is about to decide: the run sealed,
 *  finalized and sitting at PLAN_REVIEW with NO durable approval anywhere. */
function sealedRunAwaitingApproval(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, APPROVAL_KIND);
  return store;
}

/** The shipped `approval.decide` — the same envelope `bootstrapSequence` issues. */
function approveRun(store: SqliteEventStore, commandId = "cmd-approval.decide"): void {
  const outcome = send(store, envelope(APPROVAL_KIND, 0, approvalPayload(), commandId));
  if (!outcome.ok) throw new Error(`approval.decide refused: ${outcome.code} (${outcome.refusedBy})`);
}

/**
 * A SECOND sealed run under the SAME goal, carried to PLAN_REVIEW by the same production chain.
 *
 * This is what makes the per-run arm honest: one goal now holds two runs a human could be asked
 * to approve, so a reader that merely asks "does this goal have a GoalExecutionEnabled" would
 * silence BOTH of them the moment either is approved.
 */
function proposeSecondRun(store: SqliteEventStore): void {
  const chain = sealedPlanningChain().map((command, index) => index === 0
    ? { ...command, commandId: "second-chain-create", runId: SECOND_RUN_ID }
    : { ...command, commandId: `second-chain-${String(index)}` });
  const proposed = send(store, envelope(
    "plan.propose", 0, { commands: chain, runId: SECOND_RUN_ID }, "cmd-propose-second",
  ));
  if (!proposed.ok) throw new Error(`second propose refused: ${proposed.code}`);
  const finalized = send(store, envelope("plan.propose", 0, {
    commands: finalizeChain().map((command) => ({ ...command, commandId: "second-chain-finalize" })),
    runId: SECOND_RUN_ID,
  }, "cmd-finalize-second"));
  if (!finalized.ok) throw new Error(`second finalize refused: ${finalized.code}`);
}

/** Commits an event production cannot produce, through the store's REAL expected-version path so
 *  the aggregate it lands on is the one a reader will actually scan. */
function plantGoalEvent(store: SqliteEventStore, commandId: string, payload: Uint8Array): void {
  store.commitExpectedVersionDecision({
    commandKind: APPROVAL_KIND,
    committedResultBytes: encoder.encode(JSON.stringify({})),
    correlationId: "corr-plant",
    decidedAt: "2026-08-08T00:00:00.000Z",
    events: [{ eventId: `${commandId}-event`, eventType: "GoalExecutionEnabled", payload }],
    expectedVersion: versionOf(readDurableLedger(store, PROJECT_ID), GOAL_ID),
    key: { commandId, principalId: "principal-1", projectId: PROJECT_ID },
    requestBytes: encoder.encode(commandId),
    targetAggregateId: GOAL_ID,
  });
}

describe("POST /planning/run/read reviewability against a durable approval (task-f053d212)", () => {
  it("answers reviewable TRUE for a sealed PLAN_REVIEW run no approval binds", () => {
    const store = sealedRunAwaitingApproval();
    const frame = runFrame(store, RUN_ID);
    expect(frame.lifecycle).toBe("PLAN_REVIEW");
    expect(frame.reviewable).toBe(true);
    expect(frame.runId).toBe(RUN_ID);
    // The run is genuinely sealed, or the arm would be asserting reviewability over an empty plan.
    expect(frame.plan).not.toBeNull();
  });

  it("answers reviewable FALSE once approval.decide is durable, with the lifecycle unchanged", () => {
    const store = sealedRunAwaitingApproval();
    expect(runFrame(store, RUN_ID).reviewable).toBe(true);
    approveRun(store);
    const frame = runFrame(store, RUN_ID);
    // Both halves of the contradiction, in one arm: the run IS still in PLAN_REVIEW — that is the
    // truth the read must keep telling — and it is NOT offered for approval any more.
    expect(frame.lifecycle).toBe("PLAN_REVIEW");
    expect(frame.reviewable).toBe(false);
    expect(frame.plan).not.toBeNull();
  });

  it("keeps a SIBLING run reviewable when the goal's approval binds the other run", () => {
    const store = sealedRunAwaitingApproval();
    proposeSecondRun(store);
    expect(runFrame(store, SECOND_RUN_ID).lifecycle).toBe("PLAN_REVIEW");
    approveRun(store);
    expect(runFrame(store, RUN_ID).reviewable).toBe(false);
    const sibling = runFrame(store, SECOND_RUN_ID);
    expect(sibling.lifecycle).toBe("PLAN_REVIEW");
    expect(sibling.reviewable).toBe(true);
  });

  it("answers reviewable FALSE when the goal's approval event will not decode", () => {
    const store = sealedRunAwaitingApproval();
    plantGoalEvent(store, "cmd-plant-unreadable", encoder.encode("{ not json"));
    const frame = runFrame(store, RUN_ID);
    // Fail CLOSED. Reporting an approval this reader cannot read as "no approval" is exactly the
    // direction that re-invites a human to approve a run that may already be approved.
    expect(frame.lifecycle).toBe("PLAN_REVIEW");
    expect(frame.reviewable).toBe(false);
  });

  it("answers reviewable FALSE when the goal carries TWO approval events", () => {
    const store = sealedRunAwaitingApproval();
    const foreign = JSON.stringify({ activation: { runId: "run-elsewhere-1" } });
    plantGoalEvent(store, "cmd-plant-first", encoder.encode(foreign));
    plantGoalEvent(store, "cmd-plant-second", encoder.encode(foreign));
    const frame = runFrame(store, RUN_ID);
    // Ambiguous is UNREADABLE, never ABSENT: with two decisions on one goal this reader cannot
    // say which (if either) binds this run, and "cannot say" may not present as "not approved".
    expect(frame.lifecycle).toBe("PLAN_REVIEW");
    expect(frame.reviewable).toBe(false);
  });
});
