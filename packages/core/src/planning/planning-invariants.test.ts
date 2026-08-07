import { describe, expect, it } from "vitest";

import type {
  GraphRevisionCommand,
  GraphRevisionCommandKind,
  GraphRevisionLifecycle,
  GraphRevisionState,
} from "./graph-revision-contract.js";
import {
  GRAPH_REVISION_COMMAND_KINDS,
  reduceGraphRevision,
} from "./graph-revision-reducer.js";
import type {
  PlanningRunCommand,
  PlanningRunCommandKind,
  PlanningRunLifecycle,
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

const HASHES = { dependencyHash: DEPENDENCY_HASH, graphContentHash: GRAPH_HASH,
  planHash: PLAN_HASH, qualityHash: QUALITY_HASH } as const;
const BINDING = { budgetHash: BUDGET_HASH, expectedGoalVersion: 3, graphHash: GRAPH_HASH,
  policyHash: POLICY_HASH, qualityHash: QUALITY_HASH } as const;
const PLAN_APPROVAL = { ...HASHES, approvalRef: "plan-approval-1",
  truthClass: "HUMAN_APPROVED" } as const;
const RUN_ACTIVATION = { activationRef: "activation-1", budgetHash: BUDGET_HASH,
  expectedGoalVersion: 3, goalDraftNoActiveRevision: true, graphHash: GRAPH_HASH,
  policyHash: POLICY_HASH, qualityHash: QUALITY_HASH, truthClass: "HUMAN_APPROVED" } as const;
const REVISION_ACTIVATION = { ...BINDING, activationRef: "activation-1",
  truthClass: "HUMAN_APPROVED" } as const;

/** Terminal lifecycles must absorb every later command; ranks must never decrease. */
const RUN_RANK: Readonly<Record<PlanningRunLifecycle, number>> = {
  DRAFT: 0, READY: 1, PLANNING: 2, SUBMISSION_DRAINING: 3, PLAN_REVIEW: 4, APPROVED: 5,
  ACTIVATED: 6, REJECTED: 7, CANCELLED: 7,
};
const RUN_TERMINAL: ReadonlySet<string> = new Set(["ACTIVATED", "REJECTED", "CANCELLED"]);
const RUN_APPROVAL_STATES: ReadonlySet<string> = new Set(["PLAN_REVIEW", "APPROVED", "ACTIVATED"]);
const REVISION_RANK: Readonly<Record<GraphRevisionLifecycle, number>> = {
  DRAFT: 0, PENDING_APPROVAL: 1, APPROVED: 2, ACTIVE: 3, SUPERSEDED: 4, REJECTED: 5,
};
const REVISION_TERMINAL: ReadonlySet<string> = new Set(["ACTIVE", "SUPERSEDED", "REJECTED"]);

function xorshift32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return value >>> 0;
  };
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") return;
  const target = value as object;
  if (seen.has(target)) return;
  seen.add(target);
  expect(Object.isFrozen(target)).toBe(true);
  for (const key of Reflect.ownKeys(target)) {
    expectDeepFrozen((target as Record<PropertyKey, unknown>)[key], seen);
  }
}

/** Flips one hex character so the perturbed digest is always a different 64-char hex value. */
function perturb(value: string, index: number): string {
  const position = index % value.length;
  const replacement = value[position] === "a" ? "b" : "a";
  return `${value.slice(0, position)}${replacement}${value.slice(position + 1)}`;
}

function summaries(bearing: number): readonly { executionBearing: boolean; nodeKey: string }[] {
  const items: { executionBearing: boolean; nodeKey: string }[] = [
    { executionBearing: false, nodeKey: "review-node" },
  ];
  for (let index = 0; index < bearing; index += 1) {
    items.push({ executionBearing: true, nodeKey: `node-${index}` });
  }
  return items;
}

function finalizeWitness(bearing: number): Record<string, unknown> {
  return { attemptTerminalRef: "attempt-terminal", effectTerminalRef: "effect-terminal",
    nodeSummaries: summaries(bearing), providerSlotTerminalRef: "slot-released",
    resourcesTerminalRef: "resources-terminal", truthClass: "DAEMON_VERIFIED" };
}

