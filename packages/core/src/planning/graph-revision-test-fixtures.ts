/**
 * Deterministic fixtures for the graph revision reducer tests: seeded hashes, witness constants,
 * state/command builders, and exact-error assertion helpers. Test-only infrastructure — the root
 * vitest include collects `*.test.ts` alone, so this module never registers a suite itself.
 */
import { expect } from "vitest";

import type { CarryForwardInput } from "../policy/approval-contract.js";
import type {
  SupersessionDisposition,
  SupersessionInput,
  SupersessionPredecessorBinding,
  SupersessionSuccessorBinding,
} from "../supersession/supersession-engine.js";
import type {
  GraphRevisionActivationWitness,
  GraphRevisionCommand,
  GraphRevisionCommandKind,
  GraphRevisionLifecycle,
  GraphRevisionReducerResult,
  GraphRevisionState,
  GraphRevisionSuccessionBinding,
} from "./graph-revision-contract.js";

export function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

export const GRAPH_HASH = hash("22");
export const PLAN_HASH = hash("11");
export const QUALITY_HASH = hash("33");
export const BUDGET_HASH = hash("55");
export const POLICY_HASH = hash("66");
export const STALE_HASH = hash("99");

export const BINDING = { budgetHash: BUDGET_HASH, expectedGoalVersion: 3, graphHash: GRAPH_HASH,
  policyHash: POLICY_HASH, qualityHash: QUALITY_HASH } as const;
export const SUBMISSION = { submissionRef: "submission-1", truthClass: "DAEMON_VERIFIED" } as const;
export const APPROVAL = { ...BINDING, approvalRef: "approval-1",
  truthClass: "HUMAN_APPROVED" } as const;
/** Epoch 1 is exactly what an initial activation requires, and what the reducer used to hardcode. */
export const ACTIVATION = { ...BINDING, activationRef: "activation-1", graphEpoch: 1,
  truthClass: "HUMAN_APPROVED" } as const;
export const REJECTION = { findingsRef: "findings-1", truthClass: "DAEMON_VERIFIED" } as const;

export const SUCCESSOR_HASH = hash("88");
export const CARRY_HASH = hash("44");
export const BINDING_HASH = hash("66");
export const CANONICALIZER = "canon-v1";

export const BOUND: readonly GraphRevisionLifecycle[] = ["APPROVED", "ACTIVE", "SUPERSEDED"];
/** An epoch is bound only once activation has happened; `APPROVED` is deliberately absent. */
export const EPOCH_BOUND: readonly GraphRevisionLifecycle[] = ["ACTIVE", "SUPERSEDED"];

export function state(
  lifecycle: GraphRevisionLifecycle,
  overrides: Partial<GraphRevisionState> = {},
): GraphRevisionState {
  return {
    boundHashes: BOUND.includes(lifecycle) ? { ...BINDING } : null,
    goalRef: "goal-1",
    graphContentHash: GRAPH_HASH,
    graphEpoch: EPOCH_BOUND.includes(lifecycle) ? 1 : 0,
    lifecycle,
    planHash: PLAN_HASH,
    revisionId: "graph-revision-1",
    submissionRef: lifecycle === "DRAFT" ? null : "submission-1",
    version: 7,
    ...overrides,
  };
}

export function carryFact(digest: string): CarryForwardInput {
  return {
    canonicalizerVersion: CANONICALIZER, dependenciesPresent: true,
    environmentClosureUnchanged: true, policySliceUnchanged: true,
    predecessorResultUnchanged: true, sourceHash: digest, targetHash: digest,
  };
}

export const CARRY: SupersessionDisposition = {
  kind: "CARRY", nodeKey: "node-carry", predecessorAuthorityHash: CARRY_HASH,
  safeCarry: { authority: carryFact(CARRY_HASH), inputBinding: carryFact(BINDING_HASH) },
  successorAuthorityHash: CARRY_HASH,
};

export function predecessorOf(current: GraphRevisionState): SupersessionPredecessorBinding {
  return {
    graphContentHash: current.graphContentHash, graphEpoch: current.graphEpoch,
    revisionId: current.revisionId,
  };
}

