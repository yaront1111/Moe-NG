/**
 * `enumerateAggregateIdsByPrefix`: the payload-free discovery primitive.
 *
 * The projection defect this primitive exists to close was an enumerator paging
 * EVERY stored event — materializing every payload — to learn nothing but the
 * distinct aggregate ids in one id-prefix range. These cases pin the three
 * properties the replacement owes: the range is EXACT (nothing above the
 * prefix's upper bound leaks in, nothing matching escapes), the ids come back
 * DISTINCT and sorted ascending, and no stored payload is ever decoded — a row
 * whose stored record is undecodable through every materializing read must
 * still have its aggregate id served.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SqliteEventStore } from "./index.js";

const ENCODER = new TextEncoder();
const PREFIX = "graph-revision:project-a:";

function seedAggregate(store: SqliteEventStore, aggregateId: string, eventCount = 1): void {
  store.commit({
    aggregateId,
    commandBytes: ENCODER.encode(`seed-${aggregateId}`),
    commandId: `command-${aggregateId}`,
    committedAt: "2026-08-23T00:00:00.000Z",
    events: Array.from({ length: eventCount }, (_, index) => ({
      eventId: `event-${aggregateId}-${index}`,
      eventType: "aggregate.seeded",
      payload: ENCODER.encode(JSON.stringify({ index })),
    })),
    expectedVersion: 0,
  });
}

/**
 * Insertion order is deliberately NOT the expected output order, and the
 * non-matching neighbours are chosen to sit on BOTH sides of the range: ids
 * below the prefix, ids above its exclusive upper bound (including the
 * adjacent `project-ab` id that shares every byte of the prefix except its
 * terminator), and one far above. A `>= prefix` scan with no upper bound
 * would serve three of them.
 */
function seedPrefixNeighbourhood(store: SqliteEventStore): void {
  seedAggregate(store, "graph-revision:project-a:rev-2");
  seedAggregate(store, "unrelated-zzz");
  seedAggregate(store, "graph-revision:project-a:rev-1", 3);
  seedAggregate(store, "graph-revision:project-ab:rev-9");
  seedAggregate(store, "graph-revision:project-9:rev-1");
  seedAggregate(store, "graph-revision:project-b:rev-1");
  seedAggregate(store, "graph-revision:project-a:");
}

describe("enumerateAggregateIdsByPrefix", () => {
  it("returns exactly the distinct matching ids, sorted ascending", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest("project-enumeration");
    try {
      seedPrefixNeighbourhood(store);

      const ids = store.enumerateAggregateIdsByPrefix(PREFIX);

      // Exact set: the multi-event aggregate appears ONCE, the id equal to the
      // bare prefix is a match, and none of the out-of-range neighbours leak.
      expect(ids).toEqual([
        "graph-revision:project-a:",
        "graph-revision:project-a:rev-1",
        "graph-revision:project-a:rev-2",
      ]);
      expect(ids).toEqual([...ids].sort());
      expect(Object.isFrozen(ids)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("returns [] for a prefix matching nothing, even over a populated store", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest("project-enumeration");
    try {
      seedPrefixNeighbourhood(store);

      expect(store.enumerateAggregateIdsByPrefix("graph-revision:project-zzz:")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("serves the id of an aggregate whose stored record no materializing read can decode", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-id-enumeration-"));
    const databasePath = join(directory, "events.sqlite");
    try {
      const store = SqliteEventStore.openForProject(databasePath, "project-enumeration");
      try {
        seedAggregate(store, "graph-revision:project-a:rev-1");
        const tamper = new DatabaseSync(databasePath);
        try {
          tamper.exec(`
            UPDATE domain_events
            SET record_version = 'future-event-record/999'
            WHERE aggregate_id = 'graph-revision:project-a:rev-1';
          `);
        } finally {
          tamper.close();
        }

        // Control: every payload-materializing read refuses this row outright,
        // so an enumeration that decoded rows could not answer either.
        expect(() => store.readEvents("graph-revision:project-a:rev-1")).toThrowError(
          /STORE_CORRUPT/u,
        );

        expect(store.enumerateAggregateIdsByPrefix(PREFIX)).toEqual([
          "graph-revision:project-a:rev-1",
        ]);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("refuses a malformed prefix through the store's own input layer", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest("project-enumeration");
    try {
      expect(() => store.enumerateAggregateIdsByPrefix("")).toThrowError(/STORE_INPUT_INVALID/u);
    } finally {
      store.close();
    }
  });
});
