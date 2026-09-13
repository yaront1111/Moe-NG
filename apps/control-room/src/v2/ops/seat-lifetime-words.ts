import type { SeatExitView } from "../../live/live-sessions.js";
import { agoWords } from "./activity-words.js";

/**
 * WHAT A SEAT ROW MAY SAY ABOUT WHEN IT STARTED AND HOW IT ENDED.
 *
 * Pure, so the two claims that matter are testable without a renderer: an absence is NAMED
 * ("not recorded"), never filled with the browser's clock or a plausible kind; and a recorded
 * exit is rendered from the record's own members - kind, exit code, last line - with nothing
 * inferred from them.
 *
 * Measured on a live drive: a seat that hung for seven minutes with zero network read "live
 * until <expiry>" exactly like a working seat, and its exit showed as one more "closed" in a
 * count. Both facts were durable on the daemon; neither had words here.
 */

export const START_NOT_RECORDED = "start not recorded";
export const EXIT_REASON_NOT_RECORDED = "reason not recorded";

/** "started 12 min ago", or the stated absence. Never the browser's own clock. */
export function seatStartWords(startedAt: string | null, nowMs: number): string {
  return startedAt === null ? START_NOT_RECORDED : `started ${agoWords(startedAt, nowMs)}`;
}

/**
 * The kinds the wrapper's classifier writes (`seat-exit-classifier.ts` SEAT_EXIT_KINDS), in a
 * person's words. Matched here rather than imported: this package must not depend on the daemon's
 * sources. An unrostered kind renders as the daemon spelled it, never as blank.
 */
const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
  PROVIDER_LIMIT: "stopped by a provider limit",
});

/**
 * "failed, exit code 1" / "failed, no exit code (ended on a signal)" / "reason not recorded".
 *
 * A null exit code means the seat died on a signal: that is the record's DOCUMENTED meaning
 * (apps/daemon/src/orchestrator/provider-pause-contracts.ts: "Null when the seat died on a signal
 * rather than an exit code"), not this screen's inference. `Object.hasOwn` and not a bare index:
 * the kind arrives from the wire, and a plain-object map answers `toString` from its prototype.
 */
export function seatExitReasonWords(exit: SeatExitView | null): string {
  if (exit === null) return EXIT_REASON_NOT_RECORDED;
  const kind = Object.hasOwn(KIND_WORDS, exit.kind) ? KIND_WORDS[exit.kind] ?? exit.kind : exit.kind;
  const code = exit.exitCode === null ? "no exit code (ended on a signal)" : `exit code ${String(exit.exitCode)}`;
  return `${kind}, ${code}`;
}

/**
 * The seat's last printed line, verbatim, or "(no output)" - the words the pause banner already
 * uses for the same field. Null when there is no record, so the row renders no line at all.
 */
export function seatExitLineWords(exit: SeatExitView | null): string | null {
  if (exit === null) return null;
  return exit.lastLine === null || exit.lastLine.trim() === "" ? "(no output)" : exit.lastLine;
}
