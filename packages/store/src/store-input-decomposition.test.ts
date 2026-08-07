import { describe, expect, it } from "vitest";

import {
  DurableStoreError,
  MAX_BLOB_BYTES,
  MAX_COMMIT_BYTES,
  MAX_PAGE_SIZE,
} from "./store-contracts.js";
import * as storeInput from "./store-input.js";

const timestamp = "2026-08-07T00:00:00.000Z";

function expectStoreError(
  action: () => unknown,
  code: "STORE_INPUT_INVALID" | "STORE_LIMIT_EXCEEDED",
  detail: string,
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DurableStoreError);
    expect((error as Error).message).toBe(`${code}: ${detail}`);
    return;
  }
  expect.fail("expected DurableStoreError");
}

function event(id = "event-1", messageId = "message-1") {
  return {
    eventId: id,
    eventType: "thing.changed",
    outbox: [{ messageId, payload: Uint8Array.of(3), topic: "things" }],
    payload: Uint8Array.of(2),
  };
}

function commit(events = [event()]) {
  return {
    aggregateId: "aggregate-1",
    commandBytes: Uint8Array.of(1),
    commandId: "command-1",
    committedAt: timestamp,
    events,
    expectedVersion: 0,
  };
}

describe("store input compatibility facade", () => {
  it("exports exactly the established eighteen runtime functions", () => {
    expect(Object.keys(storeInput).sort()).toEqual([
      "assertExternalCommitIdentifiers",
      "invalidInput",
      "limitExceeded",
      "readOwnDataProperty",
      "requireCanonicalTimestamp",
      "requireDataRecord",
      "requireIdentifier",
      "requireNonnegativeBigInt",
      "requirePageLimit",
      "requireSafeNonnegativeInteger",
      "requireSafePositiveInteger",
      "snapshotBytes",
      "snapshotCommandDecisionKey",
      "snapshotCommitInput",
      "snapshotCommittedProposal",
      "snapshotDecisionMetadata",
      "snapshotDenseArray",
      "snapshotExpectedVersionRequest",
    ]);
  });

  it("pins scalar and record validation codes and messages", () => {
    const cases: readonly [() => unknown, "STORE_INPUT_INVALID" | "STORE_LIMIT_EXCEEDED", string][] = [
      [() => storeInput.invalidInput("bad"), "STORE_INPUT_INVALID", "bad"],
      [() => storeInput.limitExceeded("large"), "STORE_LIMIT_EXCEEDED", "large"],
      [() => storeInput.requireIdentifier("", "id"), "STORE_INPUT_INVALID", "id must be well-formed, non-empty, at most 512 UTF-8 bytes, and contain no NUL"],
      [() => storeInput.requireSafeNonnegativeInteger(-1, "version"), "STORE_INPUT_INVALID", "version must be a non-negative safe integer"],
      [() => storeInput.requireSafePositiveInteger(0, "count"), "STORE_INPUT_INVALID", "count must be a positive safe integer"],
      [() => storeInput.requireNonnegativeBigInt(-1n, "cursor"), "STORE_INPUT_INVALID", "cursor must be a non-negative SQLite-range bigint"],
      [() => storeInput.requirePageLimit(MAX_PAGE_SIZE + 1), "STORE_LIMIT_EXCEEDED", `limit cannot exceed ${MAX_PAGE_SIZE}`],
      [() => storeInput.requireCanonicalTimestamp("2026-08-07", "time"), "STORE_INPUT_INVALID", "time must be a canonical UTC timestamp with millisecond precision"],
      [() => storeInput.requireDataRecord(new Date(), "record"), "STORE_INPUT_INVALID", "record must be a plain data object"],
    ];
    for (const [action, code, detail] of cases) {
      expectStoreError(action, code, detail);
    }
    const accessor = Object.defineProperty({}, "value", { get: () => 1 });
    const record = storeInput.requireDataRecord(accessor, "record");
    expectStoreError(
      () => storeInput.readOwnDataProperty(record, "value", "record.value"),
      "STORE_INPUT_INVALID",
      "record.value must be an own data property",
    );
  });

  it("fails closed for hostile arrays and byte containers", () => {
    class ArraySubclass extends Array<unknown> {}
    const withExtra = [1] as unknown[] & { extra?: number };
    withExtra.extra = 2;
    const revokedArray = Proxy.revocable([], {});
    revokedArray.revoke();
    const arrayCases: readonly [unknown, string][] = [
      [new Proxy([], {}), "items must be a non-proxy array"],
      [revokedArray.proxy, "items must be a non-proxy array"],
      [new ArraySubclass(1), "items must be a plain array"],
      [Array(1), "items must be dense and contain only data elements"],
      [withExtra, "items cannot contain non-index properties"],
    ];
    for (const [value, detail] of arrayCases) {
      expectStoreError(
        () => storeInput.snapshotDenseArray(value, "items"),
        "STORE_INPUT_INVALID",
        detail,
      );
    }

    const detached = Uint8Array.of(1);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    const shared = new Uint8Array(new SharedArrayBuffer(1));
    const byteCases: readonly [unknown, string, "STORE_INPUT_INVALID" | "STORE_LIMIT_EXCEEDED"][] = [
      [new Proxy(Uint8Array.of(1), {}), "blob must be a non-proxy Uint8Array", "STORE_INPUT_INVALID"],
      [new Uint16Array(1), "blob must be a non-proxy Uint8Array", "STORE_INPUT_INVALID"],
      [shared, "blob cannot use a shared backing buffer", "STORE_INPUT_INVALID"],
      [detached, "blob must reference attached, stable bytes", "STORE_INPUT_INVALID"],
      [new Uint8Array(MAX_BLOB_BYTES + 1), `blob exceeds ${MAX_BLOB_BYTES} bytes`, "STORE_LIMIT_EXCEEDED"],
    ];
    for (const [value, detail, code] of byteCases) {
      expectStoreError(() => storeInput.snapshotBytes(value, "blob"), code, detail);
    }
    expectStoreError(
      () => storeInput.snapshotBytes(Uint8Array.of(1, 2), "blob", { remaining: 1 }),
      "STORE_LIMIT_EXCEEDED",
      `commit byte total cannot exceed ${MAX_COMMIT_BYTES}`,
    );
  });

  it("preserves combined-fault order, defaults, duplicates, and reserved IDs", () => {
    expectStoreError(
      () => storeInput.snapshotCommitInput({ ...commit(), commandBytes: "bad", events: [] } as never),
      "STORE_INPUT_INVALID",
      "events must contain at least one event",
    );
    const childFirst = commit([{ ...event(), eventType: "", outbox: [{ messageId: "m", payload: "bad" as never, topic: "" }] }]);
    expectStoreError(
      () => storeInput.snapshotCommitInput(childFirst as never),
      "STORE_INPUT_INVALID",
      "events[0].outbox[0].payload must be a non-proxy Uint8Array",
    );
    expectStoreError(
      () => storeInput.snapshotCommitInput(commit([event("same", "a"), event("same", "b")]) as never),
      "STORE_INPUT_INVALID",
      'duplicate eventId "same"',
    );
    expectStoreError(
      () => storeInput.snapshotCommitInput(commit([event("a", "same"), event("b", "same")]) as never),
      "STORE_INPUT_INVALID",
      'duplicate messageId "same"',
    );

    const snapshot = storeInput.snapshotCommitInput(commit());
    expect(snapshot.events[0]?.metadata).toEqual(new Uint8Array());
    expect(snapshot.events[0]?.outbox[0]?.headers).toEqual(new Uint8Array());
    expect(Object.isFrozen(snapshot)).toBe(false);
    const reserved = storeInput.snapshotCommitInput({ ...commit(), aggregateId: "moe-internal:a" });
    expectStoreError(
      () => storeInput.assertExternalCommitIdentifiers(reserved),
      "STORE_INPUT_INVALID",
      "aggregateId uses Moe's reserved internal identifier namespace",
    );
    const audit = storeInput.snapshotCommitInput(commit([{ ...event(), eventType: "command.expected-version-rejected" }]));
    expectStoreError(
      () => storeInput.assertExternalCommitIdentifiers(audit),
      "STORE_INPUT_INVALID",
      "events[0].eventType uses Moe's reserved audit event type",
    );
  });

  it("copies caller-owned commit and decision state while preserving deferred proposal reads", () => {
    const commandBytes = Uint8Array.of(1);
    const payload = Uint8Array.of(2);
    const messagePayload = Uint8Array.of(3);
    const message = { messageId: "message-1", payload: messagePayload, topic: "things" };
    const outbox = [message];
    const sourceEvent = { eventId: "event-1", eventType: "thing.changed", outbox, payload };
    const events = [sourceEvent];
    const raw = { ...commit(events), commandBytes };
    const snapshot = storeInput.snapshotCommitInput(raw);
    commandBytes[0] = 9;
    payload[0] = 9;
    messagePayload[0] = 9;
    events.length = 0;
    outbox.length = 0;
    sourceEvent.eventType = "mutated";
    message.topic = "mutated";
    expect(snapshot.commandBytes).toEqual(Uint8Array.of(1));
    expect(snapshot.events[0]?.payload).toEqual(Uint8Array.of(2));
    expect(snapshot.events[0]?.outbox[0]).toMatchObject({ payload: Uint8Array.of(3), topic: "things" });

    const requestBytes = Uint8Array.of(4);
    const decision = {
      commandKind: "thing.update",
      committedResultBytes: Uint8Array.of(5),
      correlationId: "correlation-1",
      decidedAt: timestamp,
      events: [event("old-event", "old-message")],
      expectedVersion: 0,
      key: { commandId: "command-1", principalId: "principal-1", projectId: "project-1" },
      requestBytes,
      targetAggregateId: "aggregate-1",
    };
    const request = storeInput.snapshotExpectedVersionRequest(decision);
    expect(Object.isFrozen(request.key)).toBe(true);
    requestBytes[0] = 9;
    decision.events = [event("new-event", "new-message")];
    decision.committedResultBytes = Uint8Array.of(6);
    const proposal = storeInput.snapshotCommittedProposal(request, "moe-internal:receipt", timestamp);
    expect(request.requestBytes).toEqual(Uint8Array.of(4));
    expect(proposal.resultBytes).toEqual(Uint8Array.of(6));
    expect(proposal.commitInput.events[0]?.eventId).toBe("new-event");
    expect(proposal.commitInput.commandId).toBe("moe-internal:receipt");
  });
  it("preserves decision metadata and shared proposal byte-budget order", () => {
    const metadata = storeInput.requireDataRecord(
      { correlationId: "", decidedAt: "bad" },
      "metadata",
    );
    expectStoreError(
      () => storeInput.snapshotDecisionMetadata(metadata),
      "STORE_INPUT_INVALID",
      "correlationId must be well-formed, non-empty, at most 512 UTF-8 bytes, and contain no NUL",
    );
    const maximumBytes = (): Uint8Array => new Uint8Array(MAX_BLOB_BYTES);
    const request = storeInput.snapshotExpectedVersionRequest({
      commandKind: "thing.update",
      committedResultBytes: maximumBytes(),
      correlationId: "correlation-1",
      decidedAt: timestamp,
      events: [{ ...event(), metadata: maximumBytes(), outbox: [{ ...event().outbox[0]!, payload: maximumBytes() }], payload: Uint8Array.of(1) }],
      expectedVersion: 0,
      key: { commandId: "command-1", principalId: "principal-1", projectId: "project-1" },
      requestBytes: maximumBytes(),
      targetAggregateId: "aggregate-1",
    });
    expectStoreError(
      () => storeInput.snapshotCommittedProposal(request, "moe-internal:receipt", timestamp),
      "STORE_LIMIT_EXCEEDED",
      `commit byte total cannot exceed ${MAX_COMMIT_BYTES}`,
    );
  });
});
