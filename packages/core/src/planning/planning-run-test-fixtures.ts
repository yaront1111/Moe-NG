/**
 * Shared planning-run reducer test fixtures.
 *
 * Mirrors the scheduler package's own test-fixtures module: it lives under
 * `src/` so `tsc` typechecks it, but `vitest.config.ts` only collects
 * `*.test.ts`, so it registers no suite. Every binding is a `const` or a
 * factory that returns a fresh object, so importing it from more than one test
 * file cannot create shared mutable state. It exports no production API.
 */
import { expect } from "vitest";

import type {
  PlanRevisionHashes,
  PlanningRunCommand,
  PlanningRunCommandKind,
  PlanningRunLifecycle,
  PlanningRunReducerResult,
  PlanningRunState,
} from "./planning-contract.js";

export function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

const PLAN_HASH = hash("11");
const GRAPH_HASH = hash("22");
const QUALITY_HASH = hash("33");
const DEPENDENCY_HASH = hash("44");
const BUDGET_HASH = hash("55");
const POLICY_HASH = hash("66");
export const SUBMISSION_HASH = hash("77");

export const HASHES: PlanRevisionHashes = {
  dependencyHash: DEPENDENCY_HASH, graphContentHash: GRAPH_HASH,
  planHash: PLAN_HASH, qualityHash: QUALITY_HASH,
};
export const READINESS = { acceptanceCriteriaRef: "criteria-1", intentBaseRef: "intent-1",
  planningBudgetRef: "budget-1", truthClass: "DAEMON_VERIFIED" } as const;
const CLAIM = { attemptRef: "attempt-1", contextRef: "context-1", leaseRef: "lease-1",
  providerSlotRef: "slot-1", truthClass: "DAEMON_VERIFIED" } as const;
export const RESUME = { handoffKind: "SAFE_RELEASE_HANDOFF", handoffRef: "handoff-1",
  priorAttemptTerminalRef: "attempt-0-terminal", truthClass: "DAEMON_VERIFIED" } as const;
const RELEASE = { attemptTerminalRef: "attempt-1-released", handoffRef: "handoff-1",
  truthClass: "DAEMON_VERIFIED" } as const;
export const RECOVERY = { effectsAbsentRef: "effects-absent-1", leaseFencedRef: "lease-fenced-1",
  missingInMemoryState: "UNKNOWN", priorAttemptTerminalRef: "attempt-1-terminal",
  recoverySealRef: "no-handoff-recovery-1", resourcesAbsentRef: "resources-absent-1",
  truthClass: "DAEMON_VERIFIED" } as const;
const SUBMISSION = { attemptRef: "attempt-1", submissionRef: "submission-1",
  truthClass: "DAEMON_VERIFIED" } as const;
export const EFFECT_TERMINAL = { effectTerminalRef: "effect-terminal-1",
  resourcesTerminalRef: "resources-terminal-1", truthClass: "DAEMON_VERIFIED" } as const;
export const REVISION_SEAL = { ...HASHES, graphRevisionRef: "graph-revision-1" } as const;
export const REFUSAL = { findingsRef: "findings-1", successorRunId: "planning-run-2",
  truthClass: "DAEMON_VERIFIED" } as const;
export const PLAN_APPROVAL = { ...HASHES, approvalRef: "plan-approval-1",
  truthClass: "HUMAN_APPROVED" } as const;
export const REVISE = { findingsRef: "findings-2", successorRunId: "planning-run-3",
  truthClass: "HUMAN_APPROVED" } as const;
export const ACTIVATION = { activationRef: "activation-1", budgetHash: BUDGET_HASH,
  expectedGoalVersion: 3, goalDraftNoActiveRevision: true, graphHash: GRAPH_HASH,
  policyHash: POLICY_HASH, qualityHash: QUALITY_HASH, truthClass: "HUMAN_APPROVED" } as const;
export const CANCELLATION = { authorizationRef: "cancel-1", noLiveOrUnknownEffect: true,
  truthClass: "HUMAN_APPROVED" } as const;

function summaries(bearing: number): readonly { executionBearing: boolean; nodeKey: string }[] {
  const items: { executionBearing: boolean; nodeKey: string }[] = [];
  for (let index = 0; index < bearing; index += 1) {
    items.push({ executionBearing: true, nodeKey: `node-${index}` });
  }
  items.push({ executionBearing: false, nodeKey: "review-node" });
  return items;
}

