/**
 * Deterministic fixtures for the graph revision reducer tests: seeded hashes, witness constants,
 * state/command builders, and exact-error assertion helpers. Test-only infrastructure — the root
 * vitest include collects `*.test.ts` alone, so this module never registers a suite itself.
 */
import { expect } from "vitest";

import type {
  GraphRevisionCommand,
  GraphRevisionCommandKind,
  GraphRevisionLifecycle,
  GraphRevisionReducerResult,
  GraphRevisionState,
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
export const ACTIVATION = { ...BINDING, activationRef: "activation-1",
  truthClass: "HUMAN_APPROVED" } as const;
export const REJECTION = { findingsRef: "findings-1", truthClass: "DAEMON_VERIFIED" } as const;

export const BOUND: readonly GraphRevisionLifecycle[] = ["APPROVED", "ACTIVE", "SUPERSEDED"];

export function state(
  lifecycle: GraphRevisionLifecycle,
  overrides: Partial<GraphRevisionState> = {},
): GraphRevisionState {
  return {
    boundHashes: BOUND.includes(lifecycle) ? { ...BINDING } : null,
    goalRef: "goal-1",
    graphContentHash: GRAPH_HASH,
    lifecycle,
    planHash: PLAN_HASH,
    revisionId: "graph-revision-1",
    submissionRef: lifecycle === "DRAFT" ? null : "submission-1",
    version: 7,
    ...overrides,
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
    case "graph.supersede": return { ...base, kind, witness: REJECTION };
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
