import { expect, expectTypeOf, it } from "vitest";

import type { StoredEvent } from "@moe/store";

import {
  EVENT_STREAM_REFUSAL_CODES,
  EVENT_STREAM_UNKNOWN_CODES,
  MAX_EVENT_PAGE_SIZE,
} from "./event-stream-contract.js";
import type {
  EventReadFrame,
  EventStreamUnknownCode,
  StreamEvent,
  WireEvent,
  WireValue,
} from "./event-stream-contract.js";
import { readEventPage, resumeFromSnapshot } from "./event-stream.js";
import {
  LEDGER_EVENTS,
  LEDGER_EVENT_IDS,
  LEDGER_SIZE,
  PROJECTION,
  SEAM_READING,
  SNAPSHOT_CHECKPOINT,
  SUBSCRIBER,
  TRACED_EVENT_COUNT,
  UNTRACED_EVENT_COUNT,
  ledgerIdsUpTo,
  seamObserver,
  streamPort,
} from "./event-stream-fixtures.js";

const READ = { projection: PROJECTION, subscriberId: SUBSCRIBER };

it("returns a PAGE frame carrying the next cursor", () => {
  const frame = readEventPage(streamPort(), READ);

  expect(frame.outcome).toBe("PAGE");
  if (frame.outcome !== "PAGE") return;
  expect(frame.events.map((event) => event.eventId)).toEqual(LEDGER_EVENT_IDS);
  expect(frame.nextCursor).toEqual({ generation: 1, position: "10" });
  expect(frame.checkpoint).toBe("10");
  expect(frame.hasMore).toBe(false);
});

it("encodes ledger positions as strings so no bigint reaches the wire", () => {
  const frame = readEventPage(streamPort(), READ);
  if (frame.outcome !== "PAGE") throw new Error("expected a PAGE frame");

  expect(typeof frame.checkpoint).toBe("string");
  for (const event of frame.events) expect(typeof event.globalPosition).toBe("string");
  expect(() => JSON.stringify(frame)).not.toThrow();
});

it("returns a CURSOR_GAP frame that preserves the specific gap cause", () => {
  const pruned = readEventPage(streamPort({ gap: "HISTORY_PRUNED" }), READ);
  const changed = readEventPage(streamPort({ gap: "GENERATION_CHANGED" }), READ);

  expect(pruned.outcome).toBe("CURSOR_GAP");
  if (pruned.outcome !== "CURSOR_GAP") return;
  expect(pruned.cause).toBe("HISTORY_PRUNED");
  expect(pruned.snapshot.stateDigest).toBe("d".repeat(64));
  expect(pruned.snapshot.checkpoint).toBe(SNAPSHOT_CHECKPOINT);

  expect(changed.outcome).toBe("CURSOR_GAP");
  if (changed.outcome !== "CURSOR_GAP") return;
  expect(changed.cause).toBe("GENERATION_CHANGED");
  expect(changed.cause).not.toBe(pruned.cause);
});

/**
 * Arm discipline. If the union were flattened into one optional-field object, a client
 * could read a cursor off a gap response and resume from a position never delivered.
 */
it("keeps nextCursor off the gap frame and the snapshot off the page frame", () => {
  const gap = readEventPage(streamPort({ gap: "HISTORY_PRUNED" }), READ);
  const page = readEventPage(streamPort(), READ);

  expect(Object.hasOwn(gap, "nextCursor")).toBe(false);
  expect(Object.hasOwn(gap, "events")).toBe(false);
  expect(Object.hasOwn(page, "snapshot")).toBe(false);
  expect(Object.hasOwn(page, "cause")).toBe(false);
});

it("refuses a stale snapshot with the store's own code and layer, not a generic error", () => {
  const frame = readEventPage(streamPort({ refuse: true }), READ);

  expect(frame.outcome).toBe("REFUSED");
  if (frame.outcome !== "REFUSED") return;
  expect(frame.code).toBe("SUBSCRIPTION_SNAPSHOT_STALE");
  expect(frame.layer).toBe("STATE");
});

it("refuses a page limit outside the store's bound, naming the seam as the layer", () => {
  const tooLarge = readEventPage(streamPort(), { ...READ, limit: MAX_EVENT_PAGE_SIZE + 1 });
  expect(tooLarge.outcome).toBe("REFUSED");
  if (tooLarge.outcome !== "REFUSED") return;
  expect(tooLarge.code).toBe("EVENT_STREAM_LIMIT_INVALID");
  expect(tooLarge.layer).toBe("SEAM");

  expect(readEventPage(streamPort(), { ...READ, limit: MAX_EVENT_PAGE_SIZE }).outcome)
    .toBe("PAGE");
  expect(readEventPage(streamPort(), { ...READ, limit: 0 }).outcome).toBe("REFUSED");
});