export function finalizeWitness(bearing: number): Record<string, unknown> {
  return { attemptTerminalRef: "attempt-1-terminal", effectTerminalRef: "effect-terminal-1",
    nodeSummaries: summaries(bearing), providerSlotTerminalRef: "slot-1-released",
    resourcesTerminalRef: "resources-terminal-1", truthClass: "DAEMON_VERIFIED" };
}

const SEALED: readonly PlanningRunLifecycle[] = ["PLAN_REVIEW", "APPROVED", "ACTIVATED"];

export function state(
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

export function commandFor(kind: PlanningRunCommandKind, expectedVersion = 7): PlanningRunCommand {
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

/** The exact 11-key active hold binding the committed contract predicate admits. */
export const HOLD = {
  generation: 2, goalVersion: 3, graphEpoch: 4, holdId: "hold-1", lifecycle: "ACTIVE",
  parentNodeRef: "node-parent-1", parentRunRef: "planning-run-0", proposalBaseHash: hash("99"),
  sourceFingerprint: hash("aa"), truthClass: "DAEMON_VERIFIED",
  workerHandoff: { digest: hash("bb"), ref: "handoff-1" },
} as const;

/** Bound to the submission the shared `SUBMISSION` witness names, never a second free identity. */
export const IDENTITY = { proposalHash: SUBMISSION_HASH, proposalRef: "submission-1",
  truthClass: "DAEMON_VERIFIED" } as const;

/** One named variant per binding-layer refusal, so tests select rather than mutate inline. */
export const MALFORMED_HOLDS: Readonly<Record<string, Record<string, unknown>>> = {
  NON_ACTIVE_HOLD: { ...HOLD, lifecycle: "RELEASED" },
  STALE_PROPOSAL_BASE: { ...HOLD, proposalBaseHash: "not-a-proposal-base-hash" },
  WRONG_GRAPH_EPOCH: { ...HOLD, graphEpoch: -1 },
};

export function expansionCreate(
  overrides: Readonly<Record<string, unknown>> = {},
): PlanningRunCommand {
  return { commandId: "cmd-planning.create_draft", expansion: { ...HOLD }, expectedVersion: 0,
    goalRef: "goal-1", kind: "planning.create_draft", runId: "planning-run-1",
    runKind: "EXPANSION", ...overrides } as unknown as PlanningRunCommand;
}

export function expansionPropose(
  overrides: Readonly<Record<string, unknown>> = {},
): PlanningRunCommand {
  return { commandId: "cmd-plan.propose", expansion: { ...HOLD }, expectedVersion: 7,
    kind: "plan.propose", proposalKind: "EXPANSION", sealedProposal: { ...IDENTITY },
    submissionHash: SUBMISSION_HASH, witness: SUBMISSION,
    ...overrides } as unknown as PlanningRunCommand;
}

/** A child node and an integrator node, both execution-bearing, plus a non-bearing review node. */
export function expansionFinalizeWitness(): Record<string, unknown> {
  return { ...finalizeWitness(2), nodeSummaries: [
    { executionBearing: true, nodeKey: "child-1" },
    { executionBearing: true, nodeKey: "integrator-1" },
    { executionBearing: false, nodeKey: "review-node" }] };
}

export function expansionState(
  lifecycle: PlanningRunLifecycle,
  overrides: Readonly<Record<string, unknown>> = {},
): PlanningRunState {
  return { ...state(lifecycle), expansion: { ...HOLD }, runKind: "EXPANSION",
    sealedProposal: null, ...overrides } as unknown as PlanningRunState;
}

export function expectError(
  result: PlanningRunReducerResult,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): void {
  expect(result.ok).toBe(false);
  if (result.ok || "unsupported" in result) throw new Error(`expected ${code} rejection`);
  expect(result.error.code).toBe(code);
  if (details !== undefined) expect({ ...result.error.details }).toEqual(details);
}

export function expectIllegal(
  result: PlanningRunReducerResult,
  commandKind: PlanningRunCommandKind,
  sourceState: PlanningRunLifecycle,
): void {
  expectError(result, "ILLEGAL_TRANSITION", {
    aggregateKind: "PLANNING_RUN", commandKind, sourceState,
  });
}

export function accepted(result: PlanningRunReducerResult): PlanningRunState {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected accepted result");
  return result.state;
}
