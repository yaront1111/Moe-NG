/**
 * Competing finalize and cancel schedules against an EXPANSION run. Every case drives
 * `reducePlanningRun` itself, and the expected lifecycles are hand-written here rather than read
 * back out of `PLANNING_RUN_TRANSITIONS`, so a table edit cannot quietly redefine the assertion.
 */
import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import type { PlanningRunCommand, PlanningRunLifecycle } from "./planning-contract.js";
import { snapshotPlanningRunContractState } from "./planning-expansion-validation.js";
import { reducePlanningRun } from "./planning-run-reducer.js";
import {
  HOLD,
  IDENTITY,
  SUBMISSION_HASH,
  accepted,
  commandFor,
  expansionFinalizeWitness,
  expansionState,
  expectError,
  expectIllegal,
} from "./planning-run-test-fixtures.js";

const CANCELLABLE: readonly PlanningRunLifecycle[] =
  ["DRAFT", "READY", "PLANNING", "PLAN_REVIEW", "APPROVED"];

const EXPANSION_STATE_KEYS = [
  "approvedHashes", "attemptRef", "expansion", "facets", "goalRef", "graphRevisionRef",
  "leaseRef", "lifecycle", "runId", "runKind", "sealedHashes", "sealedProposal",
  "submissionHash", "version",
];

/** Reads contract-only members without widening the reducer's declared result types. */
function fields(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function sealedRun(lifecycle: PlanningRunLifecycle = "PLANNING") {
  return expansionState(lifecycle,
    { sealedProposal: { ...IDENTITY }, submissionHash: SUBMISSION_HASH });
}

/**
 * `sealedPlacement` binds the two directions: a lifecycle that carries a submission hash must
 * carry its sealed identity, and one that does not must seal nothing. Getting this wrong builds a
 * state the contract guard refuses, and every command against it degrades to `UNKNOWN_ERROR`.
 */
function runAt(lifecycle: PlanningRunLifecycle) {
  return expansionState(lifecycle).submissionHash === null
    ? expansionState(lifecycle) : sealedRun(lifecycle);
}

function finalizeCommand(expectedVersion = 7): PlanningRunCommand {
  return { ...commandFor("planning.finalize_submission", expectedVersion),
    witness: expansionFinalizeWitness() } as unknown as PlanningRunCommand;
}

describe("planning run EXPANSION cancellation", () => {
  it("cancels an EXPANSION run from every goal-authorized lifecycle, carrying the hold", () => {
    for (const lifecycle of CANCELLABLE) {
      const next = accepted(reducePlanningRun(runAt(lifecycle), commandFor("goal.cancel")));
      expect(next).toMatchObject({ lifecycle: "CANCELLED", runKind: "EXPANSION", version: 8 });
      expect(fields(next)["expansion"]).toEqual(HOLD);
      expect(Object.keys(next).sort()).toEqual(EXPANSION_STATE_KEYS);
      expect(snapshotPlanningRunContractState(next)).not.toBeUndefined();
    }
    expect(CANCELLABLE.length).toBe(5);
  });

  it("refuses expansion-only planning.cancel against an EXPANSION run from every lifecycle", () => {
    const seen = new Set<string>();
    for (const lifecycle of RUNTIME_LIFECYCLES.PLANNING_RUN) {
      seen.add(lifecycle);
      const result = reducePlanningRun(runAt(lifecycle), commandFor("planning.cancel"));
      if (lifecycle === "SUBMISSION_DRAINING") {
        expectError(result, "PLANNING_SUBMISSION_FINALIZING", { sourceState: lifecycle });
        continue;
      }
      expectIllegal(result, "planning.cancel", lifecycle);
    }
    expect(seen.size).toBe(RUNTIME_LIFECYCLES.PLANNING_RUN.length);
    expect(seen.has("SUBMISSION_DRAINING")).toBe(true);
  });

  it("fences goal.cancel while a sealed EXPANSION submission is still draining", () => {
    const draining = sealedRun("SUBMISSION_DRAINING");
    const before = JSON.stringify(draining);
    expectIllegal(reducePlanningRun(draining, commandFor("goal.cancel")),
      "goal.cancel", "SUBMISSION_DRAINING");
    expect(JSON.stringify(draining)).toBe(before);
  });

  it("resolves a competing finalize and cancel schedule to exactly one outcome", () => {
    const cancelled = accepted(reducePlanningRun(sealedRun(), commandFor("goal.cancel")));
    expect(cancelled.lifecycle).toBe("CANCELLED");
    expectIllegal(reducePlanningRun(cancelled, finalizeCommand(8)),
      "planning.finalize_submission", "CANCELLED");
    const finalized = accepted(reducePlanningRun(sealedRun(), finalizeCommand()));
    expect(finalized.lifecycle).toBe("PLAN_REVIEW");
    const late = accepted(reducePlanningRun(finalized, commandFor("goal.cancel", 8)));
    expect(late).toMatchObject({ lifecycle: "CANCELLED", runKind: "EXPANSION", version: 9 });
    expect(fields(late)["sealedProposal"]).toEqual(IDENTITY);
    expect(fields(late)["expansion"]).toEqual(HOLD);
    expect(Object.keys(late).sort()).toEqual(EXPANSION_STATE_KEYS);
  });
});
