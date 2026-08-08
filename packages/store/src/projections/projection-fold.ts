import {
  EVENT_RECORD_VERSION, OPAQUE_PAYLOAD_CODEC_VERSION, type StoredEvent,
} from "../store-contracts.js";
import type { StoredEventUpcaster, UpcastFailure, UpcastOutcome } from "./projection-upcast.js";

/**
 * Pure projection fold: preflight a batch, upcast each stored event to its current domain
 * schema version, then reduce it into recursively plain state. A function over in-memory
 * values only — no storage engine, no clock, no randomness, no I/O. Every refusal names a
 * stable code AND the refusing layer, and echoes the caller's unchanged state and
 * checkpoint, so a part-way failure never leaves partially folded state behind.
 */

export type PlainValue = bigint | boolean | null | number | string
  | readonly PlainValue[] | { readonly [key: string]: PlainValue };
export type ProjectionState = { readonly [key: string]: PlainValue };
export interface ProjectionCheckpoint { readonly globalPosition: bigint; }
export type ProjectionReducer = (state: ProjectionState, event: StoredEvent) => ProjectionState;
export type ProjectionFoldLayer = "INPUT" | "REDUCER" | "UPCAST";
export type ProjectionFoldCode =
  | "PROJECTION_FOLD_DUPLICATE_EVENT" | "PROJECTION_FOLD_INPUT_INVALID"
  | "PROJECTION_FOLD_OUT_OF_ORDER" | "PROJECTION_FOLD_REDUCER_FAILED"
  | "PROJECTION_FOLD_REDUCER_MISSING" | "PROJECTION_FOLD_STALE_POSITION"
  | "PROJECTION_FOLD_STATE_INVALID" | "PROJECTION_FOLD_UPCAST_REFUSED";

export interface ProjectionFoldInput {
  readonly checkpoint: ProjectionCheckpoint;
  readonly events: readonly StoredEvent[];
  /** Keyed by eventType; an unlisted type is refused, never silently skipped. */
  readonly reducers: Readonly<Record<string, ProjectionReducer>>;
  readonly state: ProjectionState;
  readonly upcaster: StoredEventUpcaster;
}
export interface ProjectionFolded {
  readonly checkpoint: ProjectionCheckpoint; readonly ok: true; readonly state: ProjectionState;
}
export interface ProjectionFoldRefusal {
  readonly checkpoint: ProjectionCheckpoint; readonly code: ProjectionFoldCode;
  readonly detail: string; readonly eventId: string | null;
  readonly layer: ProjectionFoldLayer; readonly ok: false;
  readonly state: ProjectionState; readonly upcast: UpcastFailure | null;
}
export type ProjectionFoldResult = ProjectionFolded | ProjectionFoldRefusal;

type FieldKind = "bigint" | "bytes" | "number" | "string";
type Issue = Omit<ProjectionFoldRefusal, "checkpoint" | "ok" | "state">;
const FIELD_KINDS: Readonly<Record<string, FieldKind>> = {
  aggregateId: "string", aggregateSequence: "number", commandId: "string",
  committedAt: "string", domainSchemaVersion: "string", eventId: "string",
  eventType: "string", globalPosition: "bigint", metadata: "bytes", payload: "bytes",
  payloadCodecVersion: "string", recordVersion: "string", requestSha256: "string",
};
const INVALID = Symbol("projection-fold-invalid");
/** Echoed only when the supplied state or checkpoint is itself unrepresentable. */
const EMPTY_STATE: ProjectionState = Object.freeze({});
const ORIGIN: ProjectionCheckpoint = Object.freeze({ globalPosition: 0n });

function deny(code: ProjectionFoldCode, layer: ProjectionFoldLayer, eventId: string | null,
  detail: string, upcast: UpcastFailure | null = null): Issue {
  return { code, detail, eventId, layer, upcast };
}

function refuse(issue: Issue, state: ProjectionState,
  checkpoint: ProjectionCheckpoint): ProjectionFoldRefusal {
  return Object.freeze({ ...issue, checkpoint, ok: false as const, state });
}

/** Reads through a data descriptor, so an accessor is refused rather than invoked. */
function dataOf(source: object, key: PropertyKey): PropertyDescriptor | null {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor : null;
}

/** Deep-copies and freezes plain data, refusing class instances, functions, symbol
 *  keys, `__proto__` keys, array holes, extra array properties, and cycles. */
