/**
 * Shared drivers for the graph revision replay suites.
 *
 * EVERY legal history these suites use is GENERATED here by driving the real `reduceGraphRevision`
 * production function and collecting the events it actually emitted — never hand-written. A
 * hand-written pair of operands would let replay and expectation drift together and still pass,
 * which is exactly the tautology this aggregate cannot afford: replay exists to rebuild authority,
 * so its only meaningful oracle is the command reducer that owns the lifecycle. Refusal fixtures
 * are therefore built as ONE deliberate drift from a generated history, never authored whole.
 *
 * Test-only infrastructure: the root vitest include collects `*.test.ts` alone, so this module
 * registers no suite, and it is unreachable from `index.ts` so it takes no `.js` bridge.
 */
import { expect } from "vitest";

import type {
  GraphRevisionCommand, GraphRevisionEvent, GraphRevisionState,
} from "./graph-revision-contract.js";
import {
  CORE_GRAPH_REVISION_REPLAY, GRAPH_REVISION_REPLAY_CODES, replayGraphRevisionEvents,
} from "./graph-revision-replay.js";
import { reduceGraphRevision } from "./graph-revision-reducer.js";
import {
  ACTIVATION, APPROVAL, GRAPH_HASH, PLAN_HASH, REJECTION, SUBMISSION, SUCCESSOR_APPROVAL,
  SUCCESSOR_HASH, successorActivation, supersessionInput,
} from "./graph-revision-test-fixtures.js";

export type Step = (current: GraphRevisionState | undefined) => GraphRevisionCommand;

export interface Driven {
  readonly events: readonly GraphRevisionEvent[];
  readonly state: GraphRevisionState;
}

function versionOf(current: GraphRevisionState | undefined): number {
  return current === undefined ? 0 : current.version;
}

/**
 * Runs a path through the REAL reducer. A rejected fixture command throws rather than silently
 * yielding a short history — a path that stopped early would still replay cleanly and prove
 * nothing about the lifecycle it claims to cover.
 */
export function drive(steps: readonly Step[]): Driven {
  let current: GraphRevisionState | undefined;
  const events: GraphRevisionEvent[] = [];
  for (const step of steps) {
    const command = step(current);
    const result = reduceGraphRevision(current, command);
    if (!result.ok) {
      throw new Error(`fixture command ${command.kind} rejected: ${result.error.code}`);
    }
    current = result.state;
    events.push(...result.events);
  }
  if (current === undefined) throw new Error("path produced no state");
  return { events, state: current };
}

export const create: Step = () => ({
  commandId: "cmd-create", expectedVersion: 0, goalRef: "goal-1",
  graphContentHash: GRAPH_HASH, kind: "graph_revision.create", planHash: PLAN_HASH,
  revisionId: "graph-revision-1",
});
export const submit: Step = (current) => ({
  commandId: "cmd-submit", expectedVersion: versionOf(current), kind: "graph_revision.submit",
  witness: SUBMISSION,
});
export const approve: Step = (current) => ({
  approval: APPROVAL, commandId: "cmd-approve", expectedVersion: versionOf(current),
  kind: "graph.approve",
});
export const approveAndActivate: Step = (current) => ({
  activation: ACTIVATION, approval: APPROVAL, commandId: "cmd-approve",
  expectedVersion: versionOf(current), kind: "graph.approve",
});
export const activate: Step = (current) => ({
  activation: ACTIVATION, commandId: "cmd-activate", expectedVersion: versionOf(current),
  kind: "graph.approve",
});
export const reject: Step = (current) => ({
  commandId: "cmd-reject", expectedVersion: versionOf(current), kind: "graph_revision.reject",
  witness: REJECTION,
});
export const supersede: Step = (current) => {
  if (current === undefined) throw new Error("supersede needs a live state");
  return {
    commandId: "cmd-supersede", expectedVersion: current.version, kind: "graph.supersede",
    supersession: supersessionInput(current),
  };
};

