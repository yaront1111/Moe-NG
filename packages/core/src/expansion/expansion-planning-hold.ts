/**
 * Pure EXPANSION_PLANNING hold lifecycle. It records runner/daemon evidence
 * but creates no child, execution, graph, resource, or budget authority.
 * Immediate composition consumer: task-fcad40b6d26243439cd19fd3e49c924d.
 * Durable daemon consumer: task-9634ed3b72014fe781591c7df9674da2.
 */
import { RUNTIME_LIFECYCLES, type RuntimeTruthClass } from "@moe/contracts";

export const EXPANSION_HOLD_COMMAND_KINDS = Object.freeze(["graph.request_expansion", "expansion.transition_hold"] as const);
export const EXPANSION_HOLD_CAUSES = Object.freeze(["EXPANSION_REFUSED", "GRAPH_ACTIVATED", "REVISE_PLAN", "GRAPH_SUPERSEDED", "EXPANSION_DECLINED", "PLANNING_CANCELLED", "GOAL_CANCELLED"] as const);
export const EXPANSION_HOLD_ERROR_CODES = Object.freeze([
  "EXPANSION_HOLD_INPUT_INVALID", "EXPANSION_HOLD_SAFE_BOUNDARY_UNPROVEN",
  "EXPANSION_HOLD_STALE_VERSION", "EXPANSION_HOLD_STALE_GENERATION", "EXPANSION_HOLD_STALE_EPOCH",
  "EXPANSION_HOLD_BINDING_MISMATCH", "EXPANSION_HOLD_IDEMPOTENCY_CONFLICT",
  "EXPANSION_HOLD_ILLEGAL_TRANSITION", "EXPANSION_HOLD_TERMINAL_PROOF_REQUIRED",
] as const);
export const EXPANSION_HOLD_LAYERS = Object.freeze([
  "INPUT", "SAFE_BOUNDARY", "CONCURRENCY", "BINDING", "IDEMPOTENCY", "LIFECYCLE", "TERMINAL_PROOF",
] as const);

export type ExpansionHoldCause = (typeof EXPANSION_HOLD_CAUSES)[number];
export type ExpansionHoldErrorCode = (typeof EXPANSION_HOLD_ERROR_CODES)[number];
export type ExpansionHoldLayer = (typeof EXPANSION_HOLD_LAYERS)[number];
export type ExpansionHoldLifecycle = (typeof RUNTIME_LIFECYCLES.PLANNING_HOLD)[number];

export interface ExpansionHandoffBinding { readonly digest: string; readonly ref: string }
export interface ExpansionReleaseEvidence {
  readonly attemptRef: string; readonly attemptState: string;
  readonly disposition: { readonly resumable: boolean; readonly strongestReason: string; readonly terminalTarget: string };
  readonly effectsTerminal: boolean; readonly handoff: ExpansionHandoffBinding;
  readonly leaseRef: string; readonly leaseState: string; readonly observationRef: string;
  readonly providerSlotRef: string; readonly providerSlotState: string; readonly reason: string;
  readonly receiptRef: string; readonly resourcesTerminal: boolean; readonly safeBoundaryObserved: boolean;
  readonly terminalEffectRefs: readonly string[]; readonly terminalResourceRefs: readonly string[];
  readonly truthClass: RuntimeTruthClass;
}
export interface ExpansionTerminalProof {
  readonly authorityState: "TERMINAL" | "LIVE" | "DRAINING";
  readonly decisionRef: string; readonly successorHoldRef: string | null;
  readonly truthClass: RuntimeTruthClass;
}
export interface CreateExpansionHoldCommand {
  readonly commandId: string; readonly deadline: number; readonly expectedVersion: number;
  readonly generation: number; readonly graphEpoch: number; readonly holdId: string;
  readonly kind: "graph.request_expansion"; readonly parentNodeRef: string;
  readonly parentRevisionRef: string; readonly parentRunRef: string; readonly planningRunRef: string;
  readonly proposalBaseHash: string;
  readonly rationale: { readonly text: string; readonly truthClass: "AGENT_REPORTED" };
  readonly release: ExpansionReleaseEvidence; readonly sourceFingerprint: string;
  readonly workerHandoff: ExpansionHandoffBinding;
}
export interface TransitionExpansionHoldCommand {
  readonly cause: ExpansionHoldCause; readonly commandId: string; readonly expectedVersion: number;
  readonly generation: number; readonly graphEpoch: number; readonly holdId: string;
  readonly kind: "expansion.transition_hold"; readonly parentNodeRef: string;
  readonly parentRevisionRef: string; readonly parentRunRef: string; readonly planningRunRef: string;
  readonly proposalBaseHash: string; readonly sourceFingerprint: string;
  readonly targetLifecycle: ExpansionHoldLifecycle; readonly terminalProof: ExpansionTerminalProof | null;
}
export type ExpansionPlanningHoldCommand = CreateExpansionHoldCommand | TransitionExpansionHoldCommand;
export interface ExpansionPlanningHoldState {
  readonly creationReceipt: { readonly command: CreateExpansionHoldCommand };
  readonly deadline: number; readonly generation: number; readonly graphEpoch: number;
  readonly holdId: string; readonly holdKind: "EXPANSION_PLANNING"; readonly lifecycle: ExpansionHoldLifecycle;
  readonly parentNodeRef: string; readonly parentRevisionRef: string; readonly parentRunRef: string;
  readonly planningRunRef: string; readonly proposalBaseHash: string;
  readonly rationale: CreateExpansionHoldCommand["rationale"]; readonly release: ExpansionReleaseEvidence;
  readonly sourceFingerprint: string;
  readonly terminalReceipt: { readonly command: TransitionExpansionHoldCommand } | null;
  readonly version: number; readonly workerHandoff: ExpansionHandoffBinding;
}
export type ExpansionPlanningHoldEvent =
  | { readonly commandId: string; readonly holdId: string; readonly kind: "EXPANSION_HOLD_CREATED"; readonly lifecycle: "ACTIVE"; readonly version: 1 }
  | { readonly cause: ExpansionHoldCause; readonly commandId: string; readonly holdId: string; readonly kind: "EXPANSION_HOLD_TERMINATED"; readonly lifecycle: Exclude<ExpansionHoldLifecycle, "ACTIVE">; readonly version: 2 };
