/**
 * Pure CutoverAttempt lifecycle reduction (design section 21.12, states at design :243).
 * No store, no daemon surface, no human-authority check: an approval reaches this reducer as
 * an already-decided opaque witness, and admitting that decision belongs to the handler row.
 *
 * REFUSAL CODES ARE CONSTRAINED BY THE ERROR REGISTRY AND MISMATCHES FAIL SILENTLY.
 * `createRuntimeError` returns UNKNOWN_ERROR (it does not throw) for an unknown code, for a
 * source whose aggregate the descriptor does not list, and for a source whose `state` is not a
 * member of that tuple. Only ILLEGAL_TRANSITION and CUTOVER_STATE_INVALID admit CUTOVER:
 *   - a version mismatch refuses ILLEGAL_TRANSITION, because EXPECTED_VERSION_CONFLICT does
 *     not admit CUTOVER and would degrade;
 *   - a command with no prior state, a malformed command, and a state whose lifecycle is not a
 *     CUTOVER member all refuse INPUT_INVALID, which declares no valid source and so must be
 *     raised WITHOUT one — the only source-free refusal available here;
 *   - CUTOVER_STATE_INVALID is raised only when a readable CUTOVER lifecycle exists to tag.
 * The suite's anti-UNKNOWN_ERROR arm holds over every refusal this module can produce.
 */
import { RUNTIME_LIFECYCLES, createRuntimeError } from "@moe/contracts";

import {
  CUTOVER_COMMAND_KINDS,
  CUTOVER_TARGET_STATES,
  CUTOVER_TERMINAL_STATES,
  CUTOVER_TRANSITIONS,
} from "./cutover-contract.js";
import type {
  CutoverAttemptEvent,
  CutoverAttemptState,
  CutoverCommand,
  CutoverCommandKind,
  CutoverReducerResult,
  CutoverState,
} from "./cutover-contract.js";

export { CUTOVER_COMMAND_KINDS, CUTOVER_TARGET_STATES, CUTOVER_TERMINAL_STATES,
  CUTOVER_TRANSITIONS };

const CUTOVER_LAYER = "CUTOVER" as const;
const SAFE_REF = /^[A-Za-z0-9._:/-]{1,64}$/;
const COMMAND_KIND_SET: ReadonlySet<string> = new Set(CUTOVER_COMMAND_KINDS);
const STATE_SET: ReadonlySet<string> = new Set(RUNTIME_LIFECYCLES.CUTOVER);
const TRUTH_CLASS_SET: ReadonlySet<string> = new Set(RUNTIME_LIFECYCLES.TRUTH_CLASS);

const WITNESS_KEYS = Object.freeze({
  "cutover.preview": ["inventoryRef", "truthClass"],
  "cutover.admit_quiesce_approval": ["approvalRef", "truthClass"],
  "cutover.begin_quiesce": [],
  "cutover.complete_quiesce": ["identicalManifestRef", "truthClass", "writeLockRef"],
  "cutover.verify_import": ["importHeadRef", "restoreDrillRef", "truthClass"],
  "cutover.admit_activate_approval": ["approvalRef", "truthClass"],
  "cutover.activate": [],
  "cutover.abort": ["legacyUnfrozenRef", "truthClass"],
} as const satisfies Readonly<Record<CutoverCommandKind, readonly string[]>>);

const STATE_KEYS: readonly string[] = [
  "activateApprovalRef", "attemptId", "importHeadRef", "lifecycle", "quiesceApprovalRef",
  "sourceManifestRef", "version",
];

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validRef(value: unknown): value is string {
  return typeof value === "string" && SAFE_REF.test(value);
}

function nullableRef(value: unknown): value is string | null {
  return value === null || validRef(value);
}

function rejected(error: ReturnType<typeof createRuntimeError>): CutoverReducerResult {
  return Object.freeze({ error, layer: CUTOVER_LAYER, ok: false as const });
}

