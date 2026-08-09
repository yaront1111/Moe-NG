import { describe, expect, it } from "vitest";

import { MAX_VIEW_RECORDS } from "../data/data-contract.js";
import { TIMELINE_TRUNCATION_CODE } from "./timeline-contract.js";
import type {
  TimelineEventRow,
  TimelineProvenance,
  TimelineRestartGapRow,
  TimelineRow,
  TimelineSourcePage,
  TimelineWalkResult,
  TimelineWalked,
} from "./timeline-contract.js";
import { walkTimeline } from "./timeline-page.js";
import type { TimelinePageSource } from "./timeline-page.js";

/**
 * DoD 3: "Large timelines paginate and resume without silent gaps."
 *
 * The hazard is not a crash, it is an early SUCCESSFUL-LOOKING termination. Three
 * independent droppers exist — the display filter, the MAX_VIEW_RECORDS bound, and the
 * restart gap — and each one can detach the walk from the page envelope on its own, so
 * each is traced separately here. See `mem:gotcha-clamped-page-must-not-trust-unclamped-hasmore`
 * for the shape that shipped undetected in the store's rebuild loop.
 *
 * Every fixture below is built so the kept rows and the source envelope genuinely DIFFER.
 * A page where they coincide proves nothing: it is exactly the fixture every store test
 * used while the bug was live.
 */

function provenanceOf(over: Partial<TimelineProvenance> = {}): TimelineProvenance {
  return {
    actor: "agent/session-a",
    aggregateId: "node-api-endpnt",
    commandId: "cmd-step-finish",
    effectId: "eff-0001",
    eventId: "evt-0001",
    leaseEpoch: 7,
    sessionId: "w-3",
    timestamp: "2026-08-09T09:41:02.000Z",
    typedLink: { kind: "receipt", label: "Runner receipt", ref: "receipt/rcpt-1" },
    ...over,
  };
}

function eventRow(sequence: number, actor = "agent/session-a"): TimelineEventRow {
  return {
    eventType: "step.finish",
    kind: "EVENT",
    provenance: provenanceOf({ actor, eventId: `evt-${String(sequence)}` }),
    sequence,
    summary: `step.finish #${String(sequence)}`,
    truthClass: "DAEMON_VERIFIED",
  };
}

function gapRow(sequence: number, lastGoodSequence: number): TimelineRestartGapRow {
  return {
    eventType: null,
    gapOutcome: "CURSOR_GAP",
    kind: "RESTART_GAP",
    lastGoodSequence,
    provenance: provenanceOf({ commandId: null, effectId: null, leaseEpoch: null }),
    sequence,
    statedCause: "daemon restarted; subscription reseated",
    summary: "Restart gap",
    truthClass: "OBSERVED",
  };
}

function sequencesOf(rows: readonly TimelineRow[]): readonly number[] {
  return rows.map((row) => row.sequence);
}

/**
 * A source whose `nextCursor` LIES: it points one row past the row it actually served,
 * so a walk that continues from the envelope skips a real row. A walk that continues
 * from what it examined loses nothing.
 */
function lyingSource(rows: readonly TimelineRow[], pageSize: number): TimelinePageSource {
  return (cursor: number | null): TimelineSourcePage => {
    const from = cursor === null ? 0 : rows.findIndex((row) => row.sequence > cursor);
    const start = from < 0 ? rows.length : from;
    const served = rows.slice(start, start + pageSize);
    const last = served.at(-1);
    return {
      hasMore: start + served.length < rows.length,
      nextCursor: last === undefined ? null : last.sequence + 1,
      rows: served,
    };
  };
}

/** The same walk, with an honest envelope, so the two can be compared directly. */
function honestSource(rows: readonly TimelineRow[], pageSize: number): TimelinePageSource {
  return (cursor: number | null): TimelineSourcePage => {
    const from = cursor === null ? 0 : rows.findIndex((row) => row.sequence > cursor);
    const start = from < 0 ? rows.length : from;
    const served = rows.slice(start, start + pageSize);
    const last = served.at(-1);
    return {
      hasMore: start + served.length < rows.length,
      nextCursor: last === undefined ? null : last.sequence,
      rows: served,
    };
  };
}

function walked(result: TimelineWalkResult): TimelineWalked {
  if (result.outcome !== "WALKED") {
    throw new Error(`expected WALKED, got ${result.outcome} ${result.code}/${result.layer}`);
  }
  return result;
}

