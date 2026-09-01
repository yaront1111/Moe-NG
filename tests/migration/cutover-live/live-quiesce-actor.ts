/**
 * The actor half of the LIVE legacy quiesce (task-e60b874b).
 *
 * BUILT HERE, RUN BY NOTHING UNTIL STEP 8. Importing this module takes no
 * action: it declares ports and never supplies a real implementation of them.
 * The real ports live in live-quiesce-main.ts, which is invoked by hand.
 *
 * THE ONE CONTRACT. A result is derived from an OBSERVATION TAKEN AFTER THE
 * STOP — re-query the process, handle, watcher, scheduled start or path and
 * record what came back — NEVER from the stop command's own exit code. On
 * Windows a stop that exits 0 while the thing is still running is the ordinary
 * case, not an exotic one, so `StopAttempt.exitCode` is recorded for the
 * transcript and is deliberately not consulted by any branch below.
 *
 * WHY THE OBSERVATION POLLS. Measured on this host: `taskkill /PID n /T /F`
 * returns roughly 78ms BEFORE the pid leaves `tasklist` (8/8 samples, min 68ms,
 * max 100ms), because the kill is asynchronous — taskkill exits once the kill is
 * REQUESTED. A single post-stop sample would therefore refuse nearly every real
 * process stop with a false STILL_LIVE. The budget counts POLLS rather than
 * milliseconds so the bound is deterministic across hosts and suite load; a
 * genuinely stopped item leaves on the first poll or two, so the budget is only
 * ever spent on the failing path.
 */

import {
  LIVE_QUIESCE_KINDS,
  type LiveQuiesceItem,
} from "./live-quiesce-inventory.js";

export const LIVE_QUIESCE_ACTOR_LAYER = "live-quiesce-actor";

export const LIVE_QUIESCE_ACTOR_REFUSAL_CODES = Object.freeze([
  "LIVE_QUIESCE_ITEM_STILL_LIVE",
  "LIVE_QUIESCE_ITEM_UNDENIABLE",
  "LIVE_QUIESCE_OBSERVATION_UNAVAILABLE",
] as const);

export type LiveQuiesceActorRefusalCode = (typeof LIVE_QUIESCE_ACTOR_REFUSAL_CODES)[number];

/** Polls, not milliseconds — see the header note on the measured reap delay. */
export const OBSERVATION_POLL_BUDGET = 200;

/**
 * What the stop port reports. `exitCode` is carried into the transcript for a
 * human reader and is NEVER read by this module: `accepted` means only that the
 * command was issued and not refused outright, which is a different claim from
 * "the thing stopped".
 */
export type StopAttempt =
  | { readonly accepted: true; readonly command: string; readonly exitCode: number }
  | {
      readonly accepted: false;
      readonly command: string;
      readonly refusedByLayer: string;
      readonly detail: string;
    };

export interface Observation {
  readonly live: boolean;
  readonly detail: string;
}

export interface LiveQuiescePorts {
  readonly stop: (item: LiveQuiesceItem) => StopAttempt;
  /** Re-queries the item. Called after the stop, repeatedly, up to the budget. */
  readonly observe: (item: LiveQuiesceItem) => Observation;
}

export interface QuiesceStopped {
  readonly ok: true;
  readonly item: LiveQuiesceItem;
  readonly stopCommand: string;
  readonly observedAfter: Observation;
  readonly pollsUsed: number;
}

export interface QuiesceRefused {
  readonly ok: false;
  readonly layer: typeof LIVE_QUIESCE_ACTOR_LAYER;
  readonly code: LiveQuiesceActorRefusalCode;
  readonly item: LiveQuiesceItem;
  /** Present when an outside layer refused the stop; absent when this layer did. */
  readonly refusedByLayer?: string;
  readonly detail: string;
}

export type QuiesceItemResult = QuiesceStopped | QuiesceRefused;

/**
 * The sweep's verdict. There is deliberately no shape that can carry a
 * class-level claim such as "all processes stopped": the only way to report
 * success is one `QuiesceStopped` per item, each with its own observation.
 */
