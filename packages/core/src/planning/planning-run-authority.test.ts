import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import type {
  PlanningRunCommand,
  PlanningRunLifecycle,
  PlanningRunState,
} from "./planning-contract.js";
import {
  PLANNING_RUN_COMMAND_KINDS,
  PLANNING_RUN_TRANSITIONS,
  reducePlanningRun,
} from "./planning-run-reducer.js";
import {
  ACTIVATION,
  CANCELLATION,
  HASHES,
  PLAN_APPROVAL,
  REVISE,
  accepted,
  commandFor,
  expectError,
  expectIllegal,
  hash,
  state,
} from "./planning-run-test-fixtures.js";

describe("planning run approval and activation", () => {
  it("binds exact plan hashes on approval and grants no execution authority", () => {
    const next = accepted(reducePlanningRun(state("PLAN_REVIEW"), commandFor("plan.approve")));
    expect(next).toMatchObject({ graphRevisionRef: "graph-revision-1", lifecycle: "APPROVED",
      version: 8 });
    expect(next.approvedHashes).toEqual(HASHES);
  });

  it("rejects every perturbed approval hash with zero state change", () => {
    const source = state("PLAN_REVIEW");
    const before = JSON.stringify(source);
    for (const key of ["dependencyHash", "graphContentHash", "planHash", "qualityHash"] as const) {
      const command = { ...commandFor("plan.approve"),
        witness: { ...PLAN_APPROVAL, [key]: hash("99") } };
      expectIllegal(reducePlanningRun(source, command as PlanningRunCommand),
        "plan.approve", "PLAN_REVIEW");
      expect(JSON.stringify(source)).toBe(before);
    }
  });

  it("re-presents an identical approval idempotently and refuses stale bytes", () => {
    const approvedState = state("APPROVED");
    const replay = reducePlanningRun(approvedState, commandFor("plan.approve"));
    expect(replay.ok && replay.events).toEqual([]);
    expect(accepted(replay)).toEqual(approvedState);
    const stale = { ...commandFor("plan.approve"),
      witness: { ...PLAN_APPROVAL, qualityHash: hash("99") } };
    expectIllegal(reducePlanningRun(approvedState, stale as PlanningRunCommand),
      "plan.approve", "APPROVED");
  });

  it("rejects the plan on REVISE_PLAN and demands human authorization", () => {
    const result = reducePlanningRun(state("PLAN_REVIEW"), commandFor("plan.revise"));
    expect(accepted(result).lifecycle).toBe("REJECTED");
    expect(result.ok && result.successor?.runId).toBe("planning-run-3");
    const daemon = { ...commandFor("plan.revise"),
      witness: { ...REVISE, truthClass: "DAEMON_VERIFIED" } };
    expectIllegal(reducePlanningRun(state("PLAN_REVIEW"), daemon as PlanningRunCommand),
      "plan.revise", "PLAN_REVIEW");
  });

  it("activates PLAN_REVIEW through one compound J1 result", () => {
    const result = reducePlanningRun(state("PLAN_REVIEW"), commandFor("graph.approve"));
    const next = accepted(result);
    expect(next).toMatchObject({ lifecycle: "ACTIVATED", version: 9 });
    expect(next.approvedHashes).toEqual(HASHES);
    expect(result.ok && result.events.map((event) => event.kind))
      .toEqual(["PlanApproved", "PlanningRunActivated"]);
    expect(result.ok && result.events.map((event) => event.version)).toEqual([8, 9]);
  });

  it("activates an already APPROVED run without a second plan decision", () => {
    const single = { commandId: "cmd-graph.approve", expectedVersion: 7,
      kind: "graph.approve", witness: ACTIVATION };
    const result = reducePlanningRun(state("APPROVED"), single as PlanningRunCommand);
    expect(accepted(result)).toMatchObject({ lifecycle: "ACTIVATED", version: 8 });
    expect(result.ok && result.events.map((event) => event.kind)).toEqual(["PlanningRunActivated"]);
    expectIllegal(reducePlanningRun(state("APPROVED"), commandFor("graph.approve")),
      "graph.approve", "APPROVED");
  });

  it("refuses activation on stale graph, quality, budget, or policy bytes", () => {
    for (const key of ["graphHash", "qualityHash"] as const) {
      const command = { ...commandFor("graph.approve"),
        witness: { ...ACTIVATION, [key]: hash("99") } };
      expectIllegal(reducePlanningRun(state("PLAN_REVIEW"), command as PlanningRunCommand),
        "graph.approve", "PLAN_REVIEW");
    }
    for (const key of ["budgetHash", "policyHash"] as const) {
      const command = { ...commandFor("graph.approve"),
        witness: { ...ACTIVATION, [key]: "nothex" } };
      expectIllegal(reducePlanningRun(state("PLAN_REVIEW"), command as PlanningRunCommand),
        "graph.approve", "PLAN_REVIEW");
    }
    const draftMissing = { ...commandFor("graph.approve"),
      witness: { ...ACTIVATION, goalDraftNoActiveRevision: false } };
    expectIllegal(reducePlanningRun(state("PLAN_REVIEW"), draftMissing as PlanningRunCommand),
      "graph.approve", "PLAN_REVIEW");
  });
});

