import { UNSTATED } from "../data/data-contract.js";
/**
 * Presentation vocabulary for the causal timeline (spec §2.4, §4.5).
 *
 * "Causal" here means rendering the causal links the daemon STATED — aggregate, command
 * id, effect, lease epoch. It never means inferring causality from ordering. Nothing in
 * this module opens a socket, reads a clock, sorts, ranks, or upgrades anything: the rows
 * arrive already sequenced and already classified, and the only distinction this layer
 * adds is "the daemon said X" versus "the daemon said nothing".
 */
/** Row kinds §2.4 names: ordinary events, rejected commands, restart gap markers. */
export const TIMELINE_ROW_KINDS = Object.freeze(["EVENT", "REJECTED", "RESTART_GAP"]);
/** The three filter axes §2.4 pins as `cr.timeline.filter.{node|actor|type}`. */
export const TIMELINE_FILTER_FIELDS = Object.freeze(["actor", "node", "type"]);
/**
 * The daemon's gap token, pinned locally as DATA rather than imported.
 *
 * `CURSOR_GAP` is declared in `@moe/store` and `@moe/coordination`, and this app depends
 * on neither — every daemon fact reaches the UI through the gated client, so the outcome
 * arrives as payload text. Importing the producer's contract would be a second path to
 * daemon truth and would drag a reducer package into a presentation layer.
 */
export const TIMELINE_GAP_OUTCOME = "CURSOR_GAP";
/**
 * Which layer refused. More than one can, so a test asserting only "refused" would stay
 * green while a different layer silently started answering first.
 */
export const TIMELINE_REFUSAL_LAYERS = Object.freeze(["INPUT", "PAGING", "RENDER"]);
/** Every code here is reachable; an unreachable code is a claim no test can pin. */
export const TIMELINE_REFUSAL_CODES = Object.freeze([
    "TIMELINE_CURSOR_NOT_ADVANCING",
    "TIMELINE_LIMIT_INVALID",
    "TIMELINE_ROW_KIND_UNSUPPORTED",
    "TIMELINE_SEQUENCE_OUT_OF_ORDER",
    "TIMELINE_SOURCE_FAILED",
]);
/**
 * Hitting the view bound is REPORTED, not refused: the rows already walked are real and
 * withholding them would lose truth. It gets its own code so the report can never be
 * mistaken for a completed walk.
 */
export const TIMELINE_TRUNCATION_CODE = "TIMELINE_VIEW_LIMIT_REACHED";
/**
 * §4.5's cursor line, in one place so the timeline and the evidence surface cannot drift
 * into two different readings of the same position.
 */
export function describeCursor(cursor) {
    const applied = cursor.appliedSequence === null ? UNSTATED : String(cursor.appliedSequence);
    const latest = cursor.latestSequence === null ? UNSTATED : String(cursor.latestSequence);
    return `applied #${applied} of #${latest} · ${cursor.live ? "live" : "not live"}`;
}
export function refuseTimeline(code, layer, detail) {
    return Object.freeze({ code, detail, layer, outcome: "REFUSED" });
}
/**
 * A supplied value, or null when the payload supplied nothing usable.
 *
 * Whitespace counts as absent. A blank string rendered beside a DAEMON_STATED marker is
 * a confident label attached to nothing — the same "never blank" failure
 * `node-authority.readValue` already guards against on the fact path.
 */
export function statedValue(value) {
    return value === null || value.trim() === "" ? null : value;
}
/**
 * The one distinction this layer adds, reusing `data-contract`'s two-armed vocabulary
 * rather than declaring a second one. There is no third arm, because a third arm would
 * be an inference.
 */
export function statedProvenance(value) {
    if (typeof value === "string")
        return statedValue(value) === null ? "ABSENT" : "DAEMON_STATED";
    return value === null || value === undefined ? "ABSENT" : "DAEMON_STATED";
}
