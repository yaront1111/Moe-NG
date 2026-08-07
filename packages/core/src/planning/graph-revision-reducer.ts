/**
 * Immutable graph revision lifecycle (design section 10). Content identity — `graphContentHash`
 * and `planHash` — is fixed at creation and no accepted command ever changes it.
 *
 * Composition contract: this reducer is pure and touches only its own aggregate. `graphEpoch`
 * authority lives in the goal aggregate, where `goal.activate_initial_graph` increments it, so
 * activation here emits reference data (`goalRef`, `expectedGoalVersion`) rather than a private
 * counter. Initial activation is therefore THREE reducer results the daemon must commit in one
 * atomic transaction: the planning run's `graph.approve`, this revision's activation, and the
 * goal's `goal.activate_initial_graph`. Any of the three rejecting aborts all of them; a
 * concurrent activation loses on goal version, and a crash yields all or none.
 *
 * Registry note: `GRAPH_REVISION` is a valid source for `ILLEGAL_TRANSITION`,
 * `EXPECTED_VERSION_CONFLICT`, `REVISION_REBOUND`, and `SUPERSEDED_AUTHORITY` — but NOT for
 * `IDEMPOTENCY_CONFLICT`, so a missing command identity rejects `ILLEGAL_TRANSITION` here
 * instead of cloning the goal reducer verbatim into a silent `UNKNOWN_ERROR` degrade.
 */
import type {
  GraphActivationBinding,
  GraphRevisionApproveCommand,
  GraphRevisionCommand,
  GraphRevisionCommandKind,
  GraphRevisionCreateCommand,
  GraphRevisionEvent,
  GraphRevisionLifecycle,
  GraphRevisionReducerResult,
  GraphRevisionRejectCommand,
  GraphRevisionState,
  GraphRevisionSubmitCommand,
} from "./graph-revision-contract.js";
import {
  accepted,
  clonedState,
  illegal,
  rebound,
  supersededAuthority,
  unknownFailure,
  versionConflict,
} from "./graph-revision-results.js";
import {
  bindingOf,
  sameBinding,
  snapshotGraphRevisionState,
  validActivation,
  validApproval,
  validRefusal,
  validSubmission,
} from "./graph-revision-validation.js";
import {
  deepFreeze,
  snapshotCommand,
  validExpectedVersion,
  validHex64,
  validRef,
} from "./planning-snapshot.js";

export const GRAPH_REVISION_COMMAND_KINDS = Object.freeze([
  "graph_revision.create", "graph_revision.submit", "graph.approve", "graph_revision.reject",
  "graph.supersede",
] as const satisfies readonly GraphRevisionCommandKind[]);

/** `DRAFT -> PENDING_APPROVAL -> APPROVED -> ACTIVE`, plus pre-activation refusal. */
export const GRAPH_REVISION_TRANSITIONS = Object.freeze({
  "graph_revision.create": Object.freeze([]),
  "graph_revision.submit": Object.freeze(["DRAFT"]),
  "graph.approve": Object.freeze(["PENDING_APPROVAL", "APPROVED"]),
  "graph_revision.reject": Object.freeze(["DRAFT", "PENDING_APPROVAL", "APPROVED"]),
  "graph.supersede": Object.freeze([]),
} as const satisfies Readonly<Record<GraphRevisionCommandKind, readonly GraphRevisionLifecycle[]>>);

function create(command: GraphRevisionCreateCommand): GraphRevisionReducerResult {
  if (command.expectedVersion !== 0 || !validRef(command.revisionId)
    || !validRef(command.goalRef) || !validHex64(command.graphContentHash)
    || !validHex64(command.planHash)) {
    return unknownFailure();
  }
  const state = deepFreeze({
    boundHashes: null, goalRef: command.goalRef, graphContentHash: command.graphContentHash,
    lifecycle: "DRAFT" as const, planHash: command.planHash, revisionId: command.revisionId,
    submissionRef: null, version: 1,
  });
  return accepted(state, [deepFreeze({
    commandId: command.commandId, goalRef: state.goalRef,
    graphContentHash: state.graphContentHash, kind: "GraphRevisionCreated" as const,
    planHash: state.planHash, revisionId: state.revisionId, version: 1,
  })]);
}

function submit(
  state: GraphRevisionState,
  command: GraphRevisionSubmitCommand,
): GraphRevisionReducerResult {
  if (!validSubmission(command.witness)) return illegal(state, command.kind);
  const witness = deepFreeze({ ...command.witness });
  const next = clonedState(state, { lifecycle: "PENDING_APPROVAL" as const,
    submissionRef: witness.submissionRef, version: state.version + 1 });
  return accepted(next, [deepFreeze({ commandId: command.commandId,
    kind: "GraphRevisionSubmitted" as const, version: next.version, witness })]);
}

