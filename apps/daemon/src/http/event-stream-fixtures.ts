import type {
  SeamObserver,
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

/**
 * Hand-written cardinalities. The ledger is generated, so a test that only checked
 * "some events had a trace" would still pass if the generator silently produced none.
 */
export const LEDGER_SIZE = 10;
export const TRACED_EVENT_COUNT = 4;
export const UNTRACED_EVENT_COUNT = 6;

/** The reading the injected seam clock hands back, distinct from every committedAt above. */
export const SEAM_READING = "2026-08-09T00:05:00.000Z";

const LEDGER: readonly StreamEvent[] = Object.freeze(
  Array.from({ length: LEDGER_SIZE }, (_unused, index): StreamEvent => {
    const position = index + 1;
    const tag = String(position).padStart(2, "0");
    const base = {
      aggregateId: "goal-0001",
      commandId: `cmd-${tag}`,
      committedAt: `2026-08-09T00:00:${tag}.000Z`,
      eventId: `evt-${tag}`,
      eventType: "goal.created",
      globalPosition: BigInt(position),
    };
    // A decision trace is absent for non-decision events, exactly as the store emits them.
    if (position > TRACED_EVENT_COUNT) return Object.freeze(base);
    return Object.freeze({
      ...base,
      decisionTrace: Object.freeze({
        commandId: base.commandId,
        commandKind: "goal.create",
        principalId: `principal-${tag}`,
        projectId: "proj-0001",
        requestIdentityVersion: "1",
        requestSha256: "a".repeat(64),
      }),
    });
  }),
);

/** The source page, so a test can compare the wire against it rather than against itself. */
export const LEDGER_EVENTS: readonly StreamEvent[] = LEDGER;

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
  /** Emits a first event whose committedAt is present but unusable as a reading. */
  readonly unusableReading?: boolean;
}

export interface SeamObserverDouble extends SeamObserver {
  readonly calls: () => number;
}

/** Counts readings, so "one observation per frame" can be asserted rather than assumed. */
export function seamObserver(reading: string = SEAM_READING): SeamObserverDouble {
  let calls = 0;
  return {
    calls: () => calls,
    now(): string {
      calls += 1;
      return reading;
    },
  };
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
      const visible = LEDGER.filter((event) => event.globalPosition > cursor);
      const events = options.unusableReading === true
        ? visible.map((event, index) =>
          index === 0 ? Object.freeze({ ...event, committedAt: "" }) : event)
        : visible;
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