/**
 * "Refused rather than silently reseated" is asserted by STATE: the reseat count stays
 * zero. A seam that reseated first and refused afterwards would have already moved the
 * durable cursor, which is the very thing this refusal exists to prevent.
 */
it("refuses a resume whose presented cursor is from a superseded generation", () => {
  const port = streamPort({ gap: "GENERATION_CHANGED", generation: 2 });
  const frame = resumeFromSnapshot(port, {
    presentedCursor: { generation: 1, position: SNAPSHOT_CHECKPOINT },
    projection: PROJECTION,
    subscriberId: SUBSCRIBER,
  });

  expect(frame.outcome).toBe("REFUSED");
  if (frame.outcome !== "REFUSED") return;
  expect(frame.code).toBe("EVENT_STREAM_GENERATION_SUPERSEDED");
  expect(frame.layer).toBe("SEAM");
  expect(port.reseats()).toBe(0);
});

it("refuses a resume from a position the seam never issued", () => {
  const port = streamPort({ gap: "HISTORY_PRUNED" });
  const frame = resumeFromSnapshot(port, {
    presentedCursor: { generation: 1, position: "9" },
    projection: PROJECTION,
    subscriberId: SUBSCRIBER,
  });

  expect(frame.outcome).toBe("REFUSED");
  if (frame.outcome !== "REFUSED") return;
  expect(frame.code).toBe("EVENT_STREAM_CURSOR_NOT_ISSUED");
  expect(frame.layer).toBe("SEAM");
  expect(port.reseats()).toBe(0);
});

it("refuses a resume when there is no gap to resume from", () => {
  const port = streamPort();
  const frame = resumeFromSnapshot(port, {
    presentedCursor: { generation: 1, position: SNAPSHOT_CHECKPOINT },
    projection: PROJECTION,
    subscriberId: SUBSCRIBER,
  });

  expect(frame.outcome).toBe("REFUSED");
  if (frame.outcome !== "REFUSED") return;
  expect(frame.code).toBe("EVENT_STREAM_CURSOR_NOT_ISSUED");
  expect(port.reseats()).toBe(0);
});

/**
 * The property the whole DoD turns on. The oracle is the RAW ledger id list, not a second
 * call through the same seam: comparing the seam against itself would pass even if the
 * seam dropped the same events on both paths.
 */
it("resumes from one verified snapshot without skipping any event", () => {
  const port = streamPort({ gap: "HISTORY_PRUNED" });

  const gap = readEventPage(port, READ);
  expect(gap.outcome).toBe("CURSOR_GAP");
  if (gap.outcome !== "CURSOR_GAP") return;

  const resumed = resumeFromSnapshot(port, {
    presentedCursor: { generation: gap.snapshot.generation, position: gap.snapshot.checkpoint },
    projection: PROJECTION,
    subscriberId: SUBSCRIBER,
  });
  expect(resumed.outcome).toBe("RESEATED");
  if (resumed.outcome !== "RESEATED") return;

  const after = readEventPage(port, READ);
  expect(after.outcome).toBe("PAGE");
  if (after.outcome !== "PAGE") return;

  const coveredBySnapshot = ledgerIdsUpTo(BigInt(gap.snapshot.checkpoint));
  const deliveredAfterResume = after.events.map((event) => event.eventId);
  expect(coveredBySnapshot.length).toBeGreaterThan(0);
  expect(deliveredAfterResume.length).toBeGreaterThan(0);
  expect([...coveredBySnapshot, ...deliveredAfterResume]).toEqual(LEDGER_EVENT_IDS);
});

it("resumes to the checkpoint of the snapshot it verified, not past it", () => {
  const port = streamPort({ gap: "HISTORY_PRUNED" });
  const gap = readEventPage(port, READ);
  if (gap.outcome !== "CURSOR_GAP") throw new Error("expected a CURSOR_GAP frame");

  const resumed = resumeFromSnapshot(port, {
    presentedCursor: { generation: gap.snapshot.generation, position: gap.snapshot.checkpoint },
    projection: PROJECTION,
    subscriberId: SUBSCRIBER,
  });
  if (resumed.outcome !== "RESEATED") throw new Error("expected a RESEATED frame");

  expect(resumed.cursor).toEqual({ generation: 1, position: SNAPSHOT_CHECKPOINT });
  expect(resumed.snapshot.stateDigest).toBe("d".repeat(64));
});