export type SweepOutcome = "COMPLETE" | "PARTIAL" | "EMPTY";

export interface QuiesceSweep {
  readonly inputCount: number;
  /** Recorded next to inputCount so a dropped item is visible, not inferred. */
  readonly resultCount: number;
  readonly results: readonly QuiesceItemResult[];
  readonly outcome: SweepOutcome;
}

const refuse = (
  code: LiveQuiesceActorRefusalCode,
  item: LiveQuiesceItem,
  detail: string,
  refusedByLayer?: string,
): QuiesceRefused => ({
  ok: false,
  layer: LIVE_QUIESCE_ACTOR_LAYER,
  code,
  item,
  ...(refusedByLayer === undefined ? {} : { refusedByLayer }),
  detail,
});

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Stops one item and grades it on what the host says afterwards.
 *
 * Refuses rather than guessing in all three failure shapes: the stop was not
 * accepted, the item outlived the observation budget, or the probe could not
 * answer at all. None of the three may be upgraded to success (DoD 3).
 */
export const quiesceItem = (
  item: LiveQuiesceItem,
  ports: LiveQuiescePorts,
): QuiesceItemResult => {
  let attempt: StopAttempt;
  try {
    attempt = ports.stop(item);
  } catch (error: unknown) {
    return refuse(
      "LIVE_QUIESCE_ITEM_UNDENIABLE",
      item,
      `the stop threw before it was issued: ${describeError(error)}`,
      LIVE_QUIESCE_ACTOR_LAYER,
    );
  }

  if (!attempt.accepted) {
    return refuse(
      "LIVE_QUIESCE_ITEM_UNDENIABLE",
      item,
      `${attempt.command} was refused: ${attempt.detail}`,
      attempt.refusedByLayer,
    );
  }

  // From here the stop was ISSUED. Whether it WORKED is a separate question,
  // and only the observation below may answer it. `attempt.exitCode` is not read.
  let lastDetail = "the observation was never taken";
  for (let poll = 1; poll <= OBSERVATION_POLL_BUDGET; poll += 1) {
    let observed: Observation;
    try {
      observed = ports.observe(item);
    } catch (error: unknown) {
      return refuse(
        "LIVE_QUIESCE_OBSERVATION_UNAVAILABLE",
        item,
        `the post-stop probe failed on poll ${poll}: ${describeError(error)}`,
        LIVE_QUIESCE_ACTOR_LAYER,
      );
    }

    lastDetail = observed.detail;
    if (!observed.live) {
      return {
        ok: true,
        item,
        stopCommand: attempt.command,
        observedAfter: observed,
        pollsUsed: poll,
      };
    }
  }

  return refuse(
    "LIVE_QUIESCE_ITEM_STILL_LIVE",
    item,
    `${item.id} was still live after ${OBSERVATION_POLL_BUDGET} polls; last observation: ${lastDetail}`,
    LIVE_QUIESCE_ACTOR_LAYER,
  );
};

/**
 * One result per input item, always. The counts are recorded rather than
 * derived at the call site so that a dropped item shows up as a mismatch
 * instead of disappearing quietly.
 *
 * An empty sweep is `EMPTY`, never `COMPLETE`: nothing was stopped, so nothing
 * is proven, and a vacuous green here would be exactly the class-level claim
 * this module exists to make unrepresentable.
 */
export const quiesceAll = (
  items: readonly LiveQuiesceItem[],
  ports: LiveQuiescePorts,
): QuiesceSweep => {
  const results = items.map((item) => quiesceItem(item, ports));
  const outcome: SweepOutcome =
    results.length === 0 ? "EMPTY" : results.every((result) => result.ok) ? "COMPLETE" : "PARTIAL";

  return {
    inputCount: items.length,
    resultCount: results.length,
    results,
    outcome,
  };
};

/** Re-exported so a consumer sees one roster, not two spellings of it. */
export { LIVE_QUIESCE_KINDS };