export type ExpansionPlanningHoldResult =
  | { readonly event: ExpansionPlanningHoldEvent; readonly ok: true; readonly state: ExpansionPlanningHoldState }
  | { readonly code: ExpansionHoldErrorCode; readonly layer: ExpansionHoldLayer; readonly ok: false; readonly state: ExpansionPlanningHoldState | null };

const INVALID = Symbol("invalid");
const MAX_TEXT = 256; const MAX_REFS = 32;
const HEX64 = /^[0-9a-f]{64}$/u;
const TRUTHS: readonly string[] = RUNTIME_LIFECYCLES.TRUTH_CLASS; const LIFECYCLES: readonly string[] = RUNTIME_LIFECYCLES.PLANNING_HOLD;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function snapshot(value: unknown, seen = new WeakSet<object>()): unknown | typeof INVALID {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value !== "object" || seen.has(value)) return INVALID;
  seen.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return INVALID;
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_REFS) return INVALID;
      const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
      if (keys.length !== length) return INVALID;
      const copy: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        if (property === undefined || !property.enumerable || !("value" in property)) return INVALID;
        const nested = snapshot(property.value, seen); if (nested === INVALID) return INVALID; copy.push(nested);
      }
      return copy;
    }
    if (prototype !== Object.prototype && prototype !== null) return INVALID;
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return INVALID;
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property === undefined || !property.enumerable || !("value" in property)) return INVALID;
      const nested = snapshot(property.value, seen); if (nested === INVALID) return INVALID; copy[key] = nested;
    }
    return copy;
  } catch { return INVALID; } finally { seen.delete(value); }
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
    ? value as Record<string, unknown> : null;
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT; }
function hex64(value: unknown): value is string { return typeof value === "string" && HEX64.test(value); }
function uint(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function member(values: readonly string[], value: unknown): value is string { return typeof value === "string" && values.includes(value); }
function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_REFS || value.some((item) => !text(item))) return null;
  return value as readonly string[];
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function handoff(value: unknown): ExpansionHandoffBinding | null {
  const item = record(value, ["digest", "ref"]);
  return item !== null && hex64(item["digest"]) && text(item["ref"])
    ? { digest: item["digest"] as string, ref: item["ref"] } : null;
}
function release(value: unknown): ExpansionReleaseEvidence | null {
  const item = record(value, [
    "attemptRef", "attemptState", "disposition", "effectsTerminal", "handoff", "leaseRef",
    "leaseState", "observationRef", "providerSlotRef", "providerSlotState", "reason", "receiptRef",
    "resourcesTerminal", "safeBoundaryObserved", "terminalEffectRefs", "terminalResourceRefs", "truthClass",
  ]);
  const disposition = item && record(item["disposition"], ["resumable", "strongestReason", "terminalTarget"]);
  const boundHandoff = item && handoff(item["handoff"]);
  const effectRefs = item && stringList(item["terminalEffectRefs"]);
  const resourceRefs = item && stringList(item["terminalResourceRefs"]);
  if (!item || !disposition || !boundHandoff || !effectRefs || !resourceRefs) return null;
  const strings = ["attemptRef", "attemptState", "leaseRef", "leaseState", "observationRef", "providerSlotRef", "providerSlotState", "reason", "receiptRef"];
  if (!strings.every((key) => text(item[key])) || !text(disposition["strongestReason"]) || !text(disposition["terminalTarget"])) return null;
  if (!["effectsTerminal", "resourcesTerminal", "safeBoundaryObserved"].every((key) => typeof item[key] === "boolean") || typeof disposition["resumable"] !== "boolean" || !member(TRUTHS, item["truthClass"])) return null;
  return { ...item, disposition, handoff: boundHandoff, terminalEffectRefs: effectRefs, terminalResourceRefs: resourceRefs } as unknown as ExpansionReleaseEvidence;
}
function proof(value: unknown): ExpansionTerminalProof | null | typeof INVALID {
  if (value === null) return null;
  const item = record(value, ["authorityState", "decisionRef", "successorHoldRef", "truthClass"]);
  if (!item || !member(["TERMINAL", "LIVE", "DRAINING"], item["authorityState"]) || !text(item["decisionRef"]) || !(item["successorHoldRef"] === null || text(item["successorHoldRef"])) || !member(TRUTHS, item["truthClass"])) return INVALID;
  return item as unknown as ExpansionTerminalProof;
}