describe("planning run cancellation and concurrency", () => {
  it("cancels an initial run only through authorized goal cancellation", () => {
    for (const lifecycle of ["DRAFT", "READY", "PLANNING", "PLAN_REVIEW", "APPROVED"] as const) {
      const next = accepted(reducePlanningRun(state(lifecycle), commandFor("goal.cancel")));
      expect(next).toMatchObject({ lifecycle: "CANCELLED", version: 8 });
      expect(next.facets).toEqual({ leaseSuspect: false, livePlannerEffect: false, owned: false,
        resumable: false });
    }
    const daemon = { ...commandFor("goal.cancel"),
      witness: { ...CANCELLATION, truthClass: "DAEMON_VERIFIED" } };
    expectIllegal(reducePlanningRun(state("DRAFT"), daemon as PlanningRunCommand),
      "goal.cancel", "DRAFT");
    const live = state("PLANNING", { facets: { leaseSuspect: false, livePlannerEffect: true,
      owned: true, resumable: false } });
    expectIllegal(reducePlanningRun(live, commandFor("goal.cancel")), "goal.cancel", "PLANNING");
  });

  it("refuses expansion-only planning.cancel from every lifecycle", () => {
    for (const lifecycle of RUNTIME_LIFECYCLES.PLANNING_RUN) {
      const result = reducePlanningRun(state(lifecycle), commandFor("planning.cancel"));
      expect(result.ok).toBe(false);
    }
    expectIllegal(reducePlanningRun(state("PLANNING"), commandFor("planning.cancel")),
      "planning.cancel", "PLANNING");
  });

  it("separates version conflicts, malformed versions, and missing command identity", () => {
    expectError(reducePlanningRun(state("DRAFT"), commandFor("planning.ready", 6)),
      "EXPECTED_VERSION_CONFLICT", { actualVersion: 7, expectedVersion: 6 });
    expectIllegal(reducePlanningRun(state("DRAFT"), commandFor("planning.ready", -1)),
      "planning.ready", "DRAFT");
    expectError(reducePlanningRun(state("DRAFT"),
      { ...commandFor("planning.ready"), commandId: "" } as PlanningRunCommand),
      "IDEMPOTENCY_CONFLICT");
    expectError(reducePlanningRun(null as unknown as PlanningRunState,
      commandFor("planning.ready")), "UNKNOWN_ERROR");
    expectError(reducePlanningRun(state("DRAFT"),
      { ...commandFor("planning.ready"), kind: "planning.unknown" } as unknown as
        PlanningRunCommand), "UNKNOWN_ERROR");
  });

  it("guards the version ceiling including the compound activation delta", () => {
    const last = Number.MAX_SAFE_INTEGER - 1;
    expectIllegal(reducePlanningRun(state("PLAN_REVIEW", { version: last }),
      commandFor("graph.approve", last)), "graph.approve", "PLAN_REVIEW");
    const approvedRun = state("APPROVED", { version: Number.MAX_SAFE_INTEGER });
    const single = { commandId: "cmd-graph.approve", expectedVersion: Number.MAX_SAFE_INTEGER,
      kind: "graph.approve", witness: ACTIVATION };
    expectIllegal(reducePlanningRun(approvedRun, single as PlanningRunCommand),
      "graph.approve", "APPROVED");
  });

  it("covers every command kind against every lifecycle", () => {
    const seen = new Set<string>();
    for (const kind of PLANNING_RUN_COMMAND_KINDS) {
      const allowed: readonly PlanningRunLifecycle[] = PLANNING_RUN_TRANSITIONS[kind];
      for (const lifecycle of RUNTIME_LIFECYCLES.PLANNING_RUN) {
        seen.add(`${kind}:${lifecycle}`);
        const result = reducePlanningRun(state(lifecycle), commandFor(kind));
        if (allowed.includes(lifecycle)) continue;
        if (lifecycle === "SUBMISSION_DRAINING") {
          expectError(result, "PLANNING_SUBMISSION_FINALIZING",
            { sourceState: "SUBMISSION_DRAINING" });
          continue;
        }
        expectIllegal(result, kind, lifecycle);
      }
    }
    expect(seen.size)
      .toBe(PLANNING_RUN_COMMAND_KINDS.length * RUNTIME_LIFECYCLES.PLANNING_RUN.length);
  });
});
