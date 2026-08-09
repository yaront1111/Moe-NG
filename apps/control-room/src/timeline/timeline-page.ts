import { MAX_VIEW_RECORDS } from "../data/data-contract.js";
import { TIMELINE_TRUNCATION_CODE, refuseTimeline } from "./timeline-contract.js";
import type {
  TimelineRefused,
  TimelineRow,
  TimelineSourcePage,
  TimelineTruncation,
  TimelineWalkResult,
} from "./timeline-contract.js";

/**
 * A pure cursor walk over caller-supplied pages.
 *
 * No fetch, no socket, no timer, no clock: the source is a function the caller hands in,
 * so the whole module is deterministic. It sorts nothing and reorders nothing — an
 * out-of-order page is refused, because sorting it into place would be asserting an
 * ordering the daemon never stated.
 *
 * THE CONTINUATION IS RECOMPUTED FROM THE WALK. `page.nextCursor` is never read, here or
 * anywhere below. A page's envelope describes what the SOURCE served, and three separate
 * things can make that stop describing this walk: the display filter, the view bound, and
 * a restart gap. Trusting the envelope after any of them produces an early,
 * successful-looking termination — a silent gap, which is strictly worse than a crash.
 * See `mem:gotcha-clamped-page-must-not-trust-unclamped-hasmore`.
 *
 * The two droppers are NOT the same and must not be conflated:
 *   EXAMINED — every row of the page the walk looked at. The filter does not reduce this,
 *              because a filtered row was seen and deliberately not displayed.
 *   ADMITTED — the rows that reached the view. The bound reduces this, and a row that was
 *              never admitted has not been walked past.
 * So the walk is complete only when the source says there is no more AND the whole final
 * page was examined AND nothing overflowed the bound. That is the store's
 * `kept.length === page.items.length` fix with `examined` in its correct place: using
 * `admitted` here would make a page emptied by the filter unable to ever terminate.
 */

export type TimelinePageSource = (cursor: number | null) => TimelineSourcePage;

export type TimelineRowFilter = (row: TimelineRow) => boolean;

export interface TimelineWalkRequest {
  /** Narrows what is displayed. `null` displays every row the source served. */
  readonly filter: TimelineRowFilter | null;
  readonly maxRows: number;
  readonly source: TimelinePageSource;
  /**
   * CALLER OBLIGATION: a continuation cursor is only valid for the FILTER that produced
   * it. Rows this walk examined and filtered out sit behind the returned cursor, so
   * resuming from it under a widened filter would skip them. `TimelineList` satisfies
   * this by re-walking from its own `startCursor` whenever the selection changes; any
   * caller persisting a cursor must persist the filter beside it.
   */
  readonly startCursor: number | null;
}

/**
 * A restart gap belongs to the STREAM, not to any node, actor, or event type, so no
 * filter can hide one. Dropping it would remove the only visible evidence that the
 * stream is discontinuous, which is the silent gap this whole module exists to prevent.
 */
function survivesFilter(row: TimelineRow, filter: TimelineRowFilter | null): boolean {
  if (row.kind === "RESTART_GAP") return true;
  return filter === null || filter(row);
}

/**
 * Sequences must ascend strictly, and the first row of a page must sit beyond the cursor
 * it was served for. The second half is also what makes the walk terminate: a source that
 * re-serves a page it already served is refused rather than looped over.
 */
function orderRefusal(
  rows: readonly TimelineRow[],
  cursor: number | null,
): TimelineRefused | null {
  let previous = cursor;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.sequence)) {
      return refuseTimeline(
        "TIMELINE_SEQUENCE_OUT_OF_ORDER",
        "PAGING",
        `row sequence must be a safe integer; received ${String(row.sequence)}`,
      );
    }
    if (previous !== null && row.sequence <= previous) {
      return refuseTimeline(
        "TIMELINE_SEQUENCE_OUT_OF_ORDER",
        "PAGING",
        `row #${String(row.sequence)} does not advance past #${String(previous)}`,
      );
    }
    previous = row.sequence;
  }
  return null;
}

