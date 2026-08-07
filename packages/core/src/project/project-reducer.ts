import { createRuntimeError } from "@moe/contracts";

import type {
  ProjectActivateCommand,
  ProjectBindRepositoryCommand,
  ProjectCommand,
  ProjectCommandKind,
  ProjectEvent,
  ProjectLifecycle,
  ProjectReducerResult,
  ProjectRegisterCommand,
  ProjectState,
  RecoveryCompleteCommand,
  RepositoryObservation,
  RestoreQuiesceCommand,
} from "./project-contract.js";
import {
  PROJECT_COMMAND_KINDS,
  snapshotProjectCommand,
  snapshotProjectState,
  validActivation,
  validExpectedVersion,
  validObservation,
  validProjectRef,
  validRecovery,
  validRestore,
} from "./project-validation.js";

export { PROJECT_COMMAND_KINDS };

export const PROJECT_TRANSITIONS = Object.freeze({
  "project.register": Object.freeze([]),
  "project.bind_repository": Object.freeze(["BOOTSTRAPPING"]),
  "project.activate": Object.freeze(["BOOTSTRAPPING"]),
  "recovery.restore_quiesce": Object.freeze(["BOOTSTRAPPING", "READY"]),
  "recovery.complete": Object.freeze(["QUIESCED"]),
} as const satisfies Readonly<Record<ProjectCommandKind, readonly ProjectLifecycle[]>>);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function rejected(error: ReturnType<typeof createRuntimeError>): ProjectReducerResult {
  return Object.freeze({ error, ok: false });
}

function unknownFailure(): ProjectReducerResult {
  return rejected(createRuntimeError({ code: "UNKNOWN_ERROR" }));
}

function versionConflict(state: ProjectState, expectedVersion: number): ProjectReducerResult {
  return rejected(createRuntimeError({
    code: "EXPECTED_VERSION_CONFLICT",
    details: { actualVersion: state.version, expectedVersion },
    source: { aggregate: "PROJECT", state: state.lifecycle },
  }));
}

function illegal(state: ProjectState, kind: ProjectCommandKind): ProjectReducerResult {
  return rejected(createRuntimeError({
    code: "ILLEGAL_TRANSITION",
    details: { aggregateKind: "PROJECT", commandKind: kind, sourceState: state.lifecycle },
    source: { aggregate: "PROJECT", state: state.lifecycle },
  }));
}

function idempotencyConflict(state: ProjectState): ProjectReducerResult {
  return rejected(createRuntimeError({
    code: "IDEMPOTENCY_CONFLICT",
    source: { aggregate: "PROJECT", state: state.lifecycle },
  }));
}

function accepted(state: ProjectState, event: ProjectEvent): ProjectReducerResult {
  return deepFreeze({ events: [event], ok: true as const, state });
}

function clonedState(state: ProjectState, patch: Partial<ProjectState>): ProjectState {
  const source = patch.repositoryObservations ?? state.repositoryObservations;
  const repositoryObservations = source.map((item) => ({ ...item }));
  return deepFreeze({ ...state, ...patch, repositoryObservations });
}

function register(command: ProjectRegisterCommand): ProjectReducerResult {
  if (!validProjectRef(command.projectId) || !validProjectRef(command.owner)
    || command.expectedVersion !== 0) {
    return unknownFailure();
  }
  const next = deepFreeze({
    lifecycle: "BOOTSTRAPPING" as const,
    owner: command.owner,
    projectId: command.projectId,
    recoveryRequired: false,
    repositoryObservations: [] as readonly RepositoryObservation[],
    version: 1,
  });
  return accepted(next, deepFreeze({
    commandId: command.commandId, kind: "ProjectRegistered" as const,
    owner: command.owner, projectId: command.projectId, version: next.version,
  }));
}

function bind(state: ProjectState, command: ProjectBindRepositoryCommand): ProjectReducerResult {
  if (!validObservation(command.observation)) return illegal(state, command.kind);
  const observation = deepFreeze({ ...command.observation });
  const next = clonedState(state, {
    repositoryObservations: [...state.repositoryObservations, observation],
    version: state.version + 1,
  });
  return accepted(next, deepFreeze({
    commandId: command.commandId, kind: "RepositoryBound" as const,
    observation, version: next.version,
  }));
}

function activate(state: ProjectState, command: ProjectActivateCommand): ProjectReducerResult {
  if (!validActivation(command.witness)) return illegal(state, command.kind);
  const witness = deepFreeze({ ...command.witness });
  const next = clonedState(state, {
    lifecycle: "READY" as const, recoveryRequired: false, version: state.version + 1,
  });
  return accepted(next, deepFreeze({
    commandId: command.commandId, kind: "ProjectActivated" as const,
    version: next.version, witness,
  }));
}

function quiesce(state: ProjectState, command: RestoreQuiesceCommand): ProjectReducerResult {
  if (!validRestore(command.witness)) return illegal(state, command.kind);
  const witness = deepFreeze({ ...command.witness });
  const next = clonedState(state, {
    lifecycle: "QUIESCED" as const, recoveryRequired: true, version: state.version + 1,
  });
  return accepted(next, deepFreeze({
    commandId: command.commandId, kind: "ProjectQuiesced" as const,
    version: next.version, witness,
  }));
}

function recover(state: ProjectState, command: RecoveryCompleteCommand): ProjectReducerResult {
  if (!validRecovery(command.witness)) return illegal(state, command.kind);
  const witness = deepFreeze({ ...command.witness });
  const next = clonedState(state, {
    lifecycle: "READY" as const, recoveryRequired: false, version: state.version + 1,
  });
  return accepted(next, deepFreeze({
    commandId: command.commandId, kind: "ProjectRecovered" as const,
    version: next.version, witness,
  }));
}

function apply(state: ProjectState, command: ProjectCommand): ProjectReducerResult {
  switch (command.kind) {
    case "project.bind_repository": return bind(state, command);
    case "project.activate": return activate(state, command);
    case "recovery.restore_quiesce": return quiesce(state, command);
    case "recovery.complete": return recover(state, command);
    case "project.register": return illegal(state, command.kind);
  }
}

/** Pure project lifecycle reduction; persistence owns replay and idempotent result lookup. */
export function reduceProject(
  state: ProjectState | undefined,
  command: ProjectCommand,
): ProjectReducerResult {
  const input = snapshotProjectCommand(command);
  if (input === undefined) return unknownFailure();
  if (state === undefined) {
    if (input.kind !== "project.register" || typeof input.commandId !== "string"
      || input.commandId.length === 0) {
      return unknownFailure();
    }
    return register(input);
  }
  const current = snapshotProjectState(state);
  if (current === undefined) return unknownFailure();
  if (!validExpectedVersion(input.expectedVersion)) return illegal(current, input.kind);
  if (input.expectedVersion !== current.version) {
    return versionConflict(current, input.expectedVersion);
  }
  if (typeof input.commandId !== "string" || input.commandId.length === 0) {
    return idempotencyConflict(current);
  }
  const allowedStates: readonly ProjectLifecycle[] = PROJECT_TRANSITIONS[input.kind];
  if (!allowedStates.includes(current.lifecycle)) {
    return illegal(current, input.kind);
  }
  if (current.version === Number.MAX_SAFE_INTEGER) return illegal(current, input.kind);
  return apply(current, input);
}