function runCommand(
  kind: PlanningRunCommandKind,
  expectedVersion: number,
  bearing: number,
  roll: number,
): PlanningRunCommand {
  const base = { commandId: `cmd-${kind}-${roll}`, expectedVersion };
  const cancellation = { authorizationRef: "cancel-1", noLiveOrUnknownEffect: true,
    truthClass: "HUMAN_APPROVED" };
  const refusal = { findingsRef: "findings-1", successorRunId: "planning-run-2",
    truthClass: roll % 2 === 0 ? "HUMAN_APPROVED" : "DAEMON_VERIFIED" };
  const bodies: Readonly<Record<PlanningRunCommandKind, Record<string, unknown>>> = {
    "planning.create_draft": { goalRef: "goal-1", runId: "planning-run-1", runKind: "INITIAL" },
    "planning.ready": { witness: { acceptanceCriteriaRef: "criteria-1",
      intentBaseRef: "intent-1", planningBudgetRef: "budget-1", truthClass: "DAEMON_VERIFIED" } },
    "planning.claim": { witness: { attemptRef: "attempt-1", contextRef: "context-1",
      leaseRef: "lease-1", providerSlotRef: "slot-1", truthClass: "DAEMON_VERIFIED" },
      ...(roll % 2 === 0 ? { resumeProof: { handoffKind: "SAFE_RELEASE_HANDOFF",
        handoffRef: "handoff-1", priorAttemptTerminalRef: "attempt-0",
        truthClass: "DAEMON_VERIFIED" } } : {}) },
    "planning.release": { witness: { attemptTerminalRef: "attempt-released",
      handoffRef: "handoff-1", truthClass: "DAEMON_VERIFIED" } },
    "planning.recover_absent": { witness: { effectsAbsentRef: "effects-absent",
      leaseFencedRef: "lease-fenced", missingInMemoryState: "UNKNOWN",
      priorAttemptTerminalRef: "attempt-terminal", recoverySealRef: "recovery-1",
      resourcesAbsentRef: "resources-absent", truthClass: "DAEMON_VERIFIED" } },
    "plan.propose": { proposalKind: "INITIAL", submissionHash: SUBMISSION_HASH,
      witness: { attemptRef: "attempt-1", submissionRef: "submission-1",
        truthClass: "DAEMON_VERIFIED" },
      ...(roll % 3 === 0 ? { effectTerminalProof: { effectTerminalRef: "effect-terminal",
        resourcesTerminalRef: "resources-terminal", truthClass: "DAEMON_VERIFIED" } } : {}) },
    "planning.finalize_submission": { witness: finalizeWitness(bearing),
      ...(roll % 4 === 0 ? { refusal } : { revision: { ...HASHES,
        graphRevisionRef: "graph-revision-1" } }) },
    "plan.approve": { witness: PLAN_APPROVAL },
    "plan.revise": { witness: refusal },
    "graph.approve": { witness: RUN_ACTIVATION,
      ...(roll % 2 === 0 ? { planApproval: PLAN_APPROVAL } : {}) },
    "goal.cancel": { witness: cancellation },
    "planning.cancel": { witness: cancellation },
  };
  return { ...base, kind, ...bodies[kind] } as unknown as PlanningRunCommand;
}

/** Biased toward legal moves so long sequences reach the deep states, still 30% adversarial. */
function pickRunKind(roll: number, lifecycle: PlanningRunLifecycle | undefined): string {
  const uniform = PLANNING_RUN_COMMAND_KINDS[roll % PLANNING_RUN_COMMAND_KINDS.length];
  if (lifecycle === undefined || roll % 10 >= 7) return uniform ?? "goal.cancel";
  const allowed = PLANNING_RUN_COMMAND_KINDS.filter((kind) =>
    (PLANNING_RUN_TRANSITIONS[kind] as readonly string[]).includes(lifecycle));
  return allowed[roll % allowed.length] ?? uniform ?? "goal.cancel";
}

function runTrace(seed: number, bearing: number): readonly unknown[] {
  const next = xorshift32(seed);
  const pool = runSeedPool(bearing);
  const entries: unknown[] = [];
  let current = pool[next() % pool.length];
  for (let index = 0; index < 120; index += 1) {
    if (current !== undefined && RUN_TERMINAL.has(current.lifecycle) && next() % 2 === 0) {
      current = pool[next() % pool.length];
      entries.push(["restart", current?.lifecycle ?? "none"]);
    }
    const kind = pickRunKind(next(), current?.lifecycle) as PlanningRunCommandKind;
    const actual = current?.version ?? 0;
    const expected = next() % 5 === 0 ? actual + 1 : actual;
    const before = current === undefined ? undefined : JSON.stringify(current);
    const source = current?.lifecycle;
    const result = reducePlanningRun(current, runCommand(kind, expected, bearing, next()));
    expectDeepFrozen(result);
    if (!result.ok) {
      expect(current === undefined ? undefined : JSON.stringify(current)).toBe(before);
      entries.push([kind, "unsupported" in result ? result.reason : result.error.code]);
      continue;
    }
    if (source !== undefined) {
      expect(RUN_TERMINAL.has(source)).toBe(false);
      expect(RUN_RANK[result.state.lifecycle]).toBeGreaterThanOrEqual(RUN_RANK[source]);
    }
    if (bearing > 1) expect(RUN_APPROVAL_STATES.has(result.state.lifecycle)).toBe(false);
    expect(result.state.runId).toBe("planning-run-1");
    current = result.state;
    entries.push([kind, current.lifecycle, current.version]);
  }
  return entries;
}

