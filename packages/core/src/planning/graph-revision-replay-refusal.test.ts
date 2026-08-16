/**
 * Refusal contract for graph revision event replay.
 *
 * Every case asserts the exact stable code AND the refusing layer as one string, because a bare
 * "did not succeed" assertion goes vacuous the moment a second validation layer starts answering
 * first. Each hostile history is ONE deliberate drift from a reducer-generated one, so the fixture
 * and the expectation can never drift together into a tautology.
 */
import { expect, it } from "vitest";

import { GRAPH_REVISION_REPLAY_CODES, replayGraphRevisionEvents } from "./graph-revision-replay.js";
import {
  activate,
  approve,
  approveAndActivate,
  approveAndActivateSuccessor,
  create,
  createSuccessor,
  expectRefusal,
  historyOf,
  mutatedLast,
  reject,
  submit,
  supersede,
  supersededWithSuccessor,
  SUCCESSOR,
} from "./graph-revision-replay-test-fixtures.js";
import {
  ACTIVATION,
  APPROVAL,
  REJECTION,
  STALE_HASH,
  SUBMISSION,
  successorActivation,
} from "./graph-revision-test-fixtures.js";

/** Same (version, commandId) identity, one drifted byte — the conflict the ledger cannot mask. */
it("refuses a conflicting redelivery at an already-applied version", () => {
  const events = historyOf([create, submit]);
  const submitted = events[1];
  if (submitted === undefined || submitted.kind !== "GraphRevisionSubmitted") {
    throw new Error("expected a submitted event");
  }
  expectRefusal(
    [...events, { ...submitted, witness: { ...submitted.witness, submissionRef: "submission-2" } }],
    "GRAPH_REVISION_REPLAY_IDENTITY_CONFLICT",
  );
});

it("refuses a redelivery that reuses a version under a different commandId", () => {
  const events = historyOf([create, submit]);
  const submitted = events[1];
  if (submitted === undefined) throw new Error("expected a submitted event");
  expectRefusal([...events, { ...submitted, commandId: "cmd-other" }],
    "GRAPH_REVISION_REPLAY_IDENTITY_CONFLICT");
});

