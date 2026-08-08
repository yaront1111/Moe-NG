import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import {
  EVENT_RECORD_VERSION, OPAQUE_PAYLOAD_CODEC_VERSION, type StoredEvent,
} from "../store-contracts.js";
import { compileStoredEventUpcaster } from "./projection-upcast.js";
import {
  foldProjection, type ProjectionFoldInput, type ProjectionFoldResult, type ProjectionReducer,
  type ProjectionState,
} from "./projection-fold.js";

const CHECKPOINT = { globalPosition: 5n } as const;
const START: ProjectionState = { total: 0, versions: [] };
type Recorder = { readonly reducers: Readonly<Record<string, ProjectionReducer>>;
  readonly seen: string[] };

function storedEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    aggregateId: "goal-1", aggregateSequence: 1, commandId: "cmd-1",
    committedAt: "2026-08-08T00:00:00.000Z", domainSchemaVersion: "v2", eventId: "evt-1",
    eventType: "Counted", globalPosition: 10n, metadata: new Uint8Array([7]),
    payload: new Uint8Array([1]), payloadCodecVersion: OPAQUE_PAYLOAD_CODEC_VERSION,
    recordVersion: EVENT_RECORD_VERSION, requestSha256: "b".repeat(64), ...overrides,
  };
}

function evt(eventId: string, globalPosition: bigint, aggregateSequence: number,
  overrides: Partial<StoredEvent> = {}): StoredEvent {
  return storedEvent({ aggregateSequence, eventId, globalPosition, ...overrides });
}

/** v1 payloads gain 10, so a bypassed upcaster changes every folded total. */
const upcaster = compileStoredEventUpcaster([{
  currentVersion: "v2", eventType: "Counted",
  routes: [{ fromVersion: "v1", toVersion: "v2",
    handler: ({ metadata, payload }) => ({
      metadata, payload: new Uint8Array([(payload[0] ?? 0) + 10]) }) }],
}]);

function recorder(body?: ProjectionReducer): Recorder {
  const seen: string[] = [];
  const accumulate: ProjectionReducer = (state, event) => ({
    total: (state["total"] as number) + (event.payload[0] ?? 0),
    versions: [...(state["versions"] as readonly string[]), event.domainSchemaVersion] });
  const reducer: ProjectionReducer = (state, event) =>
    (seen.push(event.eventId), (body ?? accumulate)(state, event));
  return { reducers: { Counted: reducer }, seen };
}

function fold(events: readonly StoredEvent[],
  overrides: Partial<ProjectionFoldInput> = {}): ProjectionFoldResult {
  return foldProjection({
    checkpoint: CHECKPOINT, events, reducers: recorder().reducers, state: START, upcaster,
    ...overrides,
  });
}

function ok(result: ProjectionFoldResult): Extract<ProjectionFoldResult, { ok: true }> {
  if (!result.ok) { throw new Error(`expected a fold, got ${result.code}`); } return result;
}

function refused(result: ProjectionFoldResult): Extract<ProjectionFoldResult, { ok: false }> {
  if (result.ok) { throw new Error("expected a refusal, got a fold"); } return result;
}

const PAIR = (): readonly StoredEvent[] => [evt("evt-1", 10n, 1),
  evt("evt-2", 11n, 2, { payload: new Uint8Array([4]) })];

it("folds an ordered batch into frozen plain state and advances the checkpoint", () => {
  const result = ok(fold(PAIR()));
  expect(result.state).toEqual({ total: 5, versions: ["v2", "v2"] });
  expect(result.checkpoint).toEqual({ globalPosition: 11n });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.state)).toBe(true);
  expect(Object.isFrozen(result.state["versions"])).toBe(true);
});

it("returns deep-equal frozen state when the same batch is folded twice", () => {
  const [first, second] = [ok(fold(PAIR())), ok(fold(PAIR()))];
  expect([second.state, second.checkpoint]).toEqual([first.state, first.checkpoint]);
});

it("accepts an empty batch as a no-op that keeps the checkpoint and state", () => {
  const result = ok(fold([]));
  expect([result.checkpoint, result.state]).toEqual([{ globalPosition: 5n }, START]);
});