const SIX = Object.freeze([1, 2, 3, 4, 5, 6].map((sequence) => eventRow(sequence)));

describe("the continuation cursor comes from the walk, never from the page envelope", () => {
  it("keeps every row when the source's nextCursor would step over one", () => {
    const result = walked(walkTimeline({
      filter: null, maxRows: 100, source: lyingSource(SIX, 3), startCursor: null,
    }));
    // Continuing from the envelope would serve rows > 4 next, dropping row 4 silently.
    expect(sequencesOf(result.rows)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.complete).toBe(true);
    expect(result.truncation).toBeNull();
  });

  it("continues past rows the filter removed instead of re-reading them", () => {
    // Every row of page 2 is filtered out, so no KEPT row can carry the continuation.
    // Continuing from the last kept row would re-serve page 2 forever.
    const filter = (row: TimelineRow): boolean => row.sequence < 4 || row.sequence > 6;
    const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((sequence) => eventRow(sequence));
    const result = walked(walkTimeline({
      filter, maxRows: 100, source: honestSource(nine, 3), startCursor: null,
    }));
    expect(sequencesOf(result.rows)).toEqual([1, 2, 3, 7, 8, 9]);
    expect(result.complete).toBe(true);
  });

  it("reports the walk complete only when the source is exhausted", () => {
    const result = walked(walkTimeline({
      filter: (row) => row.sequence > 90, maxRows: 100, source: honestSource(SIX, 3), startCursor: null,
    }));
    // A final page emptied entirely by the filter is still an exhausted source.
    expect(result.rows).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.nextCursor).toBe(6);
  });
});

describe("resuming from a persisted cursor reproduces the uninterrupted walk", () => {
  it("yields the identical total row sequence, not merely the same count", () => {
    const twelve = Array.from({ length: 12 }, (_unused, index) => eventRow(index + 1));
    expect(twelve.length).toBe(12);
    const uninterrupted = walked(walkTimeline({
      filter: null, maxRows: 100, source: honestSource(twelve, 5), startCursor: null,
    }));
    const first = walked(walkTimeline({
      filter: null, maxRows: 4, source: honestSource(twelve, 5), startCursor: null,
    }));
    expect(first.complete).toBe(false);
    expect(first.nextCursor).toBe(4);
    const resumed = walked(walkTimeline({
      filter: null, maxRows: 100, source: honestSource(twelve, 5), startCursor: first.nextCursor,
    }));
    expect(sequencesOf([...first.rows, ...resumed.rows])).toEqual(sequencesOf(uninterrupted.rows));
    expect(resumed.complete).toBe(true);
  });
});

describe("a restart gap stays visible and is never resynced away", () => {
  it("surfaces the RESTART_GAP row with the cause the daemon stated", () => {
    const rows = [eventRow(1), gapRow(2, 1), eventRow(3)];
    const result = walked(walkTimeline({
      filter: null, maxRows: 100, source: honestSource(rows, 3), startCursor: null,
    }));
    expect(sequencesOf(result.rows)).toEqual([1, 2, 3]);
    const gap = result.rows[1];
    expect(gap?.kind).toBe("RESTART_GAP");
    expect((gap as TimelineRestartGapRow).gapOutcome).toBe("CURSOR_GAP");
    expect((gap as TimelineRestartGapRow).statedCause).toBe("daemon restarted; subscription reseated");
  });

  it("keeps the gap row visible even when the filter excludes everything else", () => {
    // A gap belongs to the stream, not to a node or an actor, so no filter can hide it.
    // If it could, narrowing to one node would silently erase the evidence of a restart.
    const rows = [eventRow(1), gapRow(2, 1), eventRow(3)];
    const result = walked(walkTimeline({
      filter: () => false, maxRows: 100, source: honestSource(rows, 3), startCursor: null,
    }));
    expect(sequencesOf(result.rows)).toEqual([2]);
    expect(result.rows[0]?.kind).toBe("RESTART_GAP");
  });

  it("never rewinds the cursor to the gap's lastGoodSequence", () => {
    const served: (number | null)[] = [];
    const rows = [eventRow(1), eventRow(2), gapRow(3, 1), eventRow(4)];
    const inner = honestSource(rows, 3);
    const spy: TimelinePageSource = (cursor) => {
      served.push(cursor);
      return inner(cursor);
    };
    const result = walked(walkTimeline({
      filter: null, maxRows: 100, source: spy, startCursor: null,
    }));
    // A resync would re-serve from 1 (the gap's lastGoodSequence) and duplicate rows 2-3.
    expect(served).toEqual([null, 3]);
    expect(sequencesOf(result.rows)).toEqual([1, 2, 3, 4]);
  });
});