/**
 * Reads one page, converting a thrown source into a stated refusal.
 *
 * The source is supplied by whatever wires the daemon client to this surface, so a
 * transport or decode failure surfaces here as an exception. Letting it propagate would
 * blank the whole control room — failing OPEN — while the operator is looking at the one
 * screen that is supposed to explain what went wrong.
 */
function readPage(
  source: TimelinePageSource,
  cursor: number | null,
): TimelineSourcePage | TimelineRefused {
  try {
    return source(cursor);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return refuseTimeline(
      "TIMELINE_SOURCE_FAILED",
      "PAGING",
      `the page source failed after #${String(cursor)}: ${detail}`,
    );
  }
}

/** Fills the view up to the bound and returns the first row that did not fit. */
function admitRows(
  into: TimelineRow[],
  rows: readonly TimelineRow[],
  limit: number,
): TimelineRow | null {
  for (const row of rows) {
    if (into.length >= limit) return row;
    into.push(row);
  }
  return null;
}

function truncationAt(overflow: TimelineRow, limit: number): TimelineTruncation {
  return Object.freeze({
    code: TIMELINE_TRUNCATION_CODE,
    droppedFromSequence: overflow.sequence,
    limit,
  });
}

function walkedResult(
  rows: readonly TimelineRow[],
  nextCursor: number | null,
  complete: boolean,
  truncation: TimelineTruncation | null,
): TimelineWalkResult {
  return Object.freeze({
    complete,
    nextCursor,
    outcome: "WALKED" as const,
    rows: Object.freeze(rows),
    truncation,
  });
}

/**
 * Walks pages until the source is exhausted, the view bound is reached, or a page is
 * refused. Restart gaps are admitted as ordinary rows carrying exactly what the daemon
 * stated about them; the walk never reads a gap's `lastGoodSequence` as a cursor, because
 * rewinding to it would re-derive a span the daemon has not reconciled.
 */
export function walkTimeline(request: TimelineWalkRequest): TimelineWalkResult {
  const { filter, maxRows, source, startCursor } = request;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    return refuseTimeline(
      "TIMELINE_LIMIT_INVALID",
      "INPUT",
      `maxRows must be a positive safe integer; received ${String(maxRows)}`,
    );
  }
  const limit = Math.min(maxRows, MAX_VIEW_RECORDS);
  const admitted: TimelineRow[] = [];
  let cursor = startCursor;

  for (;;) {
    const page = readPage(source, cursor);
    // `TimelineSourcePage` carries no outcome, so its presence IS the refusal.
    if ("outcome" in page) return page;
    const refusal = orderRefusal(page.rows, cursor);
    if (refusal !== null) return refusal;
    if (page.rows.length === 0) {
      if (page.hasMore) {
        return refuseTimeline(
          "TIMELINE_CURSOR_NOT_ADVANCING",
          "PAGING",
          `source reported more rows after #${String(cursor)} but supplied none`,
        );
      }
      return walkedResult(admitted, cursor, true, null);
    }
    const shown = page.rows.filter((row) => survivesFilter(row, filter));
    const overflow = admitRows(admitted, shown, limit);
    if (overflow !== null) {
      // The bound cut this page short, so the continuation is the last row ADMITTED:
      // everything from the overflow row onward has not been walked past.
      const lastAdmitted = admitted.at(-1);
      const resumeAt = lastAdmitted === undefined ? cursor : lastAdmitted.sequence;
      return walkedResult(admitted, resumeAt, false, truncationAt(overflow, limit));
    }
    // The whole page was examined, so the continuation is its last row regardless of how
    // many the filter removed.
    const lastExamined = page.rows.at(-1);
    cursor = lastExamined === undefined ? cursor : lastExamined.sequence;
    if (!page.hasMore) return walkedResult(admitted, cursor, true, null);
  }
}
