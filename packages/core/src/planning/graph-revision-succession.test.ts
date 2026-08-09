/**
 * Successor activation at predecessor epoch + 1. These tests drive the PRODUCTION reducer end to
 * end — supersede a live revision, take the successor binding off the emitted
 * `GraphRevisionSuperseded` event, then create, submit and activate that successor — and assert the
 * successor's DURABLE `state.graphEpoch`. Asserting the emitted binding instead would pass against
 * unmodified production, because the kernel already emits epoch + 1; only the persisted state
 * distinguishes a bound epoch from the hardcoded literal it replaces.
 */
import { describe, expect, it } from "vitest";

import type { SupersessionSuccessorBinding } from "../supersession/supersession-engine.js";
import type {
  GraphRevisionActivationWitness,
  GraphRevisionCommand,
  GraphRevisionReducerResult,
  GraphRevisionState,
} from "./graph-revision-contract.js";
import { reduceGraphRevision } from "./graph-revision-reducer.js";
import {
  ACTIVATION,
  PLAN_HASH,
  SUBMISSION,
  SUCCESSOR_APPROVAL,
  accepted,
  expectError,
  expectIllegal,
  state,
  successionOf,
  successorActivation,
  supersedeCommand,
} from "./graph-revision-test-fixtures.js";

interface Chain {
  readonly pending: GraphRevisionState;
  readonly predecessorEpoch: number;
  readonly successor: SupersessionSuccessorBinding;
}

/** Supersedes a live revision and returns the kernel-emitted successor binding, never a hand-built one. */
function supersede(source: GraphRevisionState): {
  readonly predecessor: GraphRevisionState;
  readonly successor: SupersessionSuccessorBinding;
} {
  const result = reduceGraphRevision(source, supersedeCommand(source));
  const predecessor = accepted(result);
  if (!result.ok) throw new Error("expected an accepted supersede");
  const [event] = result.events;
  if (event === undefined || event.kind !== "GraphRevisionSuperseded") {
    throw new Error("expected a GraphRevisionSuperseded event");
  }
  return { predecessor, successor: event.successor };
}

/** Builds the successor revision through production create + submit, never as a state literal. */
function draftSuccessor(successor: SupersessionSuccessorBinding): GraphRevisionState {
  const created = accepted(reduceGraphRevision(undefined, {
    commandId: "cmd-create-successor", expectedVersion: 0, goalRef: "goal-1",
    graphContentHash: successor.graphContentHash, kind: "graph_revision.create",
    planHash: PLAN_HASH, revisionId: successor.revisionId,
  }));
  return accepted(reduceGraphRevision(created, {
    commandId: "cmd-submit-successor", expectedVersion: created.version,
    kind: "graph_revision.submit", witness: SUBMISSION,
  }));
}

function chain(): Chain {
  const { predecessor, successor } = supersede(state("ACTIVE"));
  return { pending: draftSuccessor(successor), predecessorEpoch: predecessor.graphEpoch, successor };
}

function activate(
  current: GraphRevisionState,
  activation: GraphRevisionActivationWitness,
): GraphRevisionReducerResult {
  return reduceGraphRevision(current, {
    activation, approval: SUCCESSOR_APPROVAL, commandId: "cmd-activate-successor",
    expectedVersion: current.version, kind: "graph.approve",
  });
}

/** Every refusal must leave the input state byte-identical. */
function refusedActivation(
  current: GraphRevisionState,
  activation: GraphRevisionActivationWitness,
): GraphRevisionReducerResult {
  const before = JSON.stringify(current);
  const result = activate(current, activation);
  expect(JSON.stringify(current)).toBe(before);
  return result;
}

