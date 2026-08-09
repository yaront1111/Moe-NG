/**
 * EXPANSION admission on the authoritative PlanningRun aggregate. Every case drives
 * `reducePlanningRun` itself, and every shape claim is asserted against the committed contract
 * predicates in `planning-expansion-validation.ts` rather than a local reimplementation.
 */
import { describe, expect, it } from "vitest";

import type { PlanningRunCommand, PlanningRunState } from "./planning-contract.js";
import {
  snapshotPlanningRunContractState,
  validExpansionCreatedEvent,
  validExpansionSealedEvent,
} from "./planning-expansion-validation.js";
import { reducePlanningRun } from "./planning-run-reducer.js";
import {
  HOLD,
  IDENTITY,
  MALFORMED_HOLDS,
  REFUSAL,
  SUBMISSION_HASH,
  accepted,
  commandFor,
  expansionCreate,
  expansionFinalizeWitness,
  expansionPropose,
  expansionState,
  expectError,
  expectIllegal,
  finalizeWitness,
  hash,
  state,
} from "./planning-run-test-fixtures.js";

const UNSUPPORTED = { executionBearingNodeKeys: [], ok: false,
  reason: "PLANNING_KIND_UNSUPPORTED", unsupported: true };

const EXPANSION_STATE_KEYS = [
  "approvedHashes", "attemptRef", "expansion", "facets", "goalRef", "graphRevisionRef",
  "leaseRef", "lifecycle", "runId", "runKind", "sealedHashes", "sealedProposal",
  "submissionHash", "version",
];

