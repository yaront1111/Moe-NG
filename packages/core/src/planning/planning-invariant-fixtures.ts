/**
 * Deterministic fixtures for the planning aggregate invariant properties: seeded hashes, witness
 * constants, lifecycle rank/terminal tables, the xorshift32 generator, digest perturbation, and
 * the deep-freeze assertion. Test-only infrastructure — the root vitest include collects
 * `*.test.ts` alone, so this module never registers a suite itself.
 */
import { expect } from "vitest";

import type { GraphRevisionLifecycle } from "./graph-revision-contract.js";
import type { PlanningRunLifecycle } from "./planning-contract.js";

function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

export const PLAN_HASH = hash("11");
export const GRAPH_HASH = hash("22");
const QUALITY_HASH = hash("33");
const DEPENDENCY_HASH = hash("44");
export const BUDGET_HASH = hash("55");
const POLICY_HASH = hash("66");
export const SUBMISSION_HASH = hash("77");

export const HASHES = { dependencyHash: DEPENDENCY_HASH, graphContentHash: GRAPH_HASH,
  planHash: PLAN_HASH, qualityHash: QUALITY_HASH } as const;
export const BINDING = { budgetHash: BUDGET_HASH, expectedGoalVersion: 3, graphHash: GRAPH_HASH,
  policyHash: POLICY_HASH, qualityHash: QUALITY_HASH } as const;
export const PLAN_APPROVAL = { ...HASHES, approvalRef: "plan-approval-1",
  truthClass: "HUMAN_APPROVED" } as const;
export const RUN_ACTIVATION = { activationRef: "activation-1", budgetHash: BUDGET_HASH,
  expectedGoalVersion: 3, goalDraftNoActiveRevision: true, graphHash: GRAPH_HASH,
  policyHash: POLICY_HASH, qualityHash: QUALITY_HASH, truthClass: "HUMAN_APPROVED" } as const;
export const REVISION_ACTIVATION = { ...BINDING, activationRef: "activation-1",
  truthClass: "HUMAN_APPROVED" } as const;

/** Terminal lifecycles must absorb every later command; ranks must never decrease. */
export const RUN_RANK: Readonly<Record<PlanningRunLifecycle, number>> = {
  DRAFT: 0, READY: 1, PLANNING: 2, SUBMISSION_DRAINING: 3, PLAN_REVIEW: 4, APPROVED: 5,
  ACTIVATED: 6, REJECTED: 7, CANCELLED: 7,
};
export const RUN_TERMINAL: ReadonlySet<string> = new Set(["ACTIVATED", "REJECTED", "CANCELLED"]);
export const RUN_APPROVAL_STATES: ReadonlySet<string> = new Set(["PLAN_REVIEW", "APPROVED", "ACTIVATED"]);
export const REVISION_RANK: Readonly<Record<GraphRevisionLifecycle, number>> = {
  DRAFT: 0, PENDING_APPROVAL: 1, APPROVED: 2, ACTIVE: 3, SUPERSEDED: 4, REJECTED: 5,
};
/** `ACTIVE` is no longer terminal: `graph.supersede` moves authority forward out of it. */
export const REVISION_TERMINAL: ReadonlySet<string> = new Set(["SUPERSEDED", "REJECTED"]);

export function xorshift32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return value >>> 0;
  };
}

export function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
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
export function perturb(value: string, index: number): string {
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

export function finalizeWitness(bearing: number): Record<string, unknown> {
  return { attemptTerminalRef: "attempt-terminal", effectTerminalRef: "effect-terminal",
    nodeSummaries: summaries(bearing), providerSlotTerminalRef: "slot-released",
    resourcesTerminalRef: "resources-terminal", truthClass: "DAEMON_VERIFIED" };
}
