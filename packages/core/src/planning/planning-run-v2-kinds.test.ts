import { describe, expect, it } from "vitest";

import type { PlanningRunCommand } from "./planning-contract.js";
import { reducePlanningRun } from "./planning-run-reducer.js";
import {
  SUBMISSION_HASH,
  accepted,
  commandFor,
  expectIllegal,
  finalizeWitness,
  state,
} from "./planning-run-test-fixtures.js";

describe("planning run v2 submission kinds", () => {
  it("creates a REVISION run without granting proposal authority", () => {
    const command = {
      ...commandFor("planning.create_draft", 0),
      runKind: "REVISION",
    } as PlanningRunCommand;
    const result = reducePlanningRun(undefined, command);
    const next = accepted(result);
    expect(next).toEqual(state("DRAFT", { runKind: "REVISION", version: 1 }));
    expect(result.ok && result.events).toEqual([{
      commandId: "cmd-planning.create_draft",
      goalRef: "goal-1",
      kind: "PlanningRunCreated",
      runId: "planning-run-1",
      runKind: "REVISION",
      version: 1,
    }]);
    expect(next.submissionHash).toBeNull();
  });

  it("requires the proposal kind to match its durable INITIAL or REVISION run", () => {
    const revision = state("PLANNING", { runKind: "REVISION" });
    const revisionProposal = {
      ...commandFor("plan.propose"),
      proposalKind: "REVISION",
    } as PlanningRunCommand;
    expect(accepted(reducePlanningRun(revision, revisionProposal)))
      .toMatchObject({ runKind: "REVISION", submissionHash: SUBMISSION_HASH });
    expectIllegal(reducePlanningRun(revision, commandFor("plan.propose")),
      "plan.propose", "PLANNING");
    expectIllegal(reducePlanningRun(state("PLANNING"), revisionProposal),
      "plan.propose", "PLANNING");
  });

  it.each(["INITIAL", "REVISION"] as const)(
    "finalizes a bounded multi-node %s submission into PLAN_REVIEW",
    (runKind) => {
      const sealed = state("PLANNING", { runKind, submissionHash: SUBMISSION_HASH });
      const command = {
        ...commandFor("planning.finalize_submission"),
        witness: finalizeWitness(5),
      } as unknown as PlanningRunCommand;
      const result = reducePlanningRun(sealed, command);
      const next = accepted(result);
      expect(next).toMatchObject({ lifecycle: "PLAN_REVIEW", runKind, version: 8 });
      expect(result.ok && result.events.map((event) => event.kind))
        .toEqual(["PlanRevisionCreated"]);
    },
  );

  it("enforces the scheduler's absolute 64-node finalization ceiling", () => {
    const sealed = state("PLANNING", { submissionHash: SUBMISSION_HASH });
    const atLimit = {
      ...commandFor("planning.finalize_submission"), witness: finalizeWitness(63),
    } as unknown as PlanningRunCommand;
    const aboveLimit = {
      ...commandFor("planning.finalize_submission"), witness: finalizeWitness(64),
    } as unknown as PlanningRunCommand;
    expect(accepted(reducePlanningRun(sealed, atLimit)).lifecycle).toBe("PLAN_REVIEW");
    expectIllegal(reducePlanningRun(sealed, aboveLimit),
      "planning.finalize_submission", "PLANNING");
  });
});