function plainClone(value: unknown, path: Set<object>): unknown {
  if (value === null) { return null; }
  const kind = typeof value;
  const scalar = kind === "bigint" || kind === "boolean" || kind === "number" || kind === "string";
  if (scalar || kind !== "object") { return scalar ? value : INVALID; }
  const source = value as object;
  const isArray = Array.isArray(source);
  const prototype = Object.getPrototypeOf(source) as unknown;
  const alien = prototype !== null && prototype !== (isArray ? Array.prototype : Object.prototype);
  if (alien || path.has(source)) { return INVALID; }
  const own = Reflect.ownKeys(source);
  const keys = isArray ? own.slice(0, -1) : own;
  const shaped = own.at(-1) === "length" && keys.length === (source as unknown[]).length;
  if (isArray && !shaped) { return INVALID; }
  path.add(source);
  const items: unknown[] = [];
  for (const key of keys) {
    const slot = typeof key === "string" && key !== "__proto__" ? dataOf(source, key) : null;
    const item = slot === null ? INVALID : plainClone(slot.value, path);
    if (item === INVALID) { path.delete(source); return INVALID; }
    items.push(item);
  }
  path.delete(source);
  if (isArray) { return Object.freeze(items); }
  const draft: Record<string, unknown> = {};
  keys.forEach((key, index) => { draft[key as string] = items[index]; });
  return Object.freeze(draft);
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  const clone = plainClone(value, new Set());
  const bad = clone === INVALID || typeof clone !== "object" || clone === null ||
    Array.isArray(clone);
  return bad ? null : (clone as Record<string, unknown>);
}

/** Rebuilds the event from captured values, so a proxy or accessor cannot show a
 *  reducer anything other than what preflight actually validated. */
function normalizeEvent(raw: StoredEvent): StoredEvent | null {
  if (typeof raw !== "object" || raw === null) { return null; }
  const draft: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== "string") { return null; }
    if (!Object.hasOwn(FIELD_KINDS, key) && key !== "decisionTrace") { return null; }
    const slot = dataOf(raw, key);
    if (slot === null) { return null; }
    draft[key] = slot.value;
  }
  for (const [key, kind] of Object.entries(FIELD_KINDS)) {
    const value = draft[key];
    if (kind !== "bytes") { if (typeof value !== kind) { return null; } continue; }
    if (!(value instanceof Uint8Array)) { return null; }
    draft[key] = new Uint8Array(value);
  }
  const sequence = draft["aggregateSequence"] as number;
  if (draft["payloadCodecVersion"] !== OPAQUE_PAYLOAD_CODEC_VERSION ||
      draft["recordVersion"] !== EVENT_RECORD_VERSION || !Number.isSafeInteger(sequence) ||
      sequence < 0 || (draft["globalPosition"] as bigint) < 0n) { return null; }
  if ("decisionTrace" in draft) {
    const trace = plainRecord(draft["decisionTrace"]);
    if (trace === null) { return null; }
    draft["decisionTrace"] = trace;
  }
  return Object.freeze(draft) as unknown as StoredEvent;
}

function normalizeCheckpoint(value: ProjectionCheckpoint): ProjectionCheckpoint | null {
  if (typeof value !== "object" || value === null) { return null; }
  const slot = dataOf(value, "globalPosition");
  if (Reflect.ownKeys(value).length !== 1 || slot === null ||
      typeof slot.value !== "bigint" || slot.value < 0n) { return null; }
  return Object.freeze({ globalPosition: slot.value });
}

/** Whole-batch gate: every ordering rule is decided before any reducer runs, so a refused
 *  batch cannot have folded its leading events. Sequences strictly increase per aggregate
 *  but need not be contiguous or start at one — an incremental page begins midstream. */