describe("the view bound truncates loudly", () => {
  it("enforces MAX_VIEW_RECORDS and names the row it stopped before", () => {
    const oversized = Array.from({ length: MAX_VIEW_RECORDS + 5 }, (_u, i) => eventRow(i + 1));
    // The sweep is only meaningful if it actually generated more rows than the bound.
    expect(oversized.length).toBe(MAX_VIEW_RECORDS + 5);
    const result = walked(walkTimeline({
      filter: null, maxRows: Number.MAX_SAFE_INTEGER, source: honestSource(oversized, 250),
      startCursor: null,
    }));
    expect(result.rows.length).toBe(MAX_VIEW_RECORDS);
    expect(result.complete).toBe(false);
    expect(result.nextCursor).toBe(MAX_VIEW_RECORDS);
    expect(result.truncation).toEqual({
      code: TIMELINE_TRUNCATION_CODE,
      droppedFromSequence: MAX_VIEW_RECORDS + 1,
      limit: MAX_VIEW_RECORDS,
    });
  });

  it("enforces the caller's smaller bound and resumes exactly where it stopped", () => {
    const result = walked(walkTimeline({
      filter: null, maxRows: 2, source: honestSource(SIX, 6), startCursor: null,
    }));
    expect(sequencesOf(result.rows)).toEqual([1, 2]);
    expect(result.nextCursor).toBe(2);
    expect(result.truncation?.droppedFromSequence).toBe(3);
    expect(result.truncation?.limit).toBe(2);
    expect(result.complete).toBe(false);
  });
});

describe("refusals name their code and the layer that produced them", () => {
  it("refuses an out-of-order page rather than sorting it into place", () => {
    const scrambled = [eventRow(1), eventRow(3), eventRow(2)];
    const result = walkTimeline({
      filter: null, maxRows: 100, source: honestSource(scrambled, 3), startCursor: null,
    });
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome !== "REFUSED") return;
    expect(result.code).toBe("TIMELINE_SEQUENCE_OUT_OF_ORDER");
    expect(result.layer).toBe("PAGING");
  });

  it("refuses a page that steps back behind the cursor it was served for", () => {
    const backwards: TimelinePageSource = () => ({
      hasMore: false, nextCursor: null, rows: [eventRow(2)],
    });
    const result = walkTimeline({
      filter: null, maxRows: 100, source: backwards, startCursor: 5,
    });
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome !== "REFUSED") return;
    expect(result.code).toBe("TIMELINE_SEQUENCE_OUT_OF_ORDER");
    expect(result.layer).toBe("PAGING");
  });

  it("refuses a source that promises more rows while supplying none", () => {
    const stalled: TimelinePageSource = () => ({ hasMore: true, nextCursor: 9, rows: [] });
    const result = walkTimeline({
      filter: null, maxRows: 100, source: stalled, startCursor: null,
    });
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome !== "REFUSED") return;
    expect(result.code).toBe("TIMELINE_CURSOR_NOT_ADVANCING");
    expect(result.layer).toBe("PAGING");
  });

  it("refuses a bound that cannot admit a row, before reading any page", () => {
    for (const maxRows of [0, -1, 1.5, Number.NaN]) {
      const result = walkTimeline({
        filter: null, maxRows, source: () => {
          throw new Error("the source must not be read when the bound is invalid");
        }, startCursor: null,
      });
      expect(result.outcome).toBe("REFUSED");
      if (result.outcome !== "REFUSED") continue;
      expect(result.code).toBe("TIMELINE_LIMIT_INVALID");
      expect(result.layer).toBe("INPUT");
    }
  });
});

describe("the walk never mutates or reorders what it was given", () => {
  it("leaves the source rows untouched and returns them in the supplied order", () => {
    const rows = [eventRow(1), eventRow(2), eventRow(3)];
    const snapshot = sequencesOf(rows);
    const result = walked(walkTimeline({
      filter: null, maxRows: 100, source: honestSource(rows, 2), startCursor: null,
    }));
    expect(sequencesOf(rows)).toEqual(snapshot);
    expect(sequencesOf(result.rows)).toEqual([1, 2, 3]);
    expect(Object.isFrozen(result.rows)).toBe(true);
  });
});
