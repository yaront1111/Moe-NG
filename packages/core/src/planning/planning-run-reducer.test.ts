import { describe, expect, it } from "vitest";

import type { PlanningRunCommand } from "./planning-contract.js";
import { reducePlanningRun } from "./planning-run-reducer.js";
import {
  EFFECT_TERMINAL,
  HASHES,
  READINESS,
  RECOVERY,
  REFUSAL,
  RESUME,
  REVISION_SEAL,
  SUBMISSION_HASH,
  accepted,
  commandFor,
  expectError,
  expectIllegal,
  finalizeWitness,
  hash,
  state,
} from "./planning-run-test-fixtures.js";

describe("planning run creation and readiness", () => {
  it("creates an immutable INITIAL draft at version 1", () => {
    const result = reducePlanningRun(undefined, commandFor("planning.create_draft", 0));
    const next = accepted(result);
    expect(next).toEqual(state("DRAFT", { version: 1 }));
    expect(result.ok && result.events).toEqual([{
      commandId: "cmd-planning.create_draft", goalRef: "goal-1", kind: "PlanningRunCreated",
      runId: "planning-run-1", runKind: "INITIAL", version: 1,
    }]);
  });

  it("refuses creation without expectedVersion zero and refuses non-create bootstraps", () => {
    expectError(reducePlanningRun(undefined, commandFor("planning.create_draft", 1)),
      "UNKNOWN_ERROR");
    expectError(reducePlanningRun(undefined, commandFor("planning.ready", 0)), "UNKNOWN_ERROR");
    expectError(reducePlanningRun(undefined, { ...commandFor("planning.create_draft", 0),
      commandId: "" } as PlanningRunCommand), "UNKNOWN_ERROR");
  });

  it("returns the typed UNSUPPORTED variant for non-INITIAL run kinds", () => {
    const result = reducePlanningRun(undefined, {
      ...commandFor("planning.create_draft", 0), runKind: "EXPANSION",
    } as PlanningRunCommand);
    expect(result).toEqual({ executionBearingNodeKeys: [], ok: false,
      reason: "PLANNING_KIND_UNSUPPORTED", unsupported: true });
  });

  it("moves DRAFT to READY only on a strong readiness witness", () => {
    const next = accepted(reducePlanningRun(state("DRAFT"), commandFor("planning.ready")));
    expect(next).toMatchObject({ lifecycle: "READY", version: 8 });
    const weak = { ...commandFor("planning.ready"),
      witness: { ...READINESS, truthClass: "OBSERVED" } } as PlanningRunCommand;
    expectIllegal(reducePlanningRun(state("DRAFT"), weak), "planning.ready", "DRAFT");
  });
});

