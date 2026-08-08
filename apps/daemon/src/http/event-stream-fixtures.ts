import type {
  StreamEvent,
  StreamReadResult,
  StreamRefused,
  StreamSeatResult,
  SubscriptionPort,
} from "./event-stream-contract.js";

/**
 * A ledger-backed stand-in for the committed subscription surface. It models the store's
 * arms — PAGE, CURSOR_GAP with a digest-verified snapshot, REFUSED with a SubscriptionCode
 * and layer — and nothing else. It re-implements no seam rule: page shaping, bound checks,
 * arm discipline and the resume decision all live in the production module under test.
 */

export const PROJECTION = "moe.board";
export const SUBSCRIBER = "control-room-1";
export const SNAPSHOT_CHECKPOINT = "4";
export const STATE_DIGEST = "d".repeat(64);

const LEDGER: readonly StreamEvent[] = Object.freeze(
  Array.from({ length: 10 }, (_unused, index): StreamEvent => {
    const position = index + 1;
    return Object.freeze({
      aggregateId: "goal-0001",
      committedAt: `2026-08-09T00:00:${String(position).padStart(2, "0")}.000Z`,
      eventId: `evt-${String(position).padStart(2, "0")}`,
      eventType: "goal.created",
      globalPosition: BigInt(position),
    });
  }),
);

export const LEDGER_EVENT_IDS: readonly string[] = Object.freeze(
  LEDGER.map((event) => event.eventId),
);

export function ledgerIdsUpTo(position: bigint): readonly string[] {
  return LEDGER.filter((event) => event.globalPosition <= position).map((e) => e.eventId);
}

export interface StreamPortDouble extends SubscriptionPort {
  readonly reads: () => number;
  readonly reseats: () => number;
}

export interface StreamPortOptions {
  readonly gap?: string;
  readonly generation?: number;
  readonly refuse?: boolean;
}

const CHECKPOINT = BigInt(SNAPSHOT_CHECKPOINT);

const STALE: StreamRefused = Object.freeze({
  code: "SUBSCRIPTION_SNAPSHOT_STALE",
  detail: "the baseline snapshot no longer covers the requested generation",
  layer: "STATE",
  outcome: "REFUSED",
});

export function streamPort(options: StreamPortOptions = {}): StreamPortDouble {
  const generation = options.generation ?? 1;
  const snapshot = Object.freeze({
    checkpoint: SNAPSHOT_CHECKPOINT, generation, projection: PROJECTION,
    stateDigest: STATE_DIGEST,
  });
  let cursor = 0n;
  let gapPending = options.gap !== undefined;
  let reads = 0;
  let reseats = 0;

  return {
    readPage(): StreamReadResult {
      reads += 1;
      if (options.refuse === true) return STALE;
      if (gapPending && options.gap !== undefined) {
        return Object.freeze({
          cause: options.gap,
          lastGoodCursor: Object.freeze({ generation, position: "0" }),
          outcome: "CURSOR_GAP",
          snapshot,
        });
      }
      const events = LEDGER.filter((event) => event.globalPosition > cursor);
      const last = events.at(-1);
      return Object.freeze({
        checkpoint: 10n,
        events: Object.freeze(events),
        hasMore: false,
        nextCursor: last === undefined
          ? null
          : Object.freeze({ generation, position: String(last.globalPosition) }),
        outcome: "PAGE",
      });
    },
    reads: () => reads,
    reseat(): StreamSeatResult {
      reseats += 1;
      if (options.refuse === true) return STALE;
      cursor = CHECKPOINT;
      gapPending = false;
      return Object.freeze({
        cursor: Object.freeze({ generation, position: SNAPSHOT_CHECKPOINT }),
        outcome: "RESEATED",
        snapshot,
      });
    },
    reseats: () => reseats,
  };
}
