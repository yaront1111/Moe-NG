import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import type {
  PlanRevisionHashes,
  PlanningRunCommand,
  PlanningRunCommandKind,
  PlanningRunLifecycle,
  PlanningRunReducerResult,
  PlanningRunState,
} from "./planning-contract.js";
import {
  PLANNING_RUN_COMMAND_KINDS,
  PLANNING_RUN_TRANSITIONS,
  reducePlanningRun,
} from "./planning-run-reducer.js";

function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

const PLAN_HASH = hash("11");
const GRAPH_HASH = hash("22");
const QUALITY_HASH = hash("33");
const DEPENDENCY_HASH = hash("44");
const BUDGET_HASH = hash("55");
const POLICY_HASH = hash("66");
const SUBMISSION_HASH = hash("77");

const HASHES: PlanRevisionHashes = {
  dependencyHash: DEPENDENCY_HASH, graphContentHash: GRAPH_HASH,
  planHash: PLAN_HASH, qualityHash: QUALITY_HASH,
};
const READINESS = { acceptanceCriteriaRef: "criteria-1", intentBaseRef: "intent-1",
  planningBudgetRef: "budget-1", truthClass: "DAEMON_VERIFIED" } as const;
const CLAIM = { attemptRef: "attempt-1", contextRef: "context-1", leaseRef: "lease-1",
  providerSlotRef: "slot-1", truthClass: "DAEMON_VERIFIED" } as const;
const RESUME = { handoffKind: "SAFE_RELEASE_HANDOFF", handoffRef: "handoff-1",
  priorAttemptTerminalRef: "attempt-0-terminal", truthClass: "DAEMON_VERIFIED" } as const;
const RELEASE = { attemptTerminalRef: "attempt-1-released", handoffRef: "handoff-1",
  truthClass: "DAEMON_VERIFIED" } as const;
const RECOVERY = { effectsAbsentRef: "effects-absent-1", leaseFencedRef: "lease-fenced-1",
  missingInMemoryState: "UNKNOWN", priorAttemptTerminalRef: "attempt-1-terminal",
  recoverySealRef: "no-handoff-recovery-1", resourcesAbsentRef: "resources-absent-1",
  truthClass: "DAEMON_VERIFIED" } as const;
const SUBMISSION = { attemptRef: "attempt-1", submissionRef: "submission-1",
  truthClass: "DAEMON_VERIFIED" } as const;
const EFFECT_TERMINAL = { effectTerminalRef: "effect-terminal-1",
  resourcesTerminalRef: "resources-terminal-1", truthClass: "DAEMON_VERIFIED" } as const;
const REVISION_SEAL = { ...HASHES, graphRevisionRef: "graph-revision-1" } as const;
const REFUSAL = { findingsRef: "findings-1", successorRunId: "planning-run-2",
  truthClass: "DAEMON_VERIFIED" } as const;
const PLAN_APPROVAL = { ...HASHES, approvalRef: "plan-approval-1",
  truthClass: "HUMAN_APPROVED" } as const;
const REVISE = { findingsRef: "findings-2", successorRunId: "planning-run-3",
  truthClass: "HUMAN_APPROVED" } as const;
const ACTIVATION = { activationRef: "activation-1", budgetHash: BUDGET_HASH,
  expectedGoalVersion: 3, goalDraftNoActiveRevision: true, graphHash: GRAPH_HASH,
  policyHash: POLICY_HASH, qualityHash: QUALITY_HASH, truthClass: "HUMAN_APPROVED" } as const;
const CANCELLATION = { authorizationRef: "cancel-1", noLiveOrUnknownEffect: true,
  truthClass: "HUMAN_APPROVED" } as const;

function summaries(bearing: number): readonly { executionBearing: boolean; nodeKey: string }[] {
  const items: { executionBearing: boolean; nodeKey: string }[] = [];
  for (let index = 0; index < bearing; index += 1) {
    items.push({ executionBearing: true, nodeKey: `node-${index}` });
  }
  items.push({ executionBearing: false, nodeKey: "review-node" });
  return items;
}