it("forwards a reseat refusal with the port's own code rather than a seam code", () => {
  const port = streamPort({ refuse: true });
  const frame = resumeFromSnapshot(port, {
    presentedCursor: { generation: 1, position: SNAPSHOT_CHECKPOINT },
    projection: PROJECTION,
    subscriberId: SUBSCRIBER,
  });

  expect(frame.outcome).toBe("REFUSED");
  if (frame.outcome !== "REFUSED") return;
  expect(frame.code).toBe("SUBSCRIPTION_SNAPSHOT_STALE");
  expect(frame.layer).toBe("STATE");
  expect(frame.layer).not.toBe("SEAM");
});

it("freezes every frame it returns", () => {
  const page = readEventPage(streamPort(), READ);
  const gap = readEventPage(streamPort({ gap: "HISTORY_PRUNED" }), READ);
  const refused = readEventPage(streamPort({ refuse: true }), READ);

  expect(Object.isFrozen(page)).toBe(true);
  expect(Object.isFrozen(gap)).toBe(true);
  expect(Object.isFrozen(refused)).toBe(true);
  if (page.outcome !== "PAGE") return;
  expect(Object.isFrozen(page.events)).toBe(true);
});

/**
 * Identity and daemon-observed timing.
 *
 * No test below subtracts or compares two readings. The seam emits readings with their
 * observer attached and computes nothing, so asserting a delta here would be asserting a
 * property this layer is forbidden to have.
 */

/**
 * The structural view is load-bearing: if StreamEvent ever declares something the store's
 * own record does not provide, this fails the TYPECHECK rather than silently forcing an
 * edit to a package this seam does not own.
 */
type StoredEventIsAStreamEvent = StoredEvent extends StreamEvent ? true : false;

it("keeps a real StoredEvent assignable to the seam's structural view", () => {
  expectTypeOf<StoredEventIsAStreamEvent>().toEqualTypeOf<true>();
});

function pageOf(frame: EventReadFrame): readonly WireEvent[] {
  if (frame.outcome !== "PAGE") throw new Error("expected a PAGE frame");
  return frame.events;
}

function expectUnknown(value: WireValue, code: EventStreamUnknownCode): void {
  expect(value.known).toBe(false);
  if (value.known) throw new Error("expected an unknown value");
  expect(value.code).toBe(code);
  expect(value.layer).toBe("SEAM");
  // Absent means "declared absent", never a blank or a zero smuggled in as a value.
  expect(Object.hasOwn(value, "value")).toBe(false);
}

function expectKnown(value: WireValue, expected: string): void {
  expect(value.known).toBe(true);
  if (!value.known) throw new Error("expected a known value");
  expect(value.value).toBe(expected);
  expect(value.value).not.toBe("");
}

it("copies commandId from the source event for every event on the page", () => {
  const events = pageOf(readEventPage(streamPort(), READ, seamObserver()));

  expect(events.length).toBe(LEDGER_SIZE);
  let compared = 0;
  for (const [index, event] of events.entries()) {
    const source = LEDGER_EVENTS[index];
    if (source === undefined) throw new Error("ledger and page disagree on length");
    expect(event.identity.commandId).toBe(source.commandId);
    compared += 1;
  }
  expect(compared).toBe(LEDGER_SIZE);
});

it("copies the principal from the decision trace and never mints one", () => {
  const events = pageOf(readEventPage(streamPort(), READ, seamObserver()));

  let traced = 0;
  let untraced = 0;
  for (const [index, event] of events.entries()) {
    const source = LEDGER_EVENTS[index];
    if (source === undefined) throw new Error("ledger and page disagree on length");
    const trace = source.decisionTrace;
    if (trace === undefined) {
      expectUnknown(event.identity.principal, "EVENT_STREAM_IDENTITY_NOT_PROVIDED");
      untraced += 1;
      continue;
    }
    expectKnown(event.identity.principal, trace.principalId);
    traced += 1;
  }
  expect(traced).toBe(TRACED_EVENT_COUNT);
  expect(untraced).toBe(UNTRACED_EVENT_COUNT);
});