function revisionCommand(
  kind: GraphRevisionCommandKind,
  expectedVersion: number,
  roll: number,
): GraphRevisionCommand {
  const base = { commandId: `cmd-${kind}-${roll}`, expectedVersion };
  const refusal = { findingsRef: "findings-1", truthClass: "DAEMON_VERIFIED" };
  const bodies: Readonly<Record<GraphRevisionCommandKind, Record<string, unknown>>> = {
    "graph_revision.create": { goalRef: "goal-1", graphContentHash: GRAPH_HASH,
      planHash: PLAN_HASH, revisionId: "graph-revision-1" },
    "graph_revision.submit": { witness: { submissionRef: "submission-1",
      truthClass: "DAEMON_VERIFIED" } },
    "graph.approve": {
      ...(roll % 3 === 1 ? {} : { approval: { ...BINDING, approvalRef: "approval-1",
        truthClass: "HUMAN_APPROVED" } }),
      ...(roll % 3 === 0 ? {} : { activation: REVISION_ACTIVATION }) },
    "graph_revision.reject": { witness: refusal },
    "graph.supersede": { witness: refusal },
  };
  return { ...base, kind, ...bodies[kind] } as unknown as GraphRevisionCommand;
}

function revisionTrace(seed: number): readonly unknown[] {
  const next = xorshift32(seed);
  const entries: unknown[] = [];
  let current: GraphRevisionState | undefined;
  for (let index = 0; index < 120; index += 1) {
    if (current !== undefined && REVISION_TERMINAL.has(current.lifecycle) && next() % 2 === 0) {
      current = undefined;
      entries.push(["restart"]);
    }
    const kind = GRAPH_REVISION_COMMAND_KINDS[next() % GRAPH_REVISION_COMMAND_KINDS.length];
    if (kind === undefined) throw new Error("graph revision vocabulary is empty");
    const actual = current?.version ?? 0;
    const expected = next() % 5 === 0 ? actual + 1 : actual;
    const before = current === undefined ? undefined : JSON.stringify(current);
    const source = current?.lifecycle;
    const result = reduceGraphRevision(current, revisionCommand(kind, expected, next()));
    expectDeepFrozen(result);
    if (!result.ok) {
      expect(current === undefined ? undefined : JSON.stringify(current)).toBe(before);
      entries.push([kind, result.error.code]);
      continue;
    }
    if (source !== undefined) {
      expect(REVISION_TERMINAL.has(source)).toBe(false);
      expect(REVISION_RANK[result.state.lifecycle]).toBeGreaterThanOrEqual(REVISION_RANK[source]);
    }
    expect(result.state.graphContentHash).toBe(GRAPH_HASH);
    expect(result.state.planHash).toBe(PLAN_HASH);
    current = result.state;
    entries.push([kind, current.lifecycle, current.version]);
  }
  return entries;
}

const SEEDS = [1, 7, 0x12345678, 0xdeadbeef, 0x0badf00d] as const;

type RunStep = readonly [PlanningRunCommandKind, number];

const DRAFT_STEPS: readonly RunStep[] = [["planning.create_draft", 1]];
const READY_STEPS: readonly RunStep[] = [...DRAFT_STEPS, ["planning.ready", 3]];
const OWNED_STEPS: readonly RunStep[] = [...READY_STEPS, ["planning.claim", 3]];
/** Roll 3 carries the terminal-effect proof, so the submission seals into PLANNING. */
const SEALED_STEPS: readonly RunStep[] = [...OWNED_STEPS, ["plan.propose", 3]];
/** Roll 1 omits it, so the same submission seals into SUBMISSION_DRAINING. */
const DRAINING_STEPS: readonly RunStep[] = [...OWNED_STEPS, ["plan.propose", 1]];
const REVIEW_STEPS: readonly RunStep[] = [...SEALED_STEPS, ["planning.finalize_submission", 3]];
const APPROVED_STEPS: readonly RunStep[] = [...REVIEW_STEPS, ["plan.approve", 1]];