/** The only source-free refusal available to this aggregate; see the module header. */
function inputInvalid(): CutoverReducerResult {
  return rejected(createRuntimeError({ code: "INPUT_INVALID" }));
}

function illegal(lifecycle: CutoverState, kind: CutoverCommandKind): CutoverReducerResult {
  return rejected(createRuntimeError({
    code: "ILLEGAL_TRANSITION",
    details: { aggregateKind: CUTOVER_LAYER, commandKind: kind, sourceState: lifecycle },
    source: { aggregate: CUTOVER_LAYER, state: lifecycle },
  }));
}

function stateInvalid(lifecycle: CutoverState): CutoverReducerResult {
  return rejected(createRuntimeError({
    code: "CUTOVER_STATE_INVALID",
    details: { sourceState: lifecycle },
    source: { aggregate: CUTOVER_LAYER, state: lifecycle },
  }));
}

function accepted(
  state: CutoverAttemptState, events: readonly CutoverAttemptEvent[],
): CutoverReducerResult {
  return deepFreeze({ events, ok: true as const, state });
}

function validWitness(kind: CutoverCommandKind, witness: unknown): boolean {
  const keys: readonly string[] = WITNESS_KEYS[kind];
  if (keys.length === 0) return witness === undefined;
  if (!isRecord(witness)) return false;
  const own = Reflect.ownKeys(witness);
  if (own.length !== keys.length || !keys.every((key) => Object.hasOwn(witness, key))) return false;
  return keys.every((key) => key === "truthClass"
    ? typeof witness[key] === "string" && TRUTH_CLASS_SET.has(witness[key])
    : validRef(witness[key]));
}

/** Snapshots the command into a fresh object; nothing caller-owned survives into a result. */
function snapshotCommand(command: unknown): CutoverCommand | undefined {
  if (!isRecord(command)) return undefined;
  const { commandId, expectedVersion, kind } = command;
  if (typeof kind !== "string" || !COMMAND_KIND_SET.has(kind)) return undefined;
  const commandKind = kind as CutoverCommandKind;
  if (!validRef(commandId) || typeof expectedVersion !== "number"
    || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return undefined;
  if (!validWitness(commandKind, command["witness"])) return undefined;
  const raw: unknown = command["witness"];
  const witness = isRecord(raw) ? deepFreeze({ ...raw }) : undefined;
  // `validWitness` above proved the per-kind key set and value shapes, and the kind is a roster
  // member, so the rebuilt literal satisfies the union member for that kind. TypeScript cannot
  // narrow a dynamically keyed rebuild, hence the single widening step here.
  if (commandKind !== "cutover.preview") {
    return deepFreeze({ commandId, expectedVersion, kind: commandKind, witness }) as unknown as
      CutoverCommand;
  }
  if (!validRef(command["attemptId"]) || !validRef(command["sourceManifestRef"])) return undefined;
  return deepFreeze({
    attemptId: command["attemptId"], commandId, expectedVersion, kind: commandKind,
    sourceManifestRef: command["sourceManifestRef"], witness,
  }) as unknown as CutoverCommand;
}

type StateSnapshot =
  | { readonly kind: "ok"; readonly state: CutoverAttemptState }
  | { readonly kind: "invalid"; readonly lifecycle: CutoverState }
  | { readonly kind: "unreadable" };

const UNREADABLE = Object.freeze({ kind: "unreadable" as const });

/**
 * Separates "structurally broken but its lifecycle reads" from "not a CUTOVER state at all":
 * only the first can carry a taggable source, and the second must refuse source-free.
 */
function snapshotState(state: unknown): StateSnapshot {
  if (!isRecord(state)) return UNREADABLE;
  const lifecycle = state["lifecycle"];
  if (typeof lifecycle !== "string" || !STATE_SET.has(lifecycle)) return UNREADABLE;
  const current = lifecycle as CutoverState;
  const own = Reflect.ownKeys(state);
  if (own.length !== STATE_KEYS.length || !STATE_KEYS.every((key) => Object.hasOwn(state, key))) {
    return { kind: "invalid", lifecycle: current };
  }
  const version = state["version"];
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1
    || !validRef(state["attemptId"]) || !validRef(state["sourceManifestRef"])
    || !nullableRef(state["activateApprovalRef"]) || !nullableRef(state["importHeadRef"])
    || !nullableRef(state["quiesceApprovalRef"])) {
    return { kind: "invalid", lifecycle: current };
  }
  return {
    kind: "ok",
    state: deepFreeze({
      activateApprovalRef: state["activateApprovalRef"] as string | null,
      attemptId: state["attemptId"] as string,
      importHeadRef: state["importHeadRef"] as string | null,
      lifecycle: current,
      quiesceApprovalRef: state["quiesceApprovalRef"] as string | null,
      sourceManifestRef: state["sourceManifestRef"] as string,
      version,
    }),
  };
}