const REFUSALS: readonly (readonly [string, () => unknown, string])[] = [
  ["a non-array history", () => ({ 0: historyOf([create])[0], length: 1 }),
    "GRAPH_REVISION_REPLAY_HISTORY_INVALID"],
  ["a string history", () => "GraphRevisionCreated", "GRAPH_REVISION_REPLAY_HISTORY_INVALID"],
  ["a null history", () => null, "GRAPH_REVISION_REPLAY_HISTORY_INVALID"],
  ["an undefined history", () => undefined, "GRAPH_REVISION_REPLAY_HISTORY_INVALID"],
  ["a sparse history", () => {
    const events = historyOf([create]);
    // eslint-disable-next-line no-sparse-arrays
    return [events[0], , events[0]];
  }, "GRAPH_REVISION_REPLAY_HISTORY_INVALID"],
  ["a history carrying an extra own key", () => {
    const events = historyOf([create]) as unknown as Record<string, unknown>;
    events["injected"] = "value";
    return events;
  }, "GRAPH_REVISION_REPLAY_HISTORY_INVALID"],
  ["a history holding a getter entry", () => {
    const events = historyOf([create]);
    return Object.defineProperty([...events], "0", { enumerable: true, get: () => events[0] });
  }, "GRAPH_REVISION_REPLAY_HISTORY_INVALID"],
  ["a cyclic event", () => {
    const events = historyOf([create]);
    const cyclic: Record<string, unknown> = { ...events[0] };
    cyclic["self"] = cyclic;
    return [cyclic];
  }, "GRAPH_REVISION_REPLAY_HISTORY_INVALID"],
  ["an event with an exotic prototype", () => {
    const events = historyOf([create]);
    return [Object.assign(Object.create({ poisoned: true }), events[0])];
  }, "GRAPH_REVISION_REPLAY_HISTORY_INVALID"],
  ["an event carrying a symbol key", () => {
    const events = historyOf([create]);
    const tainted: Record<PropertyKey, unknown> = { ...events[0] };
    tainted[Symbol("tag")] = "value";
    return [tainted];
  }, "GRAPH_REVISION_REPLAY_HISTORY_INVALID"],
  ["an empty history", () => [], "GRAPH_REVISION_REPLAY_MISSING_CREATE"],
  ["a history that does not open with a create", () => historyOf([create, submit]).slice(1),
    "GRAPH_REVISION_REPLAY_MISSING_CREATE"],
  ["a repeated create at a later version", () => {
    const events = historyOf([create, submit]);
    const created = events[0];
    if (created === undefined) throw new Error("expected a created event");
    return [...events, { ...created, version: 3 }];
  }, "GRAPH_REVISION_REPLAY_DUPLICATE_CREATE"],
  ["a create at a version other than one",
    () => mutatedLast([create], { version: 2 }), "GRAPH_REVISION_REPLAY_VERSION_BREAK"],
  ["an unknown event kind",
    () => mutatedLast([create], { kind: "GraphRevisionArchived" }),
    "GRAPH_REVISION_REPLAY_EVENT_INVALID"],
  ["an event missing a required key", () => {
    const events = historyOf([create]);
    const created = events[0] as unknown as Record<string, unknown>;
    const { planHash: _planHash, ...rest } = created;
    return [rest];
  }, "GRAPH_REVISION_REPLAY_EVENT_INVALID"],
  ["an event carrying an extra key",
    () => mutatedLast([create], { extra: "value" }), "GRAPH_REVISION_REPLAY_EVENT_INVALID"],
  ["a create naming a non-hex content hash",
    () => mutatedLast([create], { graphContentHash: "not-a-hash" }),
    "GRAPH_REVISION_REPLAY_EVENT_INVALID"],
  ["a create naming an empty revision",
    () => mutatedLast([create], { revisionId: "" }), "GRAPH_REVISION_REPLAY_EVENT_INVALID"],
  ["a submission witness below the truth floor",
    () => mutatedLast([create, submit], { witness: { ...SUBMISSION, truthClass: "OBSERVED" } }),
    "GRAPH_REVISION_REPLAY_EVENT_INVALID"],
  ["a refusal witness below the truth floor",
    () => mutatedLast([create, reject], { witness: { ...REJECTION, truthClass: "AGENT_REPORTED" } }),
    "GRAPH_REVISION_REPLAY_EVENT_INVALID"],
  ["a malformed approval binding",
    () => mutatedLast([create, submit, approve], { binding: { ...APPROVAL } }),
    "GRAPH_REVISION_REPLAY_EVENT_INVALID"],
  ["a version gap", () => mutatedLast([create, submit], { version: 4 }),
    "GRAPH_REVISION_REPLAY_VERSION_BREAK"],
  ["a version regression below the applied floor", () => {
    const events = historyOf([create, submit, approve]);
    const approved = events[2];
    if (approved === undefined) throw new Error("expected an approved event");
    return [events[0], events[1], { ...approved, version: 1 }];
  }, "GRAPH_REVISION_REPLAY_IDENTITY_CONFLICT"],
  ["a reordered history", () => {
    const events = historyOf([create, submit, approve]);
    return [events[0], events[2], events[1]];
  }, "GRAPH_REVISION_REPLAY_VERSION_BREAK"],
  ["an approval applied to a DRAFT", () => {
    const events = historyOf([create, submit, approve]);
    const approved = events[2];
    if (approved === undefined) throw new Error("expected an approved event");
    return [events[0], { ...approved, version: 2 }];
  }, "GRAPH_REVISION_REPLAY_ILLEGAL_TRANSITION"],
  ["a submission applied after approval", () => {
    const events = historyOf([create, submit, approve]);
    const submitted = events[1];
    if (submitted === undefined) throw new Error("expected a submitted event");
    return [...events, { ...submitted, commandId: "cmd-submit-2", version: 4 }];
  }, "GRAPH_REVISION_REPLAY_ILLEGAL_TRANSITION"],
  ["an event after a terminal supersession", () => {
    const events = historyOf([create, submit, approveAndActivate, supersede]);
    const rejected = historyOf([create, reject])[1];
    if (rejected === undefined) throw new Error("expected a rejected event");
    return [...events, { ...rejected, commandId: "cmd-late", version: 6 }];
  }, "GRAPH_REVISION_REPLAY_ILLEGAL_TRANSITION"],
  ["an event after a terminal rejection", () => {
    const events = historyOf([create, reject]);
    const submitted = historyOf([create, submit])[1];
    if (submitted === undefined) throw new Error("expected a submitted event");
    return [...events, { ...submitted, commandId: "cmd-late", version: 3 }];
  }, "GRAPH_REVISION_REPLAY_ILLEGAL_TRANSITION"],
  ["an activation whose binding drifted from the approved identity",
    () => mutatedLast([create, submit, approve, activate],
      { witness: { ...ACTIVATION, budgetHash: STALE_HASH } }),
    "GRAPH_REVISION_REPLAY_BINDING_DRIFT"],
  ["an activation whose content hash drifted from the sealed revision",
    () => mutatedLast([create, submit, approve, activate],
      { witness: { ...ACTIVATION, graphHash: STALE_HASH } }),
    "GRAPH_REVISION_REPLAY_BINDING_DRIFT"],
  ["an activation event whose goal reference drifted",
    () => mutatedLast([create, submit, approve, activate], { goalRef: "goal-2" }),
    "GRAPH_REVISION_REPLAY_BINDING_DRIFT"],
  ["an activation event whose expected goal version drifted from its witness",
    () => mutatedLast([create, submit, approve, activate], { expectedGoalVersion: 9 }),
    "GRAPH_REVISION_REPLAY_BINDING_DRIFT"],
  ["an approval binding that does not bind this revision's content",
    () => mutatedLast([create, submit, approve],
      { binding: { budgetHash: APPROVAL.budgetHash,
        expectedGoalVersion: APPROVAL.expectedGoalVersion, graphHash: STALE_HASH,
        policyHash: APPROVAL.policyHash, qualityHash: APPROVAL.qualityHash } }),
    "GRAPH_REVISION_REPLAY_BINDING_DRIFT"],
  ["an initial activation at an epoch other than one",
    () => mutatedLast([create, submit, approve, activate],
      { witness: { ...ACTIVATION, graphEpoch: 2 } }),
    "GRAPH_REVISION_REPLAY_EPOCH_DRIFT"],
  ["a successor activation that skips the predecessor's epoch",
    () => mutatedLast([createSuccessor, submit, approveAndActivateSuccessor],
      { witness: successorActivation(SUCCESSOR, 1, { graphEpoch: 4 }) }),
    "GRAPH_REVISION_REPLAY_EPOCH_DRIFT"],
  ["a successor activation naming a malformed predecessor epoch",
    () => mutatedLast([createSuccessor, submit, approveAndActivateSuccessor],
      { witness: successorActivation(SUCCESSOR, 0) }),
    "GRAPH_REVISION_REPLAY_EPOCH_DRIFT"],
  ["a supersession carrying a malformed authority hash",
    () => mutatedLast([create, submit, approveAndActivate, supersede],
      { authorityHash: "not-a-hash" }), "GRAPH_REVISION_REPLAY_EVENT_INVALID"],
  ["a supersession whose successor is not itself active",
    () => supersededWithSuccessor({ lifecycle: "SUPERSEDED" }),
    "GRAPH_REVISION_REPLAY_EVENT_INVALID"],
  ["a supersession naming a predecessor revision that is not this one",
    () => supersededWithSuccessor({ predecessorRevisionId: "graph-revision-9" }),
    "GRAPH_REVISION_REPLAY_BINDING_DRIFT"],
  ["a supersession naming predecessor content that is not this revision's",
    () => supersededWithSuccessor({ predecessorGraphContentHash: STALE_HASH }),
    "GRAPH_REVISION_REPLAY_BINDING_DRIFT"],
  ["a supersession whose successor skips the predecessor's epoch",
    () => supersededWithSuccessor({ graphEpoch: 5 }), "GRAPH_REVISION_REPLAY_EPOCH_DRIFT"],
];

it.each(REFUSALS)("refuses %s", (_name, build, code) => {
  expectRefusal(build(), code);
});

it("never leaks partial state or events on a refusal", () => {
  for (const [, build] of REFUSALS) {
    const result = replayGraphRevisionEvents(build());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(Object.keys(result).sort()).toEqual(["code", "layer", "ok"]);
  }
});

it("publishes a closed refusal vocabulary and every code in it is reachable", () => {
  expect(REFUSALS.length).toBeGreaterThan(0);
  expect(GRAPH_REVISION_REPLAY_CODES.length).toBeGreaterThan(0);
  expect(Object.isFrozen(GRAPH_REVISION_REPLAY_CODES)).toBe(true);
  expect([...new Set(GRAPH_REVISION_REPLAY_CODES)]).toEqual([...GRAPH_REVISION_REPLAY_CODES]);
  const exercised = new Set(REFUSALS.map(([, , code]) => code));
  exercised.add("GRAPH_REVISION_REPLAY_IDENTITY_CONFLICT");
  // Every published code must be exercised: an unreachable code is an unverifiable refusal.
  expect([...GRAPH_REVISION_REPLAY_CODES].sort()).toEqual([...exercised].sort());
});