function driveRun(steps: readonly RunStep[], expected: PlanningRunLifecycle): PlanningRunState {
  let current: PlanningRunState | undefined;
  for (const [kind, roll] of steps) {
    const result = reducePlanningRun(current, runCommand(kind, current?.version ?? 0, 1, roll));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`sequence failed at ${kind}`);
    current = result.state;
  }
  if (current === undefined) throw new Error("no run built");
  expect(current.lifecycle).toBe(expected);
  return current;
}

/**
 * Random walks alone almost never reach the deep states, so every trace starts from — and
 * restarts into — a real reduced state. Multi-node traces are seeded only at or before the
 * sealed submission, which is exactly where the admission gate has to hold.
 */
function runSeedPool(bearing: number): readonly (PlanningRunState | undefined)[] {
  const pool: (PlanningRunState | undefined)[] = [
    undefined, driveRun(DRAFT_STEPS, "DRAFT"), driveRun(READY_STEPS, "READY"),
    driveRun(OWNED_STEPS, "PLANNING"), driveRun(SEALED_STEPS, "PLANNING"),
    driveRun(DRAINING_STEPS, "SUBMISSION_DRAINING"),
  ];
  if (bearing === 1) {
    pool.push(driveRun(REVIEW_STEPS, "PLAN_REVIEW"), driveRun(APPROVED_STEPS, "APPROVED"));
  }
  return pool;
}

function sealedRun(): PlanningRunState {
  const current = driveRun(SEALED_STEPS, "PLANNING");
  expect(current.submissionHash).toBe(SUBMISSION_HASH);
  return current;
}

function planReviewRun(): PlanningRunState {
  return driveRun(REVIEW_STEPS, "PLAN_REVIEW");
}

function approvedRevision(): GraphRevisionState {
  let current: GraphRevisionState | undefined;
  const steps: readonly [GraphRevisionCommandKind, number][] = [
    ["graph_revision.create", 1], ["graph_revision.submit", 1], ["graph.approve", 3],
  ];
  for (const [kind, roll] of steps) {
    const result = reduceGraphRevision(current, revisionCommand(kind, current?.version ?? 0, roll));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`sequence failed at ${kind}`);
    current = result.state;
  }
  if (current === undefined) throw new Error("no revision built");
  expect(current.lifecycle).toBe("APPROVED");
  return current;
}

describe("planning aggregate properties", () => {
  it("never moves either aggregate backward and is deterministic per seed", () => {
    for (const seed of SEEDS) {
      expect(runTrace(seed, 1)).toEqual(runTrace(seed, 1));
      expect(revisionTrace(seed)).toEqual(revisionTrace(seed));
    }
  });

  it("keeps every multi-node graph out of plan review, approval, and activation", () => {
    const observed: unknown[] = [];
    for (const seed of SEEDS) {
      for (const bearing of [2, 3, 5]) observed.push(...runTrace(seed, bearing));
    }
    expect(observed.some((entry) => Array.isArray(entry)
      && entry[1] === "MULTI_NODE_EXECUTION_UNSUPPORTED")).toBe(true);
  });

  it("refuses a multi-node admission and still lets the follow-up refusal land", () => {
    const sealed = sealedRun();
    const before = JSON.stringify(sealed);
    const admission = reducePlanningRun(sealed,
      runCommand("planning.finalize_submission", sealed.version, 4, 3));
    expect(admission.ok).toBe(false);
    if (admission.ok || !("unsupported" in admission)) throw new Error("expected UNSUPPORTED");
    expect(admission.reason).toBe("MULTI_NODE_EXECUTION_UNSUPPORTED");
    expect(admission.executionBearingNodeKeys)
      .toEqual(["node-0", "node-1", "node-2", "node-3"]);
    expect(JSON.stringify(sealed)).toBe(before);
    const refused = reducePlanningRun(sealed,
      runCommand("planning.finalize_submission", sealed.version, 4, 4));
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

  it("freezes an active revision against every further command", () => {
    const approved = approvedRevision();
    const active = reduceGraphRevision(approved,
      revisionCommand("graph.approve", approved.version, 1));
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    expect(active.state.lifecycle).toBe("ACTIVE");
    const before = JSON.stringify(active.state);
    for (const kind of GRAPH_REVISION_COMMAND_KINDS) {
      const result = reduceGraphRevision(active.state,
        revisionCommand(kind, active.state.version, 1));
      expect(result.ok).toBe(false);
      expect(JSON.stringify(active.state)).toBe(before);
    }
  });
});
