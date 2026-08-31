import { describe, expect, it } from "vitest";

import { GRAPH_REVISION_COMMAND_KINDS, reduceGraphRevision } from "./graph-revision-reducer.js";
import {
  approvedRevision, planReviewRun, revisionCommand, revisionTrace, runCommand, runTrace,
  sealedRun, SEEDS,
} from "./planning-invariant-drivers.js";
import {
  BUDGET_HASH, PLAN_APPROVAL, PLAN_HASH, perturb, REVISION_ACTIVATION,
} from "./planning-invariant-fixtures.js";
import { PLANNING_RUN_COMMAND_KINDS, reducePlanningRun } from "./planning-run-reducer.js";

describe("planning aggregate properties", () => {
  it("never moves either aggregate backward and is deterministic per seed", () => {
    const observed = new Set<unknown>();
    for (const seed of SEEDS) {
      expect(runTrace(seed, 1)).toEqual(runTrace(seed, 1));
      const trace = revisionTrace(seed);
      expect(trace).toEqual(revisionTrace(seed));
      for (const entry of trace) if (Array.isArray(entry)) observed.add(entry[1]);
    }
    expect(observed.has("SUPERSEDED")).toBe(true);
  });

  it("keeps bounded multi-node lifecycle walks deterministic and admissible", () => {
    const observed: unknown[] = [];
    for (const seed of SEEDS) {
      for (const bearing of [2, 3, 5]) observed.push(...runTrace(seed, bearing));
    }
    expect(observed.some((entry) => Array.isArray(entry) && entry[1] === "PLAN_REVIEW")).toBe(true);
    expect(observed.some((entry) => Array.isArray(entry)
      && entry[1] === "MULTI_NODE_EXECUTION_UNSUPPORTED")).toBe(false);
  });

  it("admits a multi-node revision and still lets an explicit refusal land on a fresh run", () => {
    const sealed = sealedRun();
    const before = JSON.stringify(sealed);
    const admission = reducePlanningRun(sealed,
      runCommand("planning.finalize_submission", sealed.version, 4, 3));
    expect(admission.ok).toBe(true);
    if (!admission.ok) throw new Error("expected multi-node admission");
    expect(admission.state.lifecycle).toBe("PLAN_REVIEW");
    expect(JSON.stringify(sealed)).toBe(before);
    const fresh = sealedRun();
    const refused = reducePlanningRun(fresh,
      runCommand("planning.finalize_submission", fresh.version, 4, 4));
    expect(refused.ok).toBe(true);
    if (!refused.ok) return;
    expect(refused.state.lifecycle).toBe("REJECTED");
    expect(refused.successor?.runId).toBe("planning-run-2");
  });

  it("rejects every perturbed approval and activation digest with zero state change", () => {
    const run = planReviewRun();
    const runBefore = JSON.stringify(run);
    const revision = approvedRevision();
    const revisionBefore = JSON.stringify(revision);
    for (let index = 0; index < 12; index += 1) {
      const approval = { ...PLAN_APPROVAL, planHash: perturb(PLAN_HASH, index) };
      const approved = reducePlanningRun(run, { commandId: `cmd-approve-${index}`,
        expectedVersion: run.version, kind: "plan.approve", witness: approval });
      expect(approved.ok).toBe(false);
      expect(JSON.stringify(run)).toBe(runBefore);
      const activation = { ...REVISION_ACTIVATION, budgetHash: perturb(BUDGET_HASH, index) };
      const activated = reduceGraphRevision(revision, { activation,
        commandId: `cmd-activate-${index}`, expectedVersion: revision.version,
        kind: "graph.approve" });
      expect(activated.ok).toBe(false);
      if (!activated.ok) expect(activated.error.code).toBe("REVISION_REBOUND");
      expect(JSON.stringify(revision)).toBe(revisionBefore);
    }
  });

  it("commits the compound J1 decision as one result with no observable intermediate", () => {
    const run = planReviewRun();
    const activated = reducePlanningRun(run, runCommand("graph.approve", run.version, 1, 2));
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(activated.state.lifecycle).toBe("ACTIVATED");
    expect(activated.events.map((event) => event.kind))
      .toEqual(["PlanApproved", "PlanningRunActivated"]);
    const revision = reduceGraphRevision(undefined, revisionCommand("graph_revision.create", 0, 1));
    expect(revision.ok).toBe(true);
    if (!revision.ok) return;
    const submitted = reduceGraphRevision(revision.state,
      revisionCommand("graph_revision.submit", revision.state.version, 1));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const compound = reduceGraphRevision(submitted.state,
      revisionCommand("graph.approve", submitted.state.version, 2));
    expect(compound.ok).toBe(true);
    if (!compound.ok) return;
    expect(compound.state.lifecycle).toBe("ACTIVE");
    expect(compound.events.map((event) => event.kind))
      .toEqual(["GraphRevisionApproved", "GraphRevisionActivated"]);
  });

  it("strips authority from a rejected run and never aliases its successor", () => {
    const run = planReviewRun();
    const rejection = reducePlanningRun(run, {
      commandId: "cmd-revise", expectedVersion: run.version, kind: "plan.revise",
      witness: { findingsRef: "findings-1", successorRunId: "planning-run-2",
        truthClass: "HUMAN_APPROVED" },
    });
    expect(rejection.ok).toBe(true);
    if (!rejection.ok || rejection.successor === undefined) throw new Error("no successor");
    const successor = rejection.successor;
    expect(successor.facets).not.toBe(rejection.state.facets);
    expect(successor.sealedHashes).toBeNull();
    expect(successor.lifecycle).toBe("DRAFT");
    for (const kind of PLANNING_RUN_COMMAND_KINDS) {
      const result = reducePlanningRun(rejection.state,
        runCommand(kind, rejection.state.version, 1, 1));
      expect(result.ok).toBe(false);
    }
  });

  it("freezes an active revision against every command except the supersession replacing it", () => {
    const approved = approvedRevision();
    const active = reduceGraphRevision(approved,
      revisionCommand("graph.approve", approved.version, 1, approved));
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    expect(active.state.lifecycle).toBe("ACTIVE");
    const before = JSON.stringify(active.state);
    let refused = 0;
    for (const kind of GRAPH_REVISION_COMMAND_KINDS) {
      if (kind === "graph.supersede") continue;
      const result = reduceGraphRevision(active.state,
        revisionCommand(kind, active.state.version, 1, active.state));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("ILLEGAL_TRANSITION");
      expect(JSON.stringify(active.state)).toBe(before);
      refused += 1;
    }
    expect(refused).toBe(GRAPH_REVISION_COMMAND_KINDS.length - 1);
    const superseded = reduceGraphRevision(active.state,
      revisionCommand("graph.supersede", active.state.version, 1, active.state));
    expect(superseded.ok).toBe(true);
    if (!superseded.ok) return;
    expect(superseded.state.lifecycle).toBe("SUPERSEDED");
    expect(JSON.stringify(active.state)).toBe(before);
  });
});
