import { expect, it } from "vitest";

import { MAX_EVENT_PAGE_SIZE } from "./event-stream-contract.js";
import { readEventPage, resumeFromSnapshot } from "./event-stream.js";
import {
  LEDGER_EVENT_IDS,
  PROJECTION,
  SNAPSHOT_CHECKPOINT,
  SUBSCRIBER,
  ledgerIdsUpTo,
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