it("emits session and run as the not-provided unknown because the source has neither", () => {
  const events = pageOf(readEventPage(streamPort(), READ, seamObserver()));

  expect(events.length).toBe(LEDGER_SIZE);
  for (const event of events) {
    expectUnknown(event.identity.session, "EVENT_STREAM_IDENTITY_NOT_PROVIDED");
    expectUnknown(event.identity.run, "EVENT_STREAM_IDENTITY_NOT_PROVIDED");
    // Stated, not dropped: a later layer must see the gap rather than inherit a hole.
    expect(Object.hasOwn(event.identity, "session")).toBe(true);
    expect(Object.hasOwn(event.identity, "run")).toBe(true);
  }
});

it("refuses to read a ledger timestamp that is present but unusable", () => {
  const events = pageOf(readEventPage(streamPort({ unusableReading: true }), READ, seamObserver()));

  const first = events.at(0);
  const second = events.at(1);
  if (first === undefined || second === undefined) throw new Error("expected a full page");
  expectUnknown(first.ledgerObservation.reading, "EVENT_STREAM_READING_NOT_PROVIDED");
  expect(first.ledgerObservation.observer).toBe("STORE_LEDGER");
  expect(first.ledgerObservation.clock).toBe("STORE_COMMIT_CLOCK");
  // The seam reading is unaffected: one absent reading never borrows the other clock.
  expectKnown(first.seamObservation.reading, SEAM_READING);
  expectKnown(second.ledgerObservation.reading, "2026-08-09T00:00:02.000Z");
});

it("refuses to read a seam clock that returns nothing usable", () => {
  const events = pageOf(readEventPage(streamPort(), READ, seamObserver("")));

  for (const event of events) {
    expectUnknown(event.seamObservation.reading, "EVENT_STREAM_READING_NOT_PROVIDED");
    expect(event.seamObservation.observer).toBe("DAEMON_SEAM");
    expectKnown(event.ledgerObservation.reading, event.committedAt);
  }
});

it("carries two readings bound to different observers and different clocks", () => {
  const events = pageOf(readEventPage(streamPort(), READ, seamObserver()));

  expect(events.length).toBe(LEDGER_SIZE);
  let checked = 0;
  for (const [index, event] of events.entries()) {
    const source = LEDGER_EVENTS[index];
    if (source === undefined) throw new Error("ledger and page disagree on length");
    expect(event.ledgerObservation.observer).toBe("STORE_LEDGER");
    expect(event.ledgerObservation.clock).toBe("STORE_COMMIT_CLOCK");
    expectKnown(event.ledgerObservation.reading, source.committedAt);

    expect(event.seamObservation.observer).toBe("DAEMON_SEAM");
    expect(event.seamObservation.clock).toBe("DAEMON_WALL_CLOCK");
    expectKnown(event.seamObservation.reading, SEAM_READING);

    // Separate fields with distinct provenance; neither is derived from the other.
    expect(event.seamObservation.observer).not.toBe(event.ledgerObservation.observer);
    expect(event.seamObservation.clock).not.toBe(event.ledgerObservation.clock);
    expect(Object.hasOwn(event, "seamObservation")).toBe(true);
    expect(Object.hasOwn(event, "ledgerObservation")).toBe(true);
    checked += 1;
  }
  expect(checked).toBe(LEDGER_SIZE);
});

/**
 * One reading per frame, not one per event. Ten readings off one clock would manufacture
 * precision the seam does not have and invite a consumer to diff two of them.
 */
it("takes exactly one seam reading per frame and stamps every event with it", () => {
  const observer = seamObserver();
  const events = pageOf(readEventPage(streamPort(), READ, observer));

  expect(observer.calls()).toBe(1);
  expect(events.length).toBe(LEDGER_SIZE);
  const readings = new Set(events.map((event) => {
    const { reading } = event.seamObservation;
    return reading.known ? reading.value : "UNKNOWN";
  }));
  expect(readings).toEqual(new Set([SEAM_READING]));
});

it("keeps the seam refusal vocabulary closed and disjoint from the unknown codes", () => {
  expect([...EVENT_STREAM_REFUSAL_CODES]).toEqual([
    "EVENT_STREAM_CURSOR_NOT_ISSUED",
    "EVENT_STREAM_GENERATION_SUPERSEDED",
    "EVENT_STREAM_LIMIT_INVALID",
  ]);
  expect([...EVENT_STREAM_UNKNOWN_CODES]).toEqual([
    "EVENT_STREAM_IDENTITY_NOT_PROVIDED",
    "EVENT_STREAM_READING_NOT_PROVIDED",
  ]);
  const refusals = new Set<string>(EVENT_STREAM_REFUSAL_CODES);
  const overlap = EVENT_STREAM_UNKNOWN_CODES.filter((code) => refusals.has(code));
  expect(overlap).toEqual([]);
});