const CREATE_KEYS = ["commandId", "deadline", "expectedVersion", "generation", "graphEpoch", "holdId", "kind", "parentNodeRef", "parentRevisionRef", "parentRunRef", "planningRunRef", "proposalBaseHash", "rationale", "release", "sourceFingerprint", "workerHandoff"];
const TRANSITION_KEYS = ["cause", "commandId", "expectedVersion", "generation", "graphEpoch", "holdId", "kind", "parentNodeRef", "parentRevisionRef", "parentRunRef", "planningRunRef", "proposalBaseHash", "sourceFingerprint", "targetLifecycle", "terminalProof"];
function parseCommand(value: unknown): ExpansionPlanningHoldCommand | null {
  const copied = snapshot(value);
  if (copied === INVALID || copied === null || typeof copied !== "object" || Array.isArray(copied)) return null;
  const base = copied as Record<string, unknown>;
  if (base["kind"] === "graph.request_expansion") {
    const item = record(base, CREATE_KEYS); if (!item) return null;
    const rationale = record(item["rationale"], ["text", "truthClass"]);
    const released = release(item["release"]); const workerHandoff = handoff(item["workerHandoff"]);
    const refs = ["commandId", "holdId", "parentNodeRef", "parentRevisionRef", "parentRunRef", "planningRunRef"];
    if (!refs.every((key) => text(item[key])) || !uint(item["deadline"]) || !uint(item["expectedVersion"]) || !positive(item["generation"]) || !uint(item["graphEpoch"]) || !hex64(item["proposalBaseHash"]) || !hex64(item["sourceFingerprint"]) || !rationale || !text(rationale["text"]) || rationale["truthClass"] !== "AGENT_REPORTED" || !released || !workerHandoff) return null;
    return { ...item, rationale, release: released, workerHandoff } as unknown as CreateExpansionHoldCommand;
  }
  if (base["kind"] === "expansion.transition_hold") {
    const item = record(base, TRANSITION_KEYS); if (!item) return null;
    const terminalProof = proof(item["terminalProof"]);
    const refs = ["commandId", "holdId", "parentNodeRef", "parentRevisionRef", "parentRunRef", "planningRunRef"];
    if (!refs.every((key) => text(item[key])) || !uint(item["expectedVersion"]) || !positive(item["generation"]) || !uint(item["graphEpoch"]) || !hex64(item["proposalBaseHash"]) || !hex64(item["sourceFingerprint"]) || !member(EXPANSION_HOLD_CAUSES, item["cause"]) || !member(LIFECYCLES, item["targetLifecycle"]) || terminalProof === INVALID) return null;
    return { ...item, terminalProof } as unknown as TransitionExpansionHoldCommand;
  }
  return null;
}

