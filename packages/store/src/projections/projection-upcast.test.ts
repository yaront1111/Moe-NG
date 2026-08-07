import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import {
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION, EVENT_RECORD_VERSION,
  OPAQUE_PAYLOAD_CODEC_VERSION, type StoredEvent,
} from "../store-contracts.js";
import {
  compileStoredEventUpcaster, type UpcastDefinition, type UpcastDefinitionCode,
  UpcastDefinitionError, type UpcastFailure, type UpcastFailureCode, type UpcastHandler,
  type UpcastOutcome, type UpcastPatch, type UpcastRoute,
} from "./projection-upcast.js";

const PRESERVED_KEYS = ["aggregateId", "aggregateSequence", "commandId", "committedAt", "eventId",
  "eventType", "globalPosition", "payloadCodecVersion", "recordVersion", "requestSha256"] as const;

function storedEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    aggregateId: "goal-1", aggregateSequence: 1, commandId: "cmd-1",
    committedAt: "2026-08-08T00:00:00.000Z",
    decisionTrace: {
      commandId: "cmd-1", commandKind: "GOAL_CREATE", principalId: "principal-1",
      projectId: "project-1", requestIdentityVersion: COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
      requestSha256: "a".repeat(64),
    },
    domainSchemaVersion: "v1", eventId: "evt-1", eventType: "GoalCreated", globalPosition: 1n,
    metadata: new Uint8Array([9, 8]), payload: new Uint8Array([1, 2, 3]),
    payloadCodecVersion: OPAQUE_PAYLOAD_CODEC_VERSION, recordVersion: EVENT_RECORD_VERSION,
    requestSha256: "b".repeat(64),
    ...overrides,
  };
}

function omitTrace(event: StoredEvent): StoredEvent {
  const { decisionTrace, ...rest } = event;
  void decisionTrace;
  return rest;
}

const passThrough: UpcastHandler = (input) => input;

function patch(payload: readonly number[], metadata: readonly number[]): UpcastPatch {
  return { metadata: new Uint8Array(metadata), payload: new Uint8Array(payload) };
}

function def(
  currentVersion: string, routes: readonly UpcastRoute[], eventType = "GoalCreated",
): UpcastDefinition {
  return { currentVersion, eventType, routes };
}

function r(from: string, to: string, handler: UpcastHandler = passThrough): UpcastRoute {
  return { fromVersion: from, handler, toVersion: to };
}

function logged(
  log: string[], from: string, to: string, handler: UpcastHandler = passThrough,
): UpcastRoute {
  return r(from, to, (input) => {
    log.push(`${from}->${to}`);
    return handler(input);
  });
}

function expectOk(outcome: UpcastOutcome): StoredEvent {
  if (!outcome.ok) {
    throw new Error(`expected an upcast success, received ${outcome.failure.code}`);
  }
  return outcome.event;
}

function expectFailure(outcome: UpcastOutcome, code: UpcastFailureCode): UpcastFailure {
  if (outcome.ok) {
    throw new Error(`expected an upcast failure, received ${outcome.event.domainSchemaVersion}`);
  }
  expect(Object.hasOwn(outcome, "event")).toBe(false);
  expect(Object.isFrozen(outcome.failure)).toBe(true);
  expect(outcome.failure.code).toBe(code);
  return outcome.failure;
}

it("returns a detached snapshot without invoking a handler when already current", () => {
  const log: string[] = [];
  const event = storedEvent({ domainSchemaVersion: "v3" });
  const upcaster = compileStoredEventUpcaster([def("v3", [logged(log, "v1", "v3")])]);
  const result = expectOk(upcaster.upcast(event));
  expect(log).toEqual([]);
  expect(result.domainSchemaVersion).toBe("v3");
  expect([...result.payload]).toEqual([1, 2, 3]);
  expect(result.payload.buffer).not.toBe(event.payload.buffer);
  expect(result.metadata.buffer).not.toBe(event.metadata.buffer);
  result.payload[0] = 99;
  result.metadata[0] = 99;
  expect([...event.payload]).toEqual([1, 2, 3]);
  expect([...event.metadata]).toEqual([9, 8]);
  const zeroLength = storedEvent({ domainSchemaVersion: "v3", payload: new Uint8Array() });
  expect([...expectOk(upcaster.upcast(zeroLength)).payload]).toEqual([]);
});

it("follows the exact multi-hop route to the declared current version", () => {
  const log: string[] = [];
  const event = storedEvent({ payload: new Uint8Array([1]) });
  const upcaster = compileStoredEventUpcaster([
    def("v3", [
      logged(log, "v2", "v3", (i) => patch([...i.payload, 3], [...i.metadata, 3])),
      logged(log, "v1", "v2", (i) => patch([...i.payload, 2], [...i.metadata, 2])),
    ]),
  ]);
  const result = expectOk(upcaster.upcast(event));
  expect(log).toEqual(["v1->v2", "v2->v3"]);
  expect(result.domainSchemaVersion).toBe("v3");
  expect([...result.payload]).toEqual([1, 2, 3]);
  expect([...result.metadata]).toEqual([9, 8, 2, 3]);
});

