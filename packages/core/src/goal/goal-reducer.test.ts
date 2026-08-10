import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import { describe, expect, it } from "vitest";
import { GOAL_COMMAND_KINDS, reduceGoal } from "./goal-reducer.js";
import type {
  GoalCommand,
  GoalCommandKind,
  GoalLifecycle,
  GoalReducerResult,
  GoalSchedulingControl,
  GoalState,
} from "./goal-contract.js";
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) {
      freezeDeep((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeepFrozen((value as Record<PropertyKey, unknown>)[key]);
  }
}
function state(
  lifecycle: GoalLifecycle,
  schedulingControl: GoalSchedulingControl = "RUNNING",
  version = 7,
): GoalState {
  const active = lifecycle === "EXECUTION_ENABLED" || lifecycle === "CLOSING";
  return freezeDeep({
    activeGraphRevisionRef: active ? "graph-1" : null,
    budgetAccountRef: "budget-1",
    generation: 1,
    goalId: "goal-1",
    graphEpoch: lifecycle === "DRAFT" ? 0 : 1,
    lifecycle,
    planningRunRef: "planning-1",
    predecessorGoalRef: null,
    projectId: "project-1",
    recoveryFacets: { qualificationInvalidatedRef: null },
    schedulingControl,
    version,
  });
}
const PROJECT_READY = Object.freeze({
  projectReadyRef: "project-ready-1", truthClass: "DAEMON_VERIFIED" as const,
});
const ACTIVATION = Object.freeze({
  activeGraphRevisionRef: "graph-1", graphApprovalRef: "approval-1",
  truthClass: "DAEMON_VERIFIED" as const,
});
const CLOSURE = Object.freeze({
  acceptanceClosureRef: "closure-1", completionNodeAcceptedRef: "accepted-1",
  noCurrentPreparationGeneration: true as const, noPendingDraftOrSupersession: true as const,
  obligationsHoldRef: "obligations-1", truthClass: "DAEMON_VERIFIED" as const,
});
const ZERO_AUTHORITY = Object.freeze({
  truthClass: "DAEMON_VERIFIED" as const, zeroAuthorityProofRef: "zero-1",
});
function command(
  kind: GoalCommandKind,
  lifecycle: GoalLifecycle = "DRAFT",
  expectedVersion = 7,
): GoalCommand {
  const base = { commandId: `cmd-${kind}`, expectedVersion };
  switch (kind) {
    case "goal.create": return { ...base, budgetAccountRef: "budget-1", goalId: "goal-1",
      kind, planningRunRef: "planning-1", projectId: "project-1", witness: PROJECT_READY };
    case "goal.activate_initial_graph": return { ...base, kind, witness: ACTIVATION };
    case "goal.advance_graph_epoch": return { ...base, graphEpoch: 2, kind, predecessorGraphRevisionRef: "graph-1", successorGraphRevisionRef: "graph-2" };
    case "goal.close": return lifecycle === "CLOSING"
      ? { ...base, kind, zeroAuthorityWitness: ZERO_AUTHORITY }
      : { ...base, closureWitness: CLOSURE, kind };
    case "goal.qualification_invalidated": return { ...base, kind, witness: {
      proofInvalidatedRef: "invalidated-1", truthClass: "DAEMON_VERIFIED",
    } };
    case "goal.cancel": return { ...base, kind, witness: {
      authorizationRef: "cancel-1", subordinateAuthorityFenced: true,
      truthClass: "HUMAN_APPROVED",
    } };
    case "goal.reopen_as_revision": return { ...base, budgetAccountRef: "budget-2", kind,
      newGoalId: "goal-2", planningRunRef: "planning-2", witness: {
        authorizationRef: "reopen-1", truthClass: "HUMAN_APPROVED",
      } };
    case "goal.pause": return { ...base, kind, schedulingControl: "DRAIN_AND_PAUSE" };
    case "goal.resume": return { ...base, kind };
  }
}
function expectError(
  result: GoalReducerResult,
  code: "EXPECTED_VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "ILLEGAL_TRANSITION",
  details: Readonly<Record<string, string | number>>,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  expect(result.error.details).toEqual(details);
  expectDeepFrozen(result);
}
const ALLOWED = Object.freeze({
  DRAFT: new Set<GoalCommandKind>([
    "goal.activate_initial_graph", "goal.cancel", "goal.pause", "goal.resume",
  ]),
  EXECUTION_ENABLED: new Set<GoalCommandKind>([
    "goal.advance_graph_epoch", "goal.close", "goal.cancel", "goal.pause", "goal.resume",
  ]),
  CLOSING: new Set<GoalCommandKind>([
    "goal.close", "goal.qualification_invalidated", "goal.cancel",
  ]),
  COMPLETED: new Set<GoalCommandKind>(["goal.reopen_as_revision"]),
  CANCELLED: new Set<GoalCommandKind>(["goal.reopen_as_revision"]),
}) satisfies Readonly<Record<GoalLifecycle, ReadonlySet<GoalCommandKind>>>;
function nextLifecycle(source: GoalLifecycle, kind: GoalCommandKind): GoalLifecycle {
  if (kind === "goal.activate_initial_graph" || kind === "goal.qualification_invalidated") {
    return "EXECUTION_ENABLED";
  }
  if (kind === "goal.close") return source === "CLOSING" ? "COMPLETED" : "CLOSING";
  if (kind === "goal.cancel") return "CANCELLED";
  return source;
}
describe("goal lifecycle transition matrix", () => {
  it("covers every state and command kind with the exact authorized outcome", () => {
    const visited = new Set<string>();
    for (const lifecycle of RUNTIME_LIFECYCLES.GOAL) {
      for (const kind of GOAL_COMMAND_KINDS) {
        visited.add(`${lifecycle}:${kind}`);
        const current = state(lifecycle);
        const result = reduceGoal(current, command(kind, lifecycle));
        if (!ALLOWED[lifecycle].has(kind)) {
          expectError(result, "ILLEGAL_TRANSITION", {
            aggregateKind: "GOAL", commandKind: kind, sourceState: lifecycle,
          });
        } else {
          expect(result.ok).toBe(true);
          if (!result.ok) continue;
          expect(result.state.lifecycle).toBe(nextLifecycle(lifecycle, kind));
          expect(result.state.version).toBe(current.version + 1);
          expect(result.events.every((event) => event.commandId === command(kind).commandId)).toBe(true);
          expect(result.events.at(-1)?.version).toBe(result.state.version);
          expectDeepFrozen(result);
        }
      }
    }
    const expected = RUNTIME_LIFECYCLES.GOAL.flatMap((lifecycle) =>
      GOAL_COMMAND_KINDS.map((kind) => `${lifecycle}:${kind}`));
    expect([...visited].sort()).toEqual([...expected].sort());
  });
  it("creates DRAFT only from a READY-project witness", () => {
    const result = reduceGoal(undefined, command("goal.create", "DRAFT", 0));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toMatchObject({
      activeGraphRevisionRef: null, graphEpoch: 0, lifecycle: "DRAFT", version: 1,
    });
    expect(result.events[0]).toMatchObject({
      budgetAccountRef: "budget-1", kind: "GoalCreated", planningRunRef: "planning-1",
    });
    expectDeepFrozen(result);
  });
  it("supports atomic EXECUTION_ENABLED to CLOSING to COMPLETED", () => {
    const original = command("goal.close", "EXECUTION_ENABLED");
    if (original.kind !== "goal.close") throw new Error("unreachable command mismatch");
    const result = reduceGoal(state("EXECUTION_ENABLED"), {
      ...original, zeroAuthorityWitness: ZERO_AUTHORITY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.map((event) => event.kind)).toEqual(["GoalClosing", "GoalCompleted"]);
    expect(result.events.map((event) => event.version)).toEqual([8, 9]);
    expect(result.state).toMatchObject({
      activeGraphRevisionRef: null, lifecycle: "COMPLETED", version: 9,
    });
    expectDeepFrozen(result);
  });

  it("keeps scheduling orthogonal to lifecycle", () => {
    const paused = reduceGoal(state("DRAFT"), command("goal.pause"));
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    expect(paused.state).toMatchObject({ lifecycle: "DRAFT", schedulingControl: "DRAIN_AND_PAUSE" });
    const activated = reduceGoal(paused.state,
      command("goal.activate_initial_graph", "DRAFT", paused.state.version));
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(activated.state).toMatchObject({
      lifecycle: "EXECUTION_ENABLED", schedulingControl: "DRAIN_AND_PAUSE",
    });
  });

  it("returns a frozen successor while leaving a terminal goal unchanged", () => {
    const current = state("COMPLETED");
    const result = reduceGoal(current, command("goal.reopen_as_revision", "COMPLETED"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toEqual({ ...current, version: 8 });
    expect(result.state).not.toBe(current);
    expect(result.successor).toMatchObject({
      generation: 2, goalId: "goal-2", lifecycle: "DRAFT", predecessorGoalRef: "goal-1",
    });
    expectDeepFrozen(result);
  });
});

describe("goal reducer rejection boundaries", () => {
  it("rejects stale versions without state change", () => {
    const current = state("EXECUTION_ENABLED");
    const before = JSON.stringify(current);
    const result = reduceGoal(current, command("goal.close", current.lifecycle, 6));
    expectError(result, "EXPECTED_VERSION_CONFLICT", { actualVersion: 7, expectedVersion: 6 });
    expect(JSON.stringify(current)).toBe(before);
  });

  it("rejects empty command ids", () => {
    const candidate = { ...command("goal.pause"), commandId: "" };
    expectError(reduceGoal(state("DRAFT"), candidate), "IDEMPOTENCY_CONFLICT", {});
  });

  it("rejects low-truth and incomplete closure witnesses", () => {
    const original = command("goal.close", "EXECUTION_ENABLED");
    if (original.kind !== "goal.close" || original.closureWitness === undefined) {
      throw new Error("unreachable command mismatch");
    }
    for (const closureWitness of [
      { ...original.closureWitness, truthClass: "AGENT_REPORTED" as const },
      { ...original.closureWitness, noCurrentPreparationGeneration: false as const },
      { ...original.closureWitness, noPendingDraftOrSupersession: false as const },
    ]) {
      const candidate = { ...original, closureWitness } as unknown as GoalCommand;
      const result = reduceGoal(state("EXECUTION_ENABLED"), candidate);
      expectError(result, "ILLEGAL_TRANSITION", {
        aggregateKind: "GOAL", commandKind: original.kind, sourceState: "EXECUTION_ENABLED",
      });
    }
  });

  it("rejects missing and extra proof fields", () => {
    const activation = command("goal.activate_initial_graph");
    if (activation.kind !== "goal.activate_initial_graph") throw new Error("unreachable command mismatch");
    const extra = { ...activation, witness: {
      ...activation.witness, authorityGrant: "forbidden",
    } } as unknown as GoalCommand;
    expectError(reduceGoal(state("DRAFT"), extra), "ILLEGAL_TRANSITION", {
      aggregateKind: "GOAL", commandKind: activation.kind, sourceState: "DRAFT",
    });
    const missing = { ...command("goal.close", "CLOSING"),
      zeroAuthorityWitness: undefined } as unknown as GoalCommand;
    expectError(reduceGoal(state("CLOSING"), missing), "ILLEGAL_TRANSITION", {
      aggregateKind: "GOAL", commandKind: "goal.close", sourceState: "CLOSING",
    });
  });
});

function xorshift32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return value >>> 0;
  };
}

function trace(seed: number): readonly unknown[] {
  const next = xorshift32(seed);
  const entries: unknown[] = [];
  let current: GoalState | undefined;
  for (let index = 0; index < 80; index += 1) {
    const kind = GOAL_COMMAND_KINDS[next() % GOAL_COMMAND_KINDS.length];
    if (kind === undefined) throw new Error("goal command vocabulary is empty");
    const source = current?.lifecycle ?? "DRAFT";
    const actual = current?.version ?? 0;
    const expected = next() % 4 === 0 ? actual + 1 : actual;
    const before = current === undefined ? undefined : JSON.stringify(current);
    const result = reduceGoal(current, command(kind, source, expected));
    expectDeepFrozen(result);
    if (result.ok) {
      if (source === "CLOSING") {
        expect(["COMPLETED", "EXECUTION_ENABLED", "CANCELLED"]).toContain(result.state.lifecycle);
      }
      if (source === "COMPLETED" || source === "CANCELLED") {
        expect(result.state.lifecycle).toBe(source);
      }
      current = result.state;
      entries.push([kind, current.lifecycle, current.version]);
    } else {
      expect(current === undefined ? undefined : JSON.stringify(current)).toBe(before);
      entries.push([kind, result.error.code]);
    }
  }
  return entries;
}
describe("goal reducer properties", () => {
  it("is deterministic, deeply immutable, and terminal-absorbing", () => {
    for (const seed of [1, 7, 0x12345678, 0xdeadbeef]) {
      expect(trace(seed)).toEqual(trace(seed));
    }
  });
});