function preflight(events: readonly StoredEvent[], checkpoint: ProjectionCheckpoint,
  ready: StoredEvent[]): Issue | null {
  const eventIds = new Set<string>();
  const sequences = new Map<string, number>();
  const mark = checkpoint.globalPosition;
  let position = mark;
  for (const raw of events) {
    const event = normalizeEvent(raw);
    if (event === null) {
      return deny("PROJECTION_FOLD_INPUT_INVALID", "INPUT", null, "event is not plain event data");
    }
    const { aggregateId, aggregateSequence, eventId, globalPosition } = event;
    const seen = sequences.get(aggregateId);
    if (globalPosition <= mark) {
      return deny("PROJECTION_FOLD_STALE_POSITION", "INPUT", eventId,
        `position ${globalPosition} is at or below checkpoint ${mark}`);
    }
    if (globalPosition <= position) {
      return deny("PROJECTION_FOLD_OUT_OF_ORDER", "INPUT", eventId,
        `position ${globalPosition} does not exceed ${position}`);
    }
    if (eventIds.has(eventId)) {
      return deny("PROJECTION_FOLD_DUPLICATE_EVENT", "INPUT", eventId, "eventId repeats");
    }
    if (seen !== undefined && aggregateSequence <= seen) {
      return deny(aggregateSequence === seen
        ? "PROJECTION_FOLD_DUPLICATE_EVENT" : "PROJECTION_FOLD_OUT_OF_ORDER", "INPUT", eventId,
      `${aggregateId} sequence ${aggregateSequence} follows ${seen}`);
    }
    eventIds.add(eventId);
    sequences.set(aggregateId, aggregateSequence);
    position = globalPosition;
    ready.push(event);
  }
  return null;
}

/** `StoredEvent` carries no `code`, so the caller discriminates the pair with `in`. */
function upcastOne(upcaster: StoredEventUpcaster, event: StoredEvent): StoredEvent | Issue {
  let outcome: UpcastOutcome;
  try {
    outcome = upcaster.upcast(event);
  } catch {
    return deny("PROJECTION_FOLD_UPCAST_REFUSED", "UPCAST", event.eventId, "upcaster threw");
  }
  return outcome.ok ? outcome.event : deny("PROJECTION_FOLD_UPCAST_REFUSED", "UPCAST",
    event.eventId, `${outcome.failure.code} at ${outcome.failure.fromVersion}`, outcome.failure);
}

/** Upcast then reduce one event at a time, abandoning the whole batch on the first
 *  refusal — `start` is what every failure echoes, never a partial fold. */
function reduceAll(ready: readonly StoredEvent[], start: ProjectionState,
  point: ProjectionCheckpoint, request: ProjectionFoldInput): ProjectionFoldResult {
  let state = start;
  for (const event of ready) {
    const current = upcastOne(request.upcaster, event);
    if ("code" in current) { return refuse(current, start, point); }
    const { eventId, eventType } = current;
    const bad = (code: ProjectionFoldCode, detail: string): ProjectionFoldRefusal =>
      refuse(deny(code, "REDUCER", eventId, detail), start, point);
    const reducer = Object.hasOwn(request.reducers, eventType)
      ? request.reducers[eventType] : undefined;
    if (typeof reducer !== "function") {
      return bad("PROJECTION_FOLD_REDUCER_MISSING", `no reducer for ${eventType}`);
    }
    let next: Record<string, unknown> | null;
    try {
      next = plainRecord(reducer(state, current));
    } catch {
      return bad("PROJECTION_FOLD_REDUCER_FAILED", `the ${eventType} reducer threw`);
    }
    if (next === null) { return bad("PROJECTION_FOLD_STATE_INVALID", "state is not plain data"); }
    state = next as ProjectionState;
  }
  const last = ready.at(-1);
  const at = last === undefined ? point : Object.freeze({ globalPosition: last.globalPosition });
  return Object.freeze({ checkpoint: at, ok: true as const, state });
}

export function foldProjection(request: ProjectionFoldInput): ProjectionFoldResult {
  const ready: StoredEvent[] = [];
  let start: Record<string, unknown> | null = null;
  let point: ProjectionCheckpoint | null = null;
  let issue: Issue | null = null;
  try {
    start = plainRecord(request.state);
    point = normalizeCheckpoint(request.checkpoint);
    if (typeof request.reducers !== "object" || request.reducers === null ||
        typeof request.upcaster?.upcast !== "function") { start = null; }
    issue = start === null || point === null ? null : preflight(request.events, point, ready);
  } catch { start = null; }
  if (start === null || point === null) {
    return refuse(deny("PROJECTION_FOLD_INPUT_INVALID", "INPUT", null,
      "state, checkpoint, batch, or wiring is not usable"), EMPTY_STATE, ORIGIN);
  }
  const base = start as ProjectionState;
  return issue === null ? reduceAll(ready, base, point, request) : refuse(issue, base, point);
}