/** Well-formed by construction; every refusal fixture below is one deliberate drift from it. */
export function supersessionInput(
  current: GraphRevisionState,
  overrides: Partial<SupersessionInput> = {},
): SupersessionInput {
  const predecessor = predecessorOf(current);
  return {
    dispositions: [CARRY],
    expectedPredecessor: predecessor,
    successor: {
      graphContentHash: SUCCESSOR_HASH, graphEpoch: predecessor.graphEpoch + 1,
      predecessorGraphContentHash: predecessor.graphContentHash,
      predecessorRevisionId: predecessor.revisionId, revisionId: "graph-revision-2",
    },
    supportedCanonicalizerVersions: [CANONICALIZER],
    ...overrides,
  };
}

/** The predecessor epoch the command expects has already moved on. */
export function staleEpochInput(current: GraphRevisionState): SupersessionInput {
  return supersessionInput(current, {
    expectedPredecessor: { ...predecessorOf(current), graphEpoch: current.graphEpoch + 1 },
  });
}

/** Carry authority no longer hashes to the disposition it claims to carry forward. */
export function changedCarryInput(current: GraphRevisionState): SupersessionInput {
  return supersessionInput(current, {
    dispositions: [{ ...CARRY, safeCarry: {
      authority: carryFact(STALE_HASH), inputBinding: carryFact(BINDING_HASH) } }],
  });
}

export function supersedeCommand(
  current: GraphRevisionState,
  supersession: SupersessionInput = supersessionInput(current),
): GraphRevisionCommand {
  return {
    commandId: "cmd-supersede", expectedVersion: current.version,
    kind: "graph.supersede", supersession,
  };
}

export const SUCCESSOR_BINDING = { ...BINDING, graphHash: SUCCESSOR_HASH } as const;
export const SUCCESSOR_APPROVAL = { ...SUCCESSOR_BINDING, approvalRef: "approval-2",
  truthClass: "HUMAN_APPROVED" } as const;

/** The predecessor a kernel-emitted successor binding names, plus the epoch that predecessor held. */
export function successionOf(
  successor: SupersessionSuccessorBinding,
  predecessorGraphEpoch: number,
): GraphRevisionSuccessionBinding {
  return {
    predecessorGraphContentHash: successor.predecessorGraphContentHash, predecessorGraphEpoch,
    predecessorRevisionId: successor.predecessorRevisionId,
  };
}

/** Derived from the kernel's own successor binding, so every refusal fixture is one field's drift. */
export function successorActivation(
  successor: SupersessionSuccessorBinding,
  predecessorGraphEpoch: number,
  overrides: Partial<GraphRevisionActivationWitness> = {},
): GraphRevisionActivationWitness {
  return {
    ...SUCCESSOR_BINDING, activationRef: "activation-2", graphEpoch: successor.graphEpoch,
    graphHash: successor.graphContentHash,
    succession: successionOf(successor, predecessorGraphEpoch),
    truthClass: "HUMAN_APPROVED", ...overrides,
  };
}

export function commandFor(
  kind: GraphRevisionCommandKind,
  expectedVersion = 7,
): GraphRevisionCommand {
  const base = { commandId: `cmd-${kind}`, expectedVersion };
  switch (kind) {
    case "graph_revision.create":
      return { ...base, goalRef: "goal-1", graphContentHash: GRAPH_HASH, kind,
        planHash: PLAN_HASH, revisionId: "graph-revision-1" };
    case "graph_revision.submit": return { ...base, kind, witness: SUBMISSION };
    case "graph.approve": return { ...base, approval: APPROVAL, kind };
    case "graph_revision.reject": return { ...base, kind, witness: REJECTION };
    case "graph.supersede":
      return { ...base, kind, supersession: supersessionInput(state("ACTIVE")) };
  }
}

export function expectError(
  result: GraphRevisionReducerResult,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`expected ${code} rejection`);
  expect(result.error.code).toBe(code);
  expect(result.layer).toBe("GRAPH_REVISION");
  if (details !== undefined) expect({ ...result.error.details }).toEqual(details);
}

export function expectIllegal(
  result: GraphRevisionReducerResult,
  commandKind: GraphRevisionCommandKind,
  sourceState: GraphRevisionLifecycle,
): void {
  expectError(result, "ILLEGAL_TRANSITION", {
    aggregateKind: "GRAPH_REVISION", commandKind, sourceState,
  });
}

export function accepted(result: GraphRevisionReducerResult): GraphRevisionState {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected accepted result");
  return result.state;
}