/** Reads contract-only members without widening the reducer's declared result types. */
function fields(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function unchanged<T>(input: PlanningRunState, run: () => T): T {
  const before = JSON.stringify(input);
  const result = run();
  expect(JSON.stringify(input)).toBe(before);
  return result;
}

describe("planning run EXPANSION creation", () => {
  it("creates an EXPANSION draft bound to the active hold with nothing sealed", () => {
    const result = reducePlanningRun(undefined, expansionCreate());
    const next = accepted(result);
    expect(next).toEqual({ ...state("DRAFT", { version: 1 }), expansion: HOLD,
      runKind: "EXPANSION", sealedProposal: null });
    expect(result.ok && result.events.length).toBe(1);
    expect(result.ok && validExpansionCreatedEvent(result.events[0])).toBe(true);
  });

  it("adds exactly the hold binding and the empty seal, and no other authority", () => {
    const next = accepted(reducePlanningRun(undefined, expansionCreate()));
    expect(Object.keys(next).sort()).toEqual(EXPANSION_STATE_KEYS);
  });

  it("still refuses a REVISION draft with the exact typed UNSUPPORTED variant", () => {
    const result = reducePlanningRun(undefined,
      { ...commandFor("planning.create_draft", 0), runKind: "REVISION" } as PlanningRunCommand);
    expect(result).toEqual(UNSUPPORTED);
  });

  it("refuses every malformed hold binding on creation with UNKNOWN_ERROR", () => {
    const keys = Object.keys(MALFORMED_HOLDS);
    for (const key of keys) {
      expectError(reducePlanningRun(undefined,
        expansionCreate({ expansion: MALFORMED_HOLDS[key] })), "UNKNOWN_ERROR");
    }
    expect(keys.length).toBe(3);
  });

  it("refuses an EXPANSION draft that carries no hold binding at all", () => {
    expectError(reducePlanningRun(undefined, { commandId: "cmd-planning.create_draft",
      expectedVersion: 0, goalRef: "goal-1", kind: "planning.create_draft",
      runId: "planning-run-1", runKind: "EXPANSION" } as PlanningRunCommand), "UNKNOWN_ERROR");
  });
});

describe("planning run EXPANSION submission", () => {
  const owned = expansionState("PLANNING");

  it("seals one immutable proposal identity and emits the EXPANSION sealed event", () => {
    const result = reducePlanningRun(owned, expansionPropose());
    const next = accepted(result);
    expect(next.submissionHash).toBe(SUBMISSION_HASH);
    expect(fields(next)["sealedProposal"]).toEqual(IDENTITY);
    expect(Object.keys(next).sort()).toEqual(EXPANSION_STATE_KEYS);
    expect(result.ok && validExpansionSealedEvent(result.events[0])).toBe(true);
    expect(result.ok && fields(result.events[0])["proposalKind"]).toBe("EXPANSION");
  });

  it("replays an identical EXPANSION submission with no new event", () => {
    const sealed = expansionState("PLANNING",
      { sealedProposal: { ...IDENTITY }, submissionHash: SUBMISSION_HASH });
    const replay = reducePlanningRun(sealed, expansionPropose());
    expect(replay.ok && replay.events).toEqual([]);
    expect(accepted(replay)).toEqual(sealed);
    const other = expansionPropose({ sealedProposal: { ...IDENTITY, proposalHash: hash("88") },
      submissionHash: hash("88") });
    expectIllegal(reducePlanningRun(sealed, other), "plan.propose", "PLANNING");
  });

  it("refuses a proposal whose sealed identity does not bind the submission", () => {
    const result = unchanged(owned, () => reducePlanningRun(owned,
      expansionPropose({ sealedProposal: { ...IDENTITY, proposalHash: hash("88") } })));
    expectIllegal(result, "plan.propose", "PLANNING");
  });

  it("refuses a proposal whose sealed identity does not bind the submission witness", () => {
    expectIllegal(reducePlanningRun(owned,
      expansionPropose({ sealedProposal: { ...IDENTITY, proposalRef: "submission-9" } })),
    "plan.propose", "PLANNING");
  });

  it("refuses an EXPANSION proposal that swaps the run's bound hold", () => {
    const result = unchanged(owned, () => reducePlanningRun(owned,
      expansionPropose({ expansion: { ...HOLD, holdId: "hold-2" } })));
    expectIllegal(result, "plan.propose", "PLANNING");
  });

  it("refuses an EXPANSION proposal against a run that is not an EXPANSION run", () => {
    expectIllegal(reducePlanningRun(state("PLANNING"), expansionPropose()),
      "plan.propose", "PLANNING");
  });

  it("refuses a non-EXPANSION proposal against an EXPANSION run", () => {
    expectIllegal(reducePlanningRun(owned, commandFor("plan.propose")),
      "plan.propose", "PLANNING");
  });

  it("still refuses a REVISION proposal with the exact typed UNSUPPORTED variant", () => {
    expect(reducePlanningRun(state("PLANNING"),
      { ...commandFor("plan.propose"), proposalKind: "REVISION" } as PlanningRunCommand))
      .toEqual(UNSUPPORTED);
  });

  it("refuses every malformed hold binding on the proposal path", () => {
    const keys = Object.keys(MALFORMED_HOLDS);
    for (const key of keys) {
      expectIllegal(reducePlanningRun(owned,
        expansionPropose({ expansion: MALFORMED_HOLDS[key] })), "plan.propose", "PLANNING");
    }
    expect(keys.length).toBe(3);
  });

  it("leaves an INITIAL proposal carrying a stray binding free of expansion authority", () => {
    const next = accepted(reducePlanningRun(state("PLANNING"),
      { ...commandFor("plan.propose"), expansion: { ...HOLD } } as unknown as PlanningRunCommand));
    expect("expansion" in next).toBe(false);
    expect("sealedProposal" in next).toBe(false);
  });
});

describe("planning run EXPANSION finalization", () => {
  const sealed = expansionState("PLANNING",
    { sealedProposal: { ...IDENTITY }, submissionHash: SUBMISSION_HASH });

  it("seals a child and integrator multi-node proposal instead of refusing", () => {
    const command = { ...commandFor("planning.finalize_submission"),
      witness: expansionFinalizeWitness() } as unknown as PlanningRunCommand;
    const next = accepted(reducePlanningRun(sealed, command));
    expect(next).toMatchObject({ lifecycle: "PLAN_REVIEW", runKind: "EXPANSION" });
    expect(fields(next)["sealedProposal"]).toEqual(IDENTITY);
    expect(Object.keys(next).sort()).toEqual(EXPANSION_STATE_KEYS);
  });

  it("still refuses a graph bearing no execution on both run kinds", () => {
    const empty = { ...commandFor("planning.finalize_submission"),
      witness: finalizeWitness(0) } as unknown as PlanningRunCommand;
    expectIllegal(reducePlanningRun(sealed, empty), "planning.finalize_submission", "PLANNING");
    expectIllegal(reducePlanningRun(state("PLANNING", { submissionHash: SUBMISSION_HASH }), empty),
      "planning.finalize_submission", "PLANNING");
  });

  it("carries the hold onto an EXPANSION successor without aliasing it", () => {
    const command = { commandId: "cmd-refuse", expectedVersion: 7,
      kind: "planning.finalize_submission", refusal: REFUSAL,
      witness: finalizeWitness(2) } as unknown as PlanningRunCommand;
    const result = reducePlanningRun(sealed, command);
    const next = accepted(result);
    expect(next.lifecycle).toBe("REJECTED");
    const successor = result.ok ? result.successor : undefined;
    expect(snapshotPlanningRunContractState(successor)).not.toBeUndefined();
    expect(fields(successor)["expansion"]).toEqual(HOLD);
    expect(fields(successor)["sealedProposal"]).toBeNull();
    expect(fields(successor)["expansion"]).not.toBe(fields(next)["expansion"]);
    expect(fields(fields(successor)["expansion"])["workerHandoff"])
      .not.toBe(fields(fields(next)["expansion"])["workerHandoff"]);
  });

  it("leaves an EXPANSION successor able to accept its next command", () => {
    const command = { commandId: "cmd-refuse", expectedVersion: 7,
      kind: "planning.finalize_submission", refusal: REFUSAL,
      witness: finalizeWitness(1) } as unknown as PlanningRunCommand;
    const result = reducePlanningRun(sealed, command);
    const successor = (result.ok ? result.successor : undefined) as unknown as PlanningRunState;
    const follow = reducePlanningRun(successor, commandFor("planning.ready", 1));
    expect(follow.ok).toBe(true);
    expect(accepted(follow).lifecycle).toBe("READY");
  });
});