it("refuses an event at or below the supplied checkpoint before any reducer runs", () => {
  const seat = recorder();
  const at = refused(fold([evt("evt-1", 5n, 1)], { reducers: seat.reducers }));
  const below = refused(fold([evt("evt-1", 4n, 1)], { reducers: seat.reducers }));
  expect(at.code).toBe("PROJECTION_FOLD_STALE_POSITION");
  expect(at.layer).toBe("INPUT");
  expect(below.code).toBe("PROJECTION_FOLD_STALE_POSITION");
  expect(seat.seen).toEqual([]);
});

it("refuses a batch whose global positions do not strictly increase", () => {
  const seat = recorder();
  const events = [evt("evt-1", 11n, 1), evt("evt-2", 11n, 2)];
  const result = refused(fold(events, { reducers: seat.reducers }));
  expect(result.code).toBe("PROJECTION_FOLD_OUT_OF_ORDER");
  expect(result.layer).toBe("INPUT");
  expect(result.eventId).toBe("evt-2");
  expect(seat.seen).toEqual([]);
});

it("refuses a repeated eventId within the batch", () => {
  const seat = recorder();
  const events = [evt("evt-1", 10n, 1), evt("evt-1", 11n, 2)];
  const result = refused(fold(events, { reducers: seat.reducers }));
  expect(result.code).toBe("PROJECTION_FOLD_DUPLICATE_EVENT");
  expect(result.layer).toBe("INPUT");
  expect(seat.seen).toEqual([]);
});

it("refuses an equal per-aggregate sequence carried by a different eventId", () => {
  const seat = recorder();
  const events = [evt("evt-1", 10n, 7), evt("evt-2", 11n, 7)];
  const result = refused(fold(events, { reducers: seat.reducers }));
  expect(result.code).toBe("PROJECTION_FOLD_DUPLICATE_EVENT");
  expect(result.eventId).toBe("evt-2");
  expect(seat.seen).toEqual([]);
});

it("refuses a lower per-aggregate sequence when two aggregates interleave", () => {
  const seat = recorder();
  const events = [evt("evt-1", 10n, 5), evt("evt-2", 11n, 1, { aggregateId: "goal-2" }),
    evt("evt-3", 12n, 4)];
  const result = refused(fold(events, { reducers: seat.reducers }));
  expect(result.code).toBe("PROJECTION_FOLD_OUT_OF_ORDER");
  expect(result.eventId).toBe("evt-3");
  expect(seat.seen).toEqual([]);
});

it("folds a batch that starts midstream at sequence 7 with no prior context", () => {
  const result = ok(fold([evt("evt-1", 40n, 7), evt("evt-2", 44n, 9)]));
  expect(result.checkpoint).toEqual({ globalPosition: 44n });
  expect(result.state["total"]).toBe(2);
});

it("upcasts every event before its reducer sees it", () => {
  const stale = evt("evt-1", 10n, 1, { domainSchemaVersion: "v1" });
  const result = ok(fold([stale]));
  expect(result.state).toEqual({ total: 11, versions: ["v2"] });
});

it("surfaces an unsupported domain schema version as an upcast-layer refusal", () => {
  const seat = recorder();
  const events = [evt("evt-1", 10n, 1), evt("evt-2", 11n, 2, { domainSchemaVersion: "v9" })];
  const result = refused(fold(events, { reducers: seat.reducers }));
  expect(result.code).toBe("PROJECTION_FOLD_UPCAST_REFUSED");
  expect(result.layer).toBe("UPCAST");
  expect(result.upcast?.code).toBe("SCHEMA_VERSION_UNSUPPORTED");
  expect(result.upcast?.fromVersion).toBe("v9");
  expect(result.eventId).toBe("evt-2");
  expect(seat.seen).toEqual(["evt-1"]);
  expect(result.state).toEqual(START);
  expect(result.checkpoint).toEqual({ globalPosition: 5n });
});

it("returns the unchanged input state when a reducer throws mid-batch", () => {
  const seat = recorder((state, event) => {
    if (event.eventId === "evt-2") { throw new Error("reducer exploded"); }
    return { ...state, total: (state["total"] as number) + 1 };
  });
  const result = refused(fold(PAIR(), { reducers: seat.reducers }));
  expect(result.code).toBe("PROJECTION_FOLD_REDUCER_FAILED");
  expect(result.layer).toBe("REDUCER");
  expect(result.eventId).toBe("evt-2");
  expect(result.state).toEqual(START);
  expect(result.checkpoint).toEqual({ globalPosition: 5n });
  expect(Object.isFrozen(result.state)).toBe(true);
});