function finalizeWitness(bearing: number): Record<string, unknown> {
  return { attemptTerminalRef: "attempt-1-terminal", effectTerminalRef: "effect-terminal-1",
    nodeSummaries: summaries(bearing), providerSlotTerminalRef: "slot-1-released",
    resourcesTerminalRef: "resources-terminal-1", truthClass: "DAEMON_VERIFIED" };
}

const SEALED: readonly PlanningRunLifecycle[] = ["PLAN_REVIEW", "APPROVED", "ACTIVATED"];

function state(
  lifecycle: PlanningRunLifecycle,
  overrides: Partial<PlanningRunState> = {},
): PlanningRunState {
  const owned = lifecycle === "PLANNING" || lifecycle === "SUBMISSION_DRAINING";
  const sealed = SEALED.includes(lifecycle);
  const approved = lifecycle === "APPROVED" || lifecycle === "ACTIVATED";
  return {
    approvedHashes: approved ? { ...HASHES } : null,
    attemptRef: owned ? "attempt-1" : null,
    facets: { leaseSuspect: false, livePlannerEffect: lifecycle === "SUBMISSION_DRAINING",
      owned, resumable: false },
    goalRef: "goal-1",
    graphRevisionRef: sealed ? "graph-revision-1" : null,
    leaseRef: owned ? "lease-1" : null,
    lifecycle,
    runId: "planning-run-1",
    runKind: "INITIAL",
    sealedHashes: sealed ? { ...HASHES } : null,
    submissionHash: sealed || lifecycle === "SUBMISSION_DRAINING" ? SUBMISSION_HASH : null,
    version: 7,
    ...overrides,
  };
}

function commandFor(kind: PlanningRunCommandKind, expectedVersion = 7): PlanningRunCommand {
  const base = { commandId: `cmd-${kind}`, expectedVersion };
  switch (kind) {
    case "planning.create_draft":
      return { ...base, goalRef: "goal-1", kind, runId: "planning-run-1", runKind: "INITIAL" };
    case "planning.ready": return { ...base, kind, witness: READINESS };
    case "planning.claim": return { ...base, kind, witness: CLAIM };
    case "planning.release": return { ...base, kind, witness: RELEASE };
    case "planning.recover_absent": return { ...base, kind, witness: RECOVERY };
    case "plan.propose":
      return { ...base, kind, proposalKind: "INITIAL", submissionHash: SUBMISSION_HASH,
        witness: SUBMISSION };
    case "planning.finalize_submission":
      return { ...base, kind, revision: REVISION_SEAL,
        witness: finalizeWitness(1) } as unknown as PlanningRunCommand;
    case "plan.approve": return { ...base, kind, witness: PLAN_APPROVAL };
    case "plan.revise": return { ...base, kind, witness: REVISE };
    case "graph.approve": return { ...base, kind, planApproval: PLAN_APPROVAL, witness: ACTIVATION };
    case "goal.cancel": return { ...base, kind, witness: CANCELLATION };
    case "planning.cancel": return { ...base, kind, witness: CANCELLATION };
  }
}

function expectError(
  result: PlanningRunReducerResult,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): void {
  expect(result.ok).toBe(false);
  if (result.ok || "unsupported" in result) throw new Error(`expected ${code} rejection`);
  expect(result.error.code).toBe(code);
  if (details !== undefined) expect({ ...result.error.details }).toEqual(details);
}

function expectIllegal(
  result: PlanningRunReducerResult,
  commandKind: PlanningRunCommandKind,
  sourceState: PlanningRunLifecycle,
): void {
  expectError(result, "ILLEGAL_TRANSITION", {
    aggregateKind: "PLANNING_RUN", commandKind, sourceState,
  });
}

function accepted(result: PlanningRunReducerResult): PlanningRunState {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected accepted result");
  return result.state;
}

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