function eventKind(kind: CutoverCommandKind): CutoverAttemptEvent["kind"] {
  if (kind === "cutover.preview") return "CutoverAttemptPreviewed";
  return kind === "cutover.abort" ? "CutoverAttemptAborted" : "CutoverAttemptAdvanced";
}

function witnessRef(command: CutoverCommand, key: string): string | null {
  const witness: unknown = "witness" in command ? command.witness : undefined;
  if (!isRecord(witness)) return null;
  const value = witness[key];
  return validRef(value) ? value : null;
}

function create(command: CutoverCommand): CutoverReducerResult {
  if (command.kind !== "cutover.preview" || command.expectedVersion !== 0) return inputInvalid();
  const state: CutoverAttemptState = deepFreeze({
    activateApprovalRef: null, attemptId: command.attemptId, importHeadRef: null,
    lifecycle: "PREVIEWED" as const, quiesceApprovalRef: null,
    sourceManifestRef: command.sourceManifestRef, version: 1,
  });
  return accepted(state, [deepFreeze({
    commandId: command.commandId, commandKind: command.kind,
    kind: "CutoverAttemptPreviewed" as const, lifecycle: state.lifecycle, version: 1,
  })]);
}

function apply(state: CutoverAttemptState, command: CutoverCommand): CutoverReducerResult {
  const lifecycle = CUTOVER_TARGET_STATES[command.kind];
  const next: CutoverAttemptState = deepFreeze({
    ...state,
    activateApprovalRef: command.kind === "cutover.admit_activate_approval"
      ? witnessRef(command, "approvalRef") : state.activateApprovalRef,
    importHeadRef: command.kind === "cutover.verify_import"
      ? witnessRef(command, "importHeadRef") : state.importHeadRef,
    lifecycle,
    quiesceApprovalRef: command.kind === "cutover.admit_quiesce_approval"
      ? witnessRef(command, "approvalRef") : state.quiesceApprovalRef,
    version: state.version + 1,
  });
  return accepted(next, [deepFreeze({
    commandId: command.commandId, commandKind: command.kind, kind: eventKind(command.kind),
    lifecycle, version: next.version,
  })]);
}

/** Pure lifecycle reduction; the decision ledger owns command replay and conflict lookup. */
export function reduceCutover(
  state: CutoverAttemptState | undefined, command: CutoverCommand,
): CutoverReducerResult {
  const input = snapshotCommand(command);
  if (input === undefined) return inputInvalid();
  if (state === undefined) return create(input);
  const snapshot = snapshotState(state);
  if (snapshot.kind === "unreadable") return inputInvalid();
  if (snapshot.kind === "invalid") return stateInvalid(snapshot.lifecycle);
  const current = snapshot.state;
  if (input.expectedVersion !== current.version) return illegal(current.lifecycle, input.kind);
  const admitted: readonly CutoverState[] = CUTOVER_TRANSITIONS[input.kind];
  if (!admitted.includes(current.lifecycle)) return illegal(current.lifecycle, input.kind);
  if (current.version >= Number.MAX_SAFE_INTEGER) return illegal(current.lifecycle, input.kind);
  return apply(current, input);
}
