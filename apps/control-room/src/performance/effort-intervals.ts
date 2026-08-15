import { EFFORT_COLLECTOR_LAYER, effortRefusal } from "./effort-records.js";
import type {
  EffortRefusal,
  EffortSource,
  EffortUnknownCode,
  IntervalCloseRecord,
  IntervalKind,
  IntervalOpenRecord,
} from "./effort-records.js";

/**
 * The focus/away interval state machine.
 *
 * It owns NO clock: every stamp it holds was read by the observer that reported it, as
 * `timing.ts` takes caller-observed pairs and reaches for no time API of its own. It also
 * computes no duration — a closed interval carries both observed stamps and nothing else,
 * because a duration is a timing fact owned by another module, and one number would make
 * "opened and closed" indistinguishable from "measured".
 *
 * Three rules, each of which looks like a bug fix when broken.
 *
 * 1. FOCUS AND AWAY ARE SEPARATE. Neither is derived from the other. An away interval is
 *    not the absence of a focus interval, and nothing here synthesises one from a gap.
 * 2. AN UNTERMINATED INTERVAL STAYS UNKNOWN. It is never closed at read time, never given
 *    a zero length, and never silently closed by the next open of the same kind — which
 *    would be inference wearing the costume of bookkeeping, and would make the
 *    unterminated state unreachable.
 * 3. TWO OVERLAPPING INTERVALS OF ONE KIND ARE A CONTRADICTION, not a merged span. After
 *    a contradiction the kind holds nothing open, because this module cannot know which
 *    of the two a later close belonged to and will not guess.
 */

interface IntervalOutcomeBase {
  readonly commandId: string;
  readonly kind: IntervalKind;
  /** The provenance of the observation that OPENED the interval. */
  readonly source: EffortSource;
}

export interface ClosedIntervalOutcome extends IntervalOutcomeBase {
  readonly closedAt: number;
  readonly openedAt: number;
  readonly state: "CLOSED";
}

/** Live and still accepting its close. Carries no end, and never acquires one by being read. */
export interface OpenIntervalOutcome extends IntervalOutcomeBase {
  readonly openedAt: number;
  readonly state: "OPEN";
}

export interface UnresolvedIntervalOutcome extends IntervalOutcomeBase {
  readonly layer: typeof EFFORT_COLLECTOR_LAYER;
  /** Absent when the contradiction was a close for an interval that was never opened. */
  readonly openedAt?: number;
  readonly reasonCode: EffortUnknownCode;
  readonly state: "CONTRADICTORY" | "OVERLAPPING" | "UNTERMINATED";
}

export type IntervalOutcome =
  | ClosedIntervalOutcome
  | OpenIntervalOutcome
  | UnresolvedIntervalOutcome;

export interface IntervalMachine {
  readonly close: (record: IntervalCloseRecord) => EffortRefusal | null;
  readonly open: (record: IntervalOpenRecord) => EffortRefusal | null;
  readonly outcomes: () => readonly IntervalOutcome[];
  /** Resolves everything still open to UNTERMINATED. Rule 2. */
  readonly sealOpen: () => void;
}

function refuse(code: EffortUnknownCode): EffortRefusal {
  return effortRefusal(code, EFFORT_COLLECTOR_LAYER);
}

/**
 * Turns a live interval into an unresolved one, KEEPING the start that was observed. The
 * start really was watched; only the end is unknown, and dropping it would discard a real
 * observation in order to describe a missing one.
 */
function unresolve(
  open: OpenIntervalOutcome,
  reasonCode: EffortUnknownCode,
  state: UnresolvedIntervalOutcome["state"],
): UnresolvedIntervalOutcome {
  return Object.freeze({
    commandId: open.commandId,
    kind: open.kind,
    layer: EFFORT_COLLECTOR_LAYER,
    openedAt: open.openedAt,
    reasonCode,
    source: open.source,
    state,
  });
}

export function createIntervalMachine(): IntervalMachine {
  const outcomes: IntervalOutcome[] = [];
  /** Kind -> index of its live OPEN outcome. A kind absent here has nothing open. */
  const live = new Map<IntervalKind, number>();

  function liveOpen(kind: IntervalKind): { index: number; open: OpenIntervalOutcome } | null {
    const index = live.get(kind);
    if (index === undefined) return null;
    const open = outcomes[index];
    return open !== undefined && open.state === "OPEN" ? { index, open } : null;
  }

  return Object.freeze({
    close: (record: IntervalCloseRecord): EffortRefusal | null => {
      const existing = liveOpen(record.intervalKind);
      if (existing === null) {
        // A close for an interval nobody observed opening. Recorded as the contradiction
        // it is; NEVER back-dated into an interval this module invents to receive it.
        outcomes.push(Object.freeze({
          commandId: record.commandId,
          kind: record.intervalKind,
          layer: EFFORT_COLLECTOR_LAYER,
          reasonCode: "EFFORT_OBSERVATION_CONTRADICTORY" as const,
          source: record.source,
          state: "CONTRADICTORY" as const,
        }));
        return refuse("EFFORT_OBSERVATION_CONTRADICTORY");
      }
      live.delete(record.intervalKind);
      if (record.observedAt < existing.open.openedAt) {
        // Two stamps that cannot both be right. Surfaced, never smoothed into a span.
        outcomes[existing.index] = unresolve(
          existing.open,
          "EFFORT_OBSERVATION_CONTRADICTORY",
          "CONTRADICTORY",
        );
        return refuse("EFFORT_OBSERVATION_CONTRADICTORY");
      }
      outcomes[existing.index] = Object.freeze({
        closedAt: record.observedAt,
        commandId: existing.open.commandId,
        kind: existing.open.kind,
        openedAt: existing.open.openedAt,
        source: existing.open.source,
        state: "CLOSED" as const,
      });
      return null;
    },
    open: (record: IntervalOpenRecord): EffortRefusal | null => {
      const existing = liveOpen(record.intervalKind);
      if (existing !== null) {
        // Rule 3. The first interval is contradicted rather than closed at this stamp,
        // and the second is refused rather than merged into it.
        outcomes[existing.index] = unresolve(
          existing.open,
          "EFFORT_INTERVAL_OVERLAPPING",
          "OVERLAPPING",
        );
        live.delete(record.intervalKind);
        return refuse("EFFORT_INTERVAL_OVERLAPPING");
      }
      live.set(record.intervalKind, outcomes.length);
      outcomes.push(Object.freeze({
        commandId: record.commandId,
        kind: record.intervalKind,
        openedAt: record.observedAt,
        source: record.source,
        state: "OPEN" as const,
      }));
      return null;
    },
    outcomes: (): readonly IntervalOutcome[] => Object.freeze([...outcomes]),
    sealOpen: (): void => {
      for (const index of live.values()) {
        const open = outcomes[index];
        if (open !== undefined && open.state === "OPEN") {
          outcomes[index] = unresolve(open, "EFFORT_INTERVAL_UNTERMINATED", "UNTERMINATED");
        }
      }
      live.clear();
    },
  });
}