/** A second revision activated as the named successor, so the succession epoch path is covered. */
export const SUCCESSOR = Object.freeze({
  graphContentHash: SUCCESSOR_HASH, graphEpoch: 2, predecessorGraphContentHash: GRAPH_HASH,
  predecessorRevisionId: "graph-revision-1", revisionId: "graph-revision-2",
});
export const createSuccessor: Step = () => ({
  commandId: "cmd-create-2", expectedVersion: 0, goalRef: "goal-1",
  graphContentHash: SUCCESSOR_HASH, kind: "graph_revision.create", planHash: PLAN_HASH,
  revisionId: "graph-revision-2",
});
export const approveAndActivateSuccessor: Step = (current) => ({
  activation: successorActivation(SUCCESSOR, 1), approval: SUCCESSOR_APPROVAL,
  commandId: "cmd-approve-2", expectedVersion: versionOf(current), kind: "graph.approve",
});

export const LEGAL_PATHS:
  readonly (readonly [string, readonly Step[], GraphRevisionState["lifecycle"]])[] = [
    ["DRAFT from create", [create], "DRAFT"],
    ["PENDING_APPROVAL from submit", [create, submit], "PENDING_APPROVAL"],
    ["APPROVED from approval alone", [create, submit, approve], "APPROVED"],
    ["ACTIVE compound from PENDING_APPROVAL", [create, submit, approveAndActivate], "ACTIVE"],
    ["ACTIVE from APPROVED", [create, submit, approve, activate], "ACTIVE"],
    ["REJECTED from DRAFT", [create, reject], "REJECTED"],
    ["REJECTED from PENDING_APPROVAL", [create, submit, reject], "REJECTED"],
    ["REJECTED from APPROVED", [create, submit, approve, reject], "REJECTED"],
    ["SUPERSEDED after compound activation", [create, submit, approveAndActivate, supersede],
      "SUPERSEDED"],
    ["SUPERSEDED after separate activation", [create, submit, approve, activate, supersede],
      "SUPERSEDED"],
    ["ACTIVE as a named successor", [createSuccessor, submit, approveAndActivateSuccessor],
      "ACTIVE"],
  ];

export function replayed(history: unknown): Driven {
  const result = replayGraphRevisionEvents(history);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected accepted replay, got ${result.code}`);
  return { events: result.events, state: result.state };
}

export function expectRefusal(history: unknown, code: string): void {
  const result = replayGraphRevisionEvents(history);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`expected ${code}, got an accepted replay`);
  // Code and layer together: a sibling layer answering first must not read as this refusal.
  expect(`${result.layer}/${result.code}`).toBe(`${CORE_GRAPH_REVISION_REPLAY}/${code}`);
  expect(GRAPH_REVISION_REPLAY_CODES).toContain(result.code);
}

export function historyOf(steps: readonly Step[]): GraphRevisionEvent[] {
  return [...drive(steps).events];
}

/** One deliberate drift from a generated history: the last event's top-level facts. */
export function mutatedLast(
  steps: readonly Step[],
  patch: Readonly<Record<string, unknown>>,
): GraphRevisionEvent[] {
  const events = historyOf(steps);
  const last = events[events.length - 1];
  if (last === undefined) throw new Error("no event to mutate");
  events[events.length - 1] = { ...last, ...patch } as GraphRevisionEvent;
  return events;
}

/** Drifts one field of the kernel-emitted successor binding, leaving the rest generated. */
export function supersededWithSuccessor(
  patch: Readonly<Record<string, unknown>>,
): GraphRevisionEvent[] {
  const events = historyOf([create, submit, approveAndActivate, supersede]);
  const last = events[events.length - 1];
  if (last === undefined || last.kind !== "GraphRevisionSuperseded") {
    throw new Error("expected a superseded event");
  }
  return [...events.slice(0, -1),
    { ...last, successor: { ...last.successor, ...patch } } as GraphRevisionEvent];
}