const STATE_KEYS = ["creationReceipt", "deadline", "generation", "graphEpoch", "holdId", "holdKind", "lifecycle", "parentNodeRef", "parentRevisionRef", "parentRunRef", "planningRunRef", "proposalBaseHash", "rationale", "release", "sourceFingerprint", "terminalReceipt", "version", "workerHandoff"];
function opening(command: CreateExpansionHoldCommand): ExpansionPlanningHoldState {
  return { creationReceipt: { command }, deadline: command.deadline, generation: command.generation,
    graphEpoch: command.graphEpoch, holdId: command.holdId, holdKind: "EXPANSION_PLANNING", lifecycle: "ACTIVE",
    parentNodeRef: command.parentNodeRef, parentRevisionRef: command.parentRevisionRef,
    parentRunRef: command.parentRunRef, planningRunRef: command.planningRunRef,
    proposalBaseHash: command.proposalBaseHash, rationale: command.rationale, release: command.release,
    sourceFingerprint: command.sourceFingerprint, terminalReceipt: null, version: 1,
    workerHandoff: command.workerHandoff };
}
function bindingsMatch(state: ExpansionPlanningHoldState, command: TransitionExpansionHoldCommand): boolean {
  return state.holdId === command.holdId && state.generation === command.generation && state.graphEpoch === command.graphEpoch
    && state.parentNodeRef === command.parentNodeRef && state.parentRunRef === command.parentRunRef
    && state.parentRevisionRef === command.parentRevisionRef && state.planningRunRef === command.planningRunRef
    && state.proposalBaseHash === command.proposalBaseHash && state.sourceFingerprint === command.sourceFingerprint;
}
function safeRelease(command: CreateExpansionHoldCommand): boolean {
  const value = command.release;
  return value.truthClass === "DAEMON_VERIFIED" && value.reason === "WORK_RELEASE_OR_PAUSE"
    && value.safeBoundaryObserved && value.attemptState === "RELEASED" && value.leaseState === "RELEASED"
    && value.providerSlotState === "RELEASED" && value.effectsTerminal && value.resourcesTerminal
    && value.disposition.strongestReason === "WORK_RELEASE_OR_PAUSE" && value.disposition.terminalTarget === "RELEASED"
    && value.disposition.resumable && same(value.handoff, command.workerHandoff);
}
function parseState(value: unknown): ExpansionPlanningHoldState | null {
  const copied = snapshot(value); if (copied === INVALID) return null;
  const item = record(copied, STATE_KEYS); if (!item || item["holdKind"] !== "EXPANSION_PLANNING" || !member(LIFECYCLES, item["lifecycle"]) || !positive(item["version"])) return null;
  const creationReceipt = record(item["creationReceipt"], ["command"]);
  const created = creationReceipt && parseCommand(creationReceipt["command"]);
  if (!created || created.kind !== "graph.request_expansion" || created.expectedVersion !== 0 || !safeRelease(created)) return null;
  const expected = opening(created);
  const openingKeys = STATE_KEYS.filter((key) => !["lifecycle", "terminalReceipt", "version"].includes(key));
  if (!openingKeys.every((key) => same(item[key], (expected as unknown as Record<string, unknown>)[key]))) return null;
  if (item["lifecycle"] === "ACTIVE") return item["terminalReceipt"] === null && item["version"] === 1 ? { ...expected } : null;
  const terminalReceipt = record(item["terminalReceipt"], ["command"]);
  const terminal = terminalReceipt && parseCommand(terminalReceipt["command"]);
  if (!terminal || terminal.kind !== "expansion.transition_hold" || item["version"] !== 2
    || terminal.expectedVersion !== 1 || terminal.commandId === created.commandId
    || terminal.targetLifecycle !== item["lifecycle"] || !causeTarget(terminal)
    || !bindingsMatch(expected, terminal) || !terminalProofValid(terminal)) return null;
  return { ...expected, lifecycle: item["lifecycle"] as ExpansionHoldLifecycle,
    terminalReceipt: { command: terminal }, version: 2 };
}