describe("planning run ownership", () => {
  it("claims READY into an owned PLANNING run", () => {
    const next = accepted(reducePlanningRun(state("READY"), commandFor("planning.claim")));
    expect(next).toMatchObject({ attemptRef: "attempt-1", leaseRef: "lease-1",
      lifecycle: "PLANNING", version: 8 });
    expect(next.facets).toEqual({ leaseSuspect: false, livePlannerEffect: true, owned: true,
      resumable: false });
  });

  it("rejects a resume proof on a first claim and requires one on a resumed claim", () => {
    const withProof = { ...commandFor("planning.claim"), resumeProof: RESUME };
    expectIllegal(reducePlanningRun(state("READY"), withProof as PlanningRunCommand),
      "planning.claim", "READY");
    const resumable = state("PLANNING", { attemptRef: null, facets: { leaseSuspect: false,
      livePlannerEffect: false, owned: false, resumable: true }, leaseRef: null });
    expectIllegal(reducePlanningRun(resumable, commandFor("planning.claim")),
      "planning.claim", "PLANNING");
    const next = accepted(reducePlanningRun(resumable, withProof as PlanningRunCommand));
    expect(next.facets).toEqual({ leaseSuspect: false, livePlannerEffect: true, owned: true,
      resumable: false });
    expectIllegal(reducePlanningRun(state("PLANNING"), withProof as PlanningRunCommand),
      "planning.claim", "PLANNING");
  });

  it("releases an owned run into an unowned resumable run", () => {
    const next = accepted(reducePlanningRun(state("PLANNING"), commandFor("planning.release")));
    expect(next).toMatchObject({ attemptRef: null, leaseRef: null, lifecycle: "PLANNING",
      version: 8 });
    expect(next.facets).toEqual({ leaseSuspect: false, livePlannerEffect: false, owned: false,
      resumable: true });
    expectIllegal(reducePlanningRun(next, commandFor("planning.release", 8)),
      "planning.release", "PLANNING");
  });

  it("recovers an owned or suspect run and records missing memory as UNKNOWN", () => {
    const next = accepted(reducePlanningRun(state("PLANNING"),
      commandFor("planning.recover_absent")));
    expect(next.facets).toEqual({ leaseSuspect: false, livePlannerEffect: false, owned: false,
      resumable: true });
    const suspect = state("PLANNING", { attemptRef: null, facets: { leaseSuspect: true,
      livePlannerEffect: false, owned: false, resumable: false }, leaseRef: null });
    expect(accepted(reducePlanningRun(suspect,
      commandFor("planning.recover_absent"))).facets.resumable).toBe(true);
    const idle = state("PLANNING", { attemptRef: null, facets: { leaseSuspect: false,
      livePlannerEffect: false, owned: false, resumable: true }, leaseRef: null });
    expectIllegal(reducePlanningRun(idle, commandFor("planning.recover_absent")),
      "planning.recover_absent", "PLANNING");
    const observed = { ...commandFor("planning.recover_absent"),
      witness: { ...RECOVERY, missingInMemoryState: "OBSERVED" } } as unknown as
        PlanningRunCommand;
    expectIllegal(reducePlanningRun(state("PLANNING"), observed),
      "planning.recover_absent", "PLANNING");
  });
});

describe("planning run submission", () => {
  it("seals a submission into SUBMISSION_DRAINING while a planner effect is live", () => {
    const live = state("PLANNING", { facets: { leaseSuspect: false, livePlannerEffect: true,
      owned: true, resumable: false } });
    const next = accepted(reducePlanningRun(live, commandFor("plan.propose")));
    expect(next).toMatchObject({ lifecycle: "SUBMISSION_DRAINING",
      submissionHash: SUBMISSION_HASH, version: 8 });
  });

  it("seals directly into a finalization-eligible PLANNING run on terminal effect proof", () => {
    const live = state("PLANNING", { facets: { leaseSuspect: false, livePlannerEffect: true,
      owned: true, resumable: false } });
    const command = { ...commandFor("plan.propose"), effectTerminalProof: EFFECT_TERMINAL };
    const next = accepted(reducePlanningRun(live, command as PlanningRunCommand));
    expect(next).toMatchObject({ lifecycle: "PLANNING", submissionHash: SUBMISSION_HASH });
    expect(next.facets.livePlannerEffect).toBe(false);
  });

  it("refuses REVISION and EXPANSION proposals with the typed UNSUPPORTED variant", () => {
    for (const proposalKind of ["REVISION", "EXPANSION"] as const) {
      const result = reducePlanningRun(state("PLANNING"),
        { ...commandFor("plan.propose"), proposalKind } as PlanningRunCommand);
      expect(result).toEqual({ executionBearingNodeKeys: [], ok: false,
        reason: "PLANNING_KIND_UNSUPPORTED", unsupported: true });
    }
  });

  it("accepts an identical-byte re-present and refuses a second distinct submission", () => {
    const sealed = state("PLANNING", { submissionHash: SUBMISSION_HASH });
    const replay = reducePlanningRun(sealed, commandFor("plan.propose"));
    expect(replay.ok && replay.events).toEqual([]);
    expect(accepted(replay)).toEqual(sealed);
    const other = { ...commandFor("plan.propose"), submissionHash: hash("88") };
    expectIllegal(reducePlanningRun(sealed, other as PlanningRunCommand),
      "plan.propose", "PLANNING");
  });

  it("refuses proposals from an unowned run and non-hex submission hashes", () => {
    const unowned = state("PLANNING", { attemptRef: null, facets: { leaseSuspect: false,
      livePlannerEffect: false, owned: false, resumable: true }, leaseRef: null });
    expectIllegal(reducePlanningRun(unowned, commandFor("plan.propose")),
      "plan.propose", "PLANNING");
    const bad = { ...commandFor("plan.propose"), submissionHash: "ZZ" };
    expectIllegal(reducePlanningRun(state("PLANNING"), bad as PlanningRunCommand),
      "plan.propose", "PLANNING");
  });
});

