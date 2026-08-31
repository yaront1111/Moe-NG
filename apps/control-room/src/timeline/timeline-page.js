import { MAX_VIEW_RECORDS } from "../data/data-contract.js";
import { TIMELINE_TRUNCATION_CODE, refuseTimeline } from "./timeline-contract.js";
/**
 * A restart gap belongs to the STREAM, not to any node, actor, or event type, so no
 * filter can hide one. Dropping it would remove the only visible evidence that the
 * stream is discontinuous, which is the silent gap this whole module exists to prevent.
 */
function survivesFilter(row, filter) {
    if (row.kind === "RESTART_GAP")
        return true;
    return filter === null || filter(row);
}
/**
 * Sequences must ascend strictly, and the first row of a page must sit beyond the cursor
 * it was served for. The second half is also what makes the walk terminate: a source that
 * re-serves a page it already served is refused rather than looped over.
 */
function orderRefusal(rows, cursor) {
    let previous = cursor;
    for (const row of rows) {
        if (!Number.isSafeInteger(row.sequence)) {
            return refuseTimeline("TIMELINE_SEQUENCE_OUT_OF_ORDER", "PAGING", `row sequence must be a safe integer; received ${String(row.sequence)}`);
        }
        if (previous !== null && row.sequence <= previous) {
            return refuseTimeline("TIMELINE_SEQUENCE_OUT_OF_ORDER", "PAGING", `row #${String(row.sequence)} does not advance past #${String(previous)}`);
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
function readPage(source, cursor) {
    try {
        return source(cursor);
    }
    catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        return refuseTimeline("TIMELINE_SOURCE_FAILED", "PAGING", `the page source failed after #${String(cursor)}: ${detail}`);
    }
}
/** Fills the view up to the bound and returns the first row that did not fit. */
function admitRows(into, rows, limit) {
    for (const row of rows) {
        if (into.length >= limit)
            return row;
        into.push(row);
    }
    return null;
}
function truncationAt(overflow, limit) {
    return Object.freeze({
        code: TIMELINE_TRUNCATION_CODE,
        droppedFromSequence: overflow.sequence,
        limit,
    });
}
function walkedResult(rows, nextCursor, complete, truncation) {
    return Object.freeze({
        complete,
        nextCursor,
        outcome: "WALKED",
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
export function walkTimeline(request) {
    const { filter, maxRows, source, startCursor } = request;
    if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
        return refuseTimeline("TIMELINE_LIMIT_INVALID", "INPUT", `maxRows must be a positive safe integer; received ${String(maxRows)}`);
    }
    const limit = Math.min(maxRows, MAX_VIEW_RECORDS);
    const admitted = [];
    let cursor = startCursor;
    for (;;) {
        const page = readPage(source, cursor);
        // `TimelineSourcePage` carries no outcome, so its presence IS the refusal.
        if ("outcome" in page)
            return page;
        const refusal = orderRefusal(page.rows, cursor);
        if (refusal !== null)
            return refusal;
        if (page.rows.length === 0) {
            if (page.hasMore) {
                return refuseTimeline("TIMELINE_CURSOR_NOT_ADVANCING", "PAGING", `source reported more rows after #${String(cursor)} but supplied none`);
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
        if (!page.hasMore)
            return walkedResult(admitted, cursor, true, null);
    }
}
