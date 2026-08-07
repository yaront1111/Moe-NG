/**
 * Seeded command builders, random-walk traces, and valid-state drivers for the planning aggregate
 * invariant properties. Test-only infrastructure — the root vitest include collects `*.test.ts`
 * alone, so this module never registers a suite itself.
 */
import { expect } from "vitest";

import type {
  GraphRevisionCommand, GraphRevisionCommandKind, GraphRevisionState,
} from "./graph-revision-contract.js";
import { GRAPH_REVISION_COMMAND_KINDS, reduceGraphRevision } from "./graph-revision-reducer.js";
import type {
  PlanningRunCommand, PlanningRunCommandKind, PlanningRunLifecycle, PlanningRunState,
} from "./planning-contract.js";
import {
  BINDING, expectDeepFrozen, finalizeWitness, GRAPH_HASH, HASHES, PLAN_APPROVAL, PLAN_HASH,
  REVISION_ACTIVATION, REVISION_RANK, REVISION_TERMINAL, RUN_ACTIVATION, RUN_APPROVAL_STATES,
  RUN_RANK, RUN_TERMINAL, SUBMISSION_HASH, xorshift32,
} from "./planning-invariant-fixtures.js";
import {
  PLANNING_RUN_COMMAND_KINDS, PLANNING_RUN_TRANSITIONS, reducePlanningRun,
} from "./planning-run-reducer.js";

export function runCommand(
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

export function runTrace(seed: number, bearing: number): readonly unknown[] {
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

export function revisionCommand(
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

export function revisionTrace(seed: number): readonly unknown[] {
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

export const SEEDS = [1, 7, 0x12345678, 0xdeadbeef, 0x0badf00d] as const;

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

export function sealedRun(): PlanningRunState {
  const current = driveRun(SEALED_STEPS, "PLANNING");
  expect(current.submissionHash).toBe(SUBMISSION_HASH);
  return current;
}

export function planReviewRun(): PlanningRunState {
  return driveRun(REVIEW_STEPS, "PLAN_REVIEW");
}

export function approvedRevision(): GraphRevisionState {
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