describe("planning run submission finalization", () => {
  const sealedPlanning = state("PLANNING", { submissionHash: SUBMISSION_HASH });

  it("records the plan and graph revision atomically on a single-node graph", () => {
    const result = reducePlanningRun(sealedPlanning, commandFor("planning.finalize_submission"));
    const next = accepted(result);
    expect(next).toMatchObject({ attemptRef: null, graphRevisionRef: "graph-revision-1",
      leaseRef: null, lifecycle: "PLAN_REVIEW", version: 8 });
    expect(next.sealedHashes).toEqual(HASHES);
    expect(next.approvedHashes).toBeNull();
    expect(result.ok && result.events.map((event) => event.kind)).toEqual(["PlanRevisionCreated"]);
  });

  it("returns typed UNSUPPORTED with zero state change for a multi-node graph", () => {
    const before = JSON.stringify(sealedPlanning);
    const command = { ...commandFor("planning.finalize_submission"), witness: finalizeWitness(2) };
    const result = reducePlanningRun(sealedPlanning, command as PlanningRunCommand);
    expect(result).toEqual({ executionBearingNodeKeys: ["node-0", "node-1"], ok: false,
      reason: "MULTI_NODE_EXECUTION_UNSUPPORTED", unsupported: true });
    expect(JSON.stringify(sealedPlanning)).toBe(before);
  });

  it("rejects the run with successor data after a refused admission", () => {
    const refusal = { commandId: "cmd-refuse", expectedVersion: 7,
      kind: "planning.finalize_submission", refusal: REFUSAL, witness: finalizeWitness(2) };
    const result = reducePlanningRun(sealedPlanning, refusal as unknown as PlanningRunCommand);
    const next = accepted(result);
    expect(next.lifecycle).toBe("REJECTED");
    expect(result.ok && result.successor).toEqual(state("DRAFT",
      { runId: "planning-run-2", version: 1 }));
  });

  it("requires exactly one of a revision seal and a refusal witness", () => {
    const both = { ...commandFor("planning.finalize_submission"), refusal: REFUSAL };
    expectIllegal(reducePlanningRun(sealedPlanning, both as unknown as PlanningRunCommand),
      "planning.finalize_submission", "PLANNING");
    const neither = { commandId: "cmd-finalize", expectedVersion: 7,
      kind: "planning.finalize_submission", witness: finalizeWitness(1) };
    expectIllegal(reducePlanningRun(sealedPlanning, neither as unknown as PlanningRunCommand),
      "planning.finalize_submission", "PLANNING");
  });

  it("refuses a graph that carries no execution-bearing node at all", () => {
    const empty = { ...commandFor("planning.finalize_submission"), witness: finalizeWitness(0) };
    expectIllegal(reducePlanningRun(sealedPlanning, empty as unknown as PlanningRunCommand),
      "planning.finalize_submission", "PLANNING");
  });

  it("refuses finalization without a sealed submission or with a non-hex plan hash", () => {
    expectIllegal(reducePlanningRun(state("PLANNING"),
      commandFor("planning.finalize_submission")), "planning.finalize_submission", "PLANNING");
    const bad = { ...commandFor("planning.finalize_submission"),
      revision: { ...REVISION_SEAL, planHash: "nothex" } };
    expectIllegal(reducePlanningRun(sealedPlanning, bad as unknown as PlanningRunCommand),
      "planning.finalize_submission", "PLANNING");
  });

  it("finalizes from SUBMISSION_DRAINING and fences every other drained command", () => {
    const next = accepted(reducePlanningRun(state("SUBMISSION_DRAINING"),
      commandFor("planning.finalize_submission")));
    expect(next.lifecycle).toBe("PLAN_REVIEW");
    expect(next.facets).toEqual({ leaseSuspect: false, livePlannerEffect: false, owned: false,
      resumable: false });
    expectError(reducePlanningRun(state("SUBMISSION_DRAINING"), commandFor("planning.release")),
      "PLANNING_SUBMISSION_FINALIZING", { sourceState: "SUBMISSION_DRAINING" });
  });
});
