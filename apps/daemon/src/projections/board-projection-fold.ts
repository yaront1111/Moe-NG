import type { StoredEvent } from "@moe/store";
import type {
  PlainValue, ProjectionReducer, ProjectionState,
} from "@moe/store/projections/projection-fold.js";
import type { StoredEventUpcaster } from "@moe/store/projections/projection-upcast.js";

/**
 * Fold ingredients for the moe.board projection. The board summarises the committed
 * ledger — per-aggregate versions, per-type counts, and the last applied position —
 * WITHOUT ever decoding payload bytes. That payload-opacity is what makes the two
 * judgement calls here honest: upcasting is a pass-through (the recorded schema
 * version is already current for a fold that reads no payload), and one reducer
 * serves every event type (the fields it reads exist on every StoredEvent by the
 * store's own record contract). Everything is pure and deterministic, so the
 * rebuild's digest compare-and-set reproduces byte-for-byte on every re-fold.
 */

type PlainRecord = { readonly [key: string]: PlainValue };

/** Pass-through upcaster: the board fold reads no payload bytes, so routing recorded
 *  versions to a "current" schema would transform bytes nobody looks at. */
export const BOARD_UPCASTER: StoredEventUpcaster = Object.freeze({
  upcast: (event: StoredEvent) => Object.freeze({ event, ok: true as const }),
});

function recordOf(value: PlainValue | undefined): PlainRecord {
  // The cast is required: `!Array.isArray` cannot subtract `readonly PlainValue[]`
  // from the union (readonly arrays are not assignable to the guard's `any[]`).
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PlainRecord) : {};
}

function countOf(value: PlainValue | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Reduces one committed event into JSON-plain board state (the snapshot doc codec
 *  admits no bigint, so the position is decimal text). Returns fresh objects only —
 *  the fold deep-clones and freezes its states, so prior state is never mutated. */
export function foldBoardEvent(state: ProjectionState, event: StoredEvent): ProjectionState {
  const byType = recordOf(state["byType"]);
  return {
    aggregates: {
      ...recordOf(state["aggregates"]), [event.aggregateId]: event.aggregateSequence,
    },
    byType: { ...byType, [event.eventType]: countOf(byType[event.eventType]) + 1 },
    eventTotal: countOf(state["eventTotal"]) + 1,
    lastCommittedAt: event.committedAt,
    lastPosition: event.globalPosition.toString(),
  };
}

/** One reducer entry per committed event type — the fold refuses an unlisted type
 *  rather than skipping it, so the caller enumerates the ledger's actual types.
 *  Null prototype on purpose: an event type named "__proto__" must become an own key
 *  that `Object.hasOwn` dispatch can see, never a prototype write. */
export function boardReducersFor(
  eventTypes: readonly string[],
): Readonly<Record<string, ProjectionReducer>> {
  const reducers = Object.create(null) as Record<string, ProjectionReducer>;
  for (const eventType of eventTypes) {
    reducers[eventType] = foldBoardEvent;
  }
  return Object.freeze(reducers);
}