function refuse(
  state: GraphRevisionState,
  command: GraphRevisionRejectCommand,
): GraphRevisionReducerResult {
  if (!validRefusal(command.witness)) return illegal(state, command.kind);
  const witness = deepFreeze({ ...command.witness });
  const next = clonedState(state, { lifecycle: "REJECTED" as const,
    version: state.version + 1 });
  return accepted(next, [deepFreeze({ commandId: command.commandId,
    kind: "GraphRevisionRejected" as const, version: next.version, witness })]);
}

function approvalBinding(
  state: GraphRevisionState,
  command: GraphRevisionApproveCommand,
): GraphActivationBinding | GraphRevisionReducerResult {
  const approval: unknown = command.approval;
  if (!validApproval(approval)) return illegal(state, command.kind);
  if (approval.graphHash !== state.graphContentHash) return rebound(state);
  return deepFreeze(bindingOf(approval));
}

function decide(
  state: GraphRevisionState,
  command: GraphRevisionApproveCommand,
): GraphRevisionReducerResult {
  const activation: unknown = command.activation;
  const compound = state.lifecycle === "PENDING_APPROVAL";
  const events: GraphRevisionEvent[] = [];
  let version = state.version;
  let binding = state.boundHashes;
  if (compound) {
    const decided = approvalBinding(state, command);
    if ("ok" in decided) return decided;
    binding = decided;
    version += 1;
    events.push(deepFreeze({ binding, commandId: command.commandId,
      kind: "GraphRevisionApproved" as const, version }));
  } else if (command.approval !== undefined) {
    return illegal(state, command.kind);
  }
  if (activation === undefined) {
    if (!compound) return illegal(state, command.kind);
    const next = clonedState(state, { boundHashes: binding, lifecycle: "APPROVED" as const,
      version });
    return accepted(next, events);
  }
  if (!validActivation(activation)) return illegal(state, command.kind);
  if (binding === null || !sameBinding(binding, activation)
    || activation.graphHash !== state.graphContentHash) {
    return rebound(state);
  }
  const witness = deepFreeze({ ...activation });
  version += 1;
  const next = clonedState(state, { boundHashes: binding, lifecycle: "ACTIVE" as const, version });
  events.push(deepFreeze({ commandId: command.commandId,
    expectedGoalVersion: witness.expectedGoalVersion, goalRef: state.goalRef,
    kind: "GraphRevisionActivated" as const, version, witness }));
  return accepted(next, events);
}

function apply(
  state: GraphRevisionState,
  command: GraphRevisionCommand,
): GraphRevisionReducerResult {
  switch (command.kind) {
    case "graph_revision.submit": return submit(state, command);
    case "graph.approve": return decide(state, command);
    case "graph_revision.reject": return refuse(state, command);
    case "graph_revision.create": case "graph.supersede": return illegal(state, command.kind);
  }
}

function safeToApply(state: GraphRevisionState, command: GraphRevisionCommand): boolean {
  const compound = command.kind === "graph.approve" && state.lifecycle === "PENDING_APPROVAL"
    && command.activation !== undefined;
  return state.version <= Number.MAX_SAFE_INTEGER - (compound ? 2 : 1);
}

/** Pure lifecycle reduction; the decision ledger owns command replay and conflict lookup. */
export function reduceGraphRevision(
  state: GraphRevisionState | undefined,
  command: GraphRevisionCommand,
): GraphRevisionReducerResult {
  const input = snapshotCommand(command, GRAPH_REVISION_COMMAND_KINDS) as
    GraphRevisionCommand | undefined;
  if (input === undefined) return unknownFailure();
  if (state === undefined) {
    if (input.kind !== "graph_revision.create" || !validRef(input.commandId)) {
      return unknownFailure();
    }
    return create(input);
  }
  const current = snapshotGraphRevisionState(state);
  if (current === undefined) return unknownFailure();
  if (current.lifecycle === "SUPERSEDED") return supersededAuthority(current);
  if (!validExpectedVersion(input.expectedVersion)) return illegal(current, input.kind);
  if (input.expectedVersion !== current.version) {
    return versionConflict(current, input.expectedVersion);
  }
  if (!validRef(input.commandId)) return illegal(current, input.kind);
  const allowed: readonly GraphRevisionLifecycle[] = GRAPH_REVISION_TRANSITIONS[input.kind];
  if (!allowed.includes(current.lifecycle)) return illegal(current, input.kind);
  if (!safeToApply(current, input)) return illegal(current, input.kind);
  return apply(current, input);
}