it("refuses a reducer result that is not recursively plain data", () => {
  const seat = recorder(() => ({ total: 1, tick: () => 0 }) as unknown as ProjectionState);
  const result = refused(fold([storedEvent()], { reducers: seat.reducers }));
  expect(result.code).toBe("PROJECTION_FOLD_STATE_INVALID");
  expect(result.layer).toBe("REDUCER");
});

it("detaches reducer output so a later mutation cannot reach folded state", () => {
  const escape: Record<string, unknown> = { total: 3, versions: [] };
  const seat = recorder(() => escape as unknown as ProjectionState);
  const result = ok(fold([storedEvent()], { reducers: seat.reducers }));
  escape["total"] = 99;
  (escape["versions"] as unknown[]).push("leak");
  expect(result.state).toEqual({ total: 3, versions: [] });
  expect(Object.isFrozen(result.state)).toBe(true);
});

it("refuses an event whose type has no registered reducer", () => {
  const result = refused(fold([storedEvent()], { reducers: {} }));
  expect(result.code).toBe("PROJECTION_FOLD_REDUCER_MISSING");
  expect(result.layer).toBe("REDUCER");
  expect(result.eventId).toBe("evt-1");
});

it("does not treat an inherited Object property as a registered reducer", () => {
  const inherited = compileStoredEventUpcaster([
    { currentVersion: "v2", eventType: "constructor", routes: [] },
  ]);
  const events = [storedEvent({ eventType: "constructor" })];
  const result = refused(fold(events, { reducers: {}, upcaster: inherited }));
  expect(result.code).toBe("PROJECTION_FOLD_REDUCER_MISSING");
});

const HOSTILE: Readonly<Record<string, () => StoredEvent>> = {
  accessor: () => Object.defineProperty({ ...storedEvent() }, "payload",
    { configurable: true, enumerable: true, get: () => new Uint8Array([1]) }) as StoredEvent,
  /** `FIELD_KINDS[key] !== undefined` for both, and `draft["__proto__"] = x` swaps a proto. */
  inheritedKey: () => ({ ...storedEvent(), constructor: 1 }) as unknown as StoredEvent,
  protoKey: () => ({ ...storedEvent(), ["__proto__"]: { leaked: 1 } }) as unknown as StoredEvent,
  shadowKey: () => ({ ...storedEvent(), shadow: 1 }) as unknown as StoredEvent,
  throwingProxy: () => new Proxy(storedEvent(),
    { ownKeys: () => { throw new Error("ownKeys trap"); } }) as StoredEvent,
};

it("refuses every hostile event shape at the input layer without running a reducer", () => {
  expect(Object.keys(HOSTILE))
    .toEqual(["accessor", "inheritedKey", "protoKey", "shadowKey", "throwingProxy"]);
  for (const [name, build] of Object.entries(HOSTILE)) {
    const seat = recorder();
    const result = refused(fold([build()], { reducers: seat.reducers }));
    expect([name, result.code, result.layer, seat.seen])
      .toEqual([name, "PROJECTION_FOLD_INPUT_INVALID", "INPUT", []]);
  }
});

it("refuses an input state or checkpoint that is not plain data", () => {
  const state = refused(fold([], { state: { at: new Map() } as unknown as ProjectionState }));
  const point = refused(fold([], { checkpoint: { globalPosition: -1n } }));
  const proto = refused(fold([], { state: { ["__proto__"]: { x: 1 } } as ProjectionState }));
  expect([state.code, point.code, proto.code, point.layer]).toEqual([
    "PROJECTION_FOLD_INPUT_INVALID", "PROJECTION_FOLD_INPUT_INVALID",
    "PROJECTION_FOLD_INPUT_INVALID", "INPUT"]);
});

const FORBIDDEN = ["node:", "DatabaseSync", "readFile", "writeFile", "Date.", "Math.random",
  "require(", "process."];

it("keeps the fold engine free of clock, randomness, and database access", () => {
  const source = readFileSync(new URL("projection-fold.ts", import.meta.url), "utf8");
  expect(FORBIDDEN.filter((token) => source.includes(token))).toEqual([]);
  expect([...source.matchAll(/from "([^"]+)"/gu)].map((match) => match[1]))
    .toEqual(["../store-contracts.js", "./projection-upcast.js"]);
});