it("preserves the envelope, freezes it, and detaches bytes for a pass-through handler", () => {
  const log: string[] = [];
  const event = storedEvent();
  const upcaster = compileStoredEventUpcaster([def("v2", [logged(log, "v1", "v2")])]);
  const outcome = upcaster.upcast(event);
  const result = expectOk(outcome);
  expect(Object.keys(result).sort().join(",")).toBe(Object.keys(event).sort().join(","));
  for (const key of PRESERVED_KEYS) {
    expect(result[key]).toBe(event[key]);
  }
  expect(result.globalPosition).toBe(1n);
  expect(result.decisionTrace).toEqual(event.decisionTrace);
  expect(result.domainSchemaVersion).toBe("v2");
  expect([...result.payload]).toEqual([1, 2, 3]);
  expect(result.payload.buffer).not.toBe(event.payload.buffer);
  expect(result.metadata.buffer).not.toBe(event.metadata.buffer);
  expect(Object.isFrozen(outcome)).toBe(true);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.payload)).toBe(false);
  expect(Object.isFrozen(result.metadata)).toBe(false);

  const untraced = omitTrace(storedEvent());
  const withoutTrace = expectOk(upcaster.upcast(untraced));
  expect(Object.keys(withoutTrace)).not.toContain("decisionTrace");
  expect(Object.keys(withoutTrace).sort().join(",")).toBe(Object.keys(untraced).sort().join(","));
});

it("never infers a newer version from numeric or lexical ordering", () => {
  const log: string[] = [];
  const upcaster = compileStoredEventUpcaster([def("v9", [logged(log, "v8", "v9")])]);
  expect(upcaster.upcast(storedEvent({ domainSchemaVersion: "v10" })).ok).toBe(false);
  expect(log).toEqual([]);
});

it("returns frozen unsupported evidence for an unregistered starting version", () => {
  const upcaster = compileStoredEventUpcaster([def("v3", [r("v1", "v2"), r("v2", "v3")])]);
  const outcome = upcaster.upcast(storedEvent({ domainSchemaVersion: "v0", eventId: "evt-9" }));
  expect(expectFailure(outcome, "SCHEMA_VERSION_UNSUPPORTED")).toEqual({
    code: "SCHEMA_VERSION_UNSUPPORTED", currentVersion: "v3", eventId: "evt-9",
    eventType: "GoalCreated", fromVersion: "v0",
  });
});

it("reports a null current version when the event type has no definition at all", () => {
  const upcaster = compileStoredEventUpcaster([def("v2", [r("v1", "v2")], "OtherEvent")]);
  const failure = expectFailure(upcaster.upcast(storedEvent()), "SCHEMA_VERSION_UNSUPPORTED");
  expect(failure).toEqual({
    code: "SCHEMA_VERSION_UNSUPPORTED", currentVersion: null, eventId: "evt-1",
    eventType: "GoalCreated", fromVersion: "v1",
  });
});

it.each([
  ["UPCAST_DUPLICATE_EVENT_TYPE", [def("v2", [r("v1", "v2")]), def("v2", [r("v1", "v2")])]],
  ["UPCAST_DUPLICATE_DISPATCH_KEY", [def("v2", [r("v1", "v2"), r("v1", "v2")])]],
  ["UPCAST_SELF_LOOP", [def("v2", [r("v1", "v1")])]],
  ["UPCAST_ROUTE_CYCLE", [def("v3", [r("v1", "v2"), r("v2", "v1")])]],
  ["UPCAST_ROUTE_DEAD_END", [def("v3", [r("v1", "v2")])]],
] as readonly [UpcastDefinitionCode, UpcastDefinition[]][])("refuses to compile %s", (code, definitions) => {
  let thrown: unknown;
  try { compileStoredEventUpcaster(definitions); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(UpcastDefinitionError);
  expect((thrown as UpcastDefinitionError).code).toBe(code);
});

it("contains a throwing handler and never awaits a thenable result", () => {
  const explode = (): never => { throw new Error("handler exploded"); };
  const boom = compileStoredEventUpcaster([def("v2", [r("v1", "v2", explode)])]);
  expectFailure(boom.upcast(storedEvent()), "UPCAST_HANDLER_FAILED");
  let awaited = false;
  const thenable = compileStoredEventUpcaster([
    def("v2", [r("v1", "v2", () => ({ then: () => { awaited = true; } }) as unknown as UpcastPatch)]),
  ]);
  expectFailure(thenable.upcast(storedEvent()), "UPCAST_HANDLER_FAILED");
  expect(awaited).toBe(false);
  const hostile = compileStoredEventUpcaster([
    def("v2", [r("v1", "v2", () => ({ get metadata(): never { throw new Error("getter"); },
      payload: new Uint8Array([1]) }) as unknown as UpcastPatch)]),
  ]);
  expectFailure(hostile.upcast(storedEvent()), "UPCAST_HANDLER_FAILED");
});

it.each([
  ["null", null],
  ["a non-object", 42],
  ["an object missing metadata", { payload: new Uint8Array([1]) }],
  ["an extra key", { extra: 1, metadata: new Uint8Array([2]), payload: new Uint8Array([1]) }],
  ["a non-Uint8Array payload", { metadata: new Uint8Array([2]), payload: [1] }],
  ["an extra symbol key", { [Symbol("x")]: 1, metadata: new Uint8Array([2]), payload: new Uint8Array([1]) }],
] as readonly [string, unknown][])("refuses handler output that is %s", (_label, output) => {
  const upcaster = compileStoredEventUpcaster([
    def("v2", [r("v1", "v2", () => output as UpcastPatch)]),
  ]);
  expectFailure(upcaster.upcast(storedEvent()), "UPCAST_OUTPUT_INVALID");
});

it("keeps the production module free of impure imports and tokens", () => {
  const source = readFileSync(new URL("./projection-upcast.ts", import.meta.url), "utf8");
  const imports = source.split(/\r?\n/u).filter((line) => /^\s*import\b/u.test(line));
  expect(imports).toEqual(['import type { StoredEvent } from "../store-contracts.js";']);
  for (const token of ["Date.now", "Math.random", "require(", "import("]) {
    expect(source).not.toContain(token);
  }
});