describe("successor graph activation", () => {
  it("activates a superseded chain's successor at exactly predecessor epoch plus one", () => {
    const { pending, predecessorEpoch, successor } = chain();
    expect(predecessorEpoch).toBe(1);
    expect(successor.graphEpoch).toBe(predecessorEpoch + 1);
    const witness = successorActivation(successor, predecessorEpoch);
    const result = activate(pending, witness);
    const next = accepted(result);
    expect(next.graphEpoch).toBe(predecessorEpoch + 1);
    expect(next.graphEpoch).toBe(2);
    expect(next).toMatchObject({ graphContentHash: successor.graphContentHash,
      lifecycle: "ACTIVE", revisionId: successor.revisionId });
    expect(result.ok && result.events.map((event) => event.kind))
      .toEqual(["GraphRevisionApproved", "GraphRevisionActivated"]);
    const [, activated] = result.ok ? result.events : [];
    expect(activated?.kind === "GraphRevisionActivated" && activated.witness).toEqual(witness);
  });

  /**
   * From APPROVED the command must carry NO approval: the reducer refuses a re-approval before it
   * ever reads the activation, so an approval-bearing command would pass this test for the wrong
   * reason — refused by a different guard than the one under test.
   */
  it("keeps an initial activation at exactly epoch one and refuses every other epoch", () => {
    const source = state("APPROVED");
    const initial = (activation: GraphRevisionActivationWitness): GraphRevisionCommand => ({
      activation, commandId: "cmd-activate", expectedVersion: source.version,
      kind: "graph.approve",
    });
    expect(accepted(reduceGraphRevision(source, initial(ACTIVATION))).graphEpoch).toBe(1);
    let cases = 0;
    for (const graphEpoch of [0, 2, 3, -1]) {
      const before = JSON.stringify(source);
      const drifted = reduceGraphRevision(source, initial({ ...ACTIVATION, graphEpoch }));
      expect(JSON.stringify(source)).toBe(before);
      expectIllegal(drifted, "graph.approve", "APPROVED");
      cases += 1;
    }
    expect(cases).toBe(4);
  });

  it("refuses a successor epoch that is not exactly the named predecessor's epoch plus one", () => {
    const { pending, predecessorEpoch, successor } = chain();
    let cases = 0;
    for (const delta of [0, 2, -1]) {
      const drifted = refusedActivation(pending,
        successorActivation(successor, predecessorEpoch, { graphEpoch: predecessorEpoch + delta }));
      expectIllegal(drifted, "graph.approve", "PENDING_APPROVAL");
      cases += 1;
    }
    expect(cases).toBe(3);
  });

  it("refuses a succession binding whose predecessor epoch is itself unverifiable", () => {
    const { pending, predecessorEpoch, successor } = chain();
    const bindings = [
      successionOf(successor, 0), successionOf(successor, -1), successionOf(successor, 1.5),
      { ...successionOf(successor, predecessorEpoch), predecessorGraphContentHash: "nothex" },
      { ...successionOf(successor, predecessorEpoch), predecessorRevisionId: "" },
    ];
    expect(bindings).toHaveLength(5);
    for (const succession of bindings) {
      const witness = successorActivation(successor, predecessorEpoch, { succession });
      expectIllegal(refusedActivation(pending, witness), "graph.approve", "PENDING_APPROVAL");
    }
  });

  it("rebounds a succession binding naming this very revision as its own predecessor", () => {
    const { pending, predecessorEpoch, successor } = chain();
    const witness = successorActivation(successor, predecessorEpoch, {
      succession: { ...successionOf(successor, predecessorEpoch),
        predecessorRevisionId: successor.revisionId },
    });
    expectError(refusedActivation(pending, witness), "REVISION_REBOUND");
    expect(accepted(activate(pending, successorActivation(successor, predecessorEpoch)))
      .graphEpoch).toBe(predecessorEpoch + 1);
  });

  it("refuses a missing or non-integer activation epoch instead of defaulting it", () => {
    const { pending, predecessorEpoch, successor } = chain();
    const witness = successorActivation(successor, predecessorEpoch);
    const { graphEpoch: _omitted, ...withoutEpoch } = witness;
    let cases = 0;
    for (const malformed of [withoutEpoch, { ...witness, graphEpoch: 2.5 },
      { ...witness, graphEpoch: Number.NaN }, { ...witness, graphEpoch: "2" }]) {
      const drifted = refusedActivation(pending, malformed as GraphRevisionActivationWitness);
      expectIllegal(drifted, "graph.approve", "PENDING_APPROVAL");
      cases += 1;
    }
    expect(cases).toBe(4);
  });
});
