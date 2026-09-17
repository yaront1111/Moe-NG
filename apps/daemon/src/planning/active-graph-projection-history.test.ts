import type { SqliteEventStore, StoredEvent } from "@moe/store";
import { describe, expect, it } from "vitest";

import { readGraphRevisionHistory } from "./active-graph-projection.js";

const ENCODER = new TextEncoder();

/** Only `readEvents` is reached, so the store is narrowed to it and records each aggregate asked. */
function storeHolding(payloads: readonly Uint8Array[]): {
  readonly asked: string[]; readonly store: SqliteEventStore;
} {
  const asked: string[] = [];
  const events = payloads.map((payload) => ({ payload }) as unknown as StoredEvent);
  const store = {
    readEvents: (aggregateId: string): readonly StoredEvent[] => {
      asked.push(aggregateId);
      return events;
    },
  } as unknown as SqliteEventStore;
  return { asked, store };
}

describe("readGraphRevisionHistory hands the replay one decoded payload per stored event", () => {
  it("reads exactly the named aggregate and decodes its payloads in store order", () => {
    const { asked, store } = storeHolding([
      ENCODER.encode('{"type":"GraphRevisionCreated","n":1}'),
      ENCODER.encode('{"type":"GraphRevisionApproved","n":2}'),
    ]);

    expect(readGraphRevisionHistory(store, "graph-revision:p:r")).toEqual([
      { n: 1, type: "GraphRevisionCreated" },
      { n: 2, type: "GraphRevisionApproved" },
    ]);
    expect(asked).toEqual(["graph-revision:p:r"]);
  });

  it("keeps an unreadable payload in its slot as null rather than dropping it", () => {
    const { store } = storeHolding([
      ENCODER.encode('{"n":1}'),
      ENCODER.encode("{not json"),
      Uint8Array.of(0xff, 0xfe),
      ENCODER.encode("null"),
      ENCODER.encode('{"n":5}'),
    ]);

    expect(readGraphRevisionHistory(store, "graph-revision:p:r"))
      .toEqual([{ n: 1 }, null, null, null, { n: 5 }]);
  });

  it("answers an empty history for an aggregate with no events", () => {
    expect(readGraphRevisionHistory(storeHolding([]).store, "graph-revision:p:none")).toEqual([]);
  });
});