const CODE_LAYERS: Readonly<Record<ExpansionHoldErrorCode, ExpansionHoldLayer>> = {
  EXPANSION_HOLD_BINDING_MISMATCH: "BINDING", EXPANSION_HOLD_IDEMPOTENCY_CONFLICT: "IDEMPOTENCY",
  EXPANSION_HOLD_ILLEGAL_TRANSITION: "LIFECYCLE", EXPANSION_HOLD_INPUT_INVALID: "INPUT",
  EXPANSION_HOLD_SAFE_BOUNDARY_UNPROVEN: "SAFE_BOUNDARY", EXPANSION_HOLD_STALE_EPOCH: "CONCURRENCY",
  EXPANSION_HOLD_STALE_GENERATION: "CONCURRENCY", EXPANSION_HOLD_STALE_VERSION: "CONCURRENCY",
  EXPANSION_HOLD_TERMINAL_PROOF_REQUIRED: "TERMINAL_PROOF",
};
function refuse(code: ExpansionHoldErrorCode, state: ExpansionPlanningHoldState | null): ExpansionPlanningHoldResult {
  return deepFreeze({ code, layer: CODE_LAYERS[code], ok: false as const, state });
}
function created(state: ExpansionPlanningHoldState): ExpansionPlanningHoldResult {
  const active = opening(state.creationReceipt.command);
  return deepFreeze({ event: { commandId: active.creationReceipt.command.commandId, holdId: active.holdId,
    kind: "EXPANSION_HOLD_CREATED" as const, lifecycle: "ACTIVE" as const, version: 1 as const },
    ok: true as const, state: active });
}
function causeTarget(command: TransitionExpansionHoldCommand): boolean {
  const resolved = command.cause === "EXPANSION_REFUSED" || command.cause === "GRAPH_ACTIVATED";
  const superseded = command.cause === "REVISE_PLAN" || command.cause === "GRAPH_SUPERSEDED";
  return (resolved && command.targetLifecycle === "RESOLVED") || (superseded && command.targetLifecycle === "SUPERSEDED")
    || (!resolved && !superseded && command.targetLifecycle === "CANCELLED");
}
function terminalProofValid(command: TransitionExpansionHoldCommand): boolean {
  const value = command.terminalProof; if (!value || value.authorityState !== "TERMINAL") return false;
  const human = command.cause === "REVISE_PLAN" || command.cause === "EXPANSION_DECLINED";
  if (value.truthClass !== (human ? "HUMAN_APPROVED" : "DAEMON_VERIFIED")) return false;
  return command.targetLifecycle === "SUPERSEDED" ? text(value.successorHoldRef) : value.successorHoldRef === null;
}

export function reduceExpansionPlanningHold(
  stateInput: ExpansionPlanningHoldState | undefined,
  commandInput: unknown,
): ExpansionPlanningHoldResult {
  const state = stateInput === undefined ? null : parseState(stateInput);
  const command = parseCommand(commandInput);
  if (!command || (stateInput !== undefined && !state)) return refuse("EXPANSION_HOLD_INPUT_INVALID", state);
  if (state) {
    const receipts = [state.creationReceipt.command, state.terminalReceipt?.command].filter((item) => item !== undefined);
    const replay = receipts.find((item) => item.commandId === command.commandId);
    if (replay) {
      if (!same(replay, command)) return refuse("EXPANSION_HOLD_IDEMPOTENCY_CONFLICT", state);
      return command.kind === "graph.request_expansion" ? created(state) : deepFreeze({
        event: { cause: command.cause, commandId: command.commandId, holdId: state.holdId,
          kind: "EXPANSION_HOLD_TERMINATED" as const, lifecycle: command.targetLifecycle as Exclude<ExpansionHoldLifecycle, "ACTIVE">, version: 2 as const },
        ok: true as const, state,
      });
    }
  }
  if (!state) {
    if (command.expectedVersion !== 0) return refuse("EXPANSION_HOLD_STALE_VERSION", null);
    if (command.kind !== "graph.request_expansion") return refuse("EXPANSION_HOLD_ILLEGAL_TRANSITION", null);
    if (!safeRelease(command)) return refuse("EXPANSION_HOLD_SAFE_BOUNDARY_UNPROVEN", null);
    return created(opening(command));
  }
  if (command.expectedVersion !== state.version) return refuse("EXPANSION_HOLD_STALE_VERSION", state);
  if (command.generation !== state.generation) return refuse("EXPANSION_HOLD_STALE_GENERATION", state);
  if (command.graphEpoch !== state.graphEpoch) return refuse("EXPANSION_HOLD_STALE_EPOCH", state);
  if (state.lifecycle !== "ACTIVE" || command.kind !== "expansion.transition_hold" || !causeTarget(command)) return refuse("EXPANSION_HOLD_ILLEGAL_TRANSITION", state);
  if (!bindingsMatch(state, command)) return refuse("EXPANSION_HOLD_BINDING_MISMATCH", state);
  if (!terminalProofValid(command)) return refuse("EXPANSION_HOLD_TERMINAL_PROOF_REQUIRED", state);
  const lifecycle = command.targetLifecycle as Exclude<ExpansionHoldLifecycle, "ACTIVE">;
  const next: ExpansionPlanningHoldState = { ...state, lifecycle, terminalReceipt: { command }, version: 2 };
  return deepFreeze({ event: { cause: command.cause, commandId: command.commandId, holdId: state.holdId,
    kind: "EXPANSION_HOLD_TERMINATED" as const, lifecycle, version: 2 as const }, ok: true as const, state: next });
}
