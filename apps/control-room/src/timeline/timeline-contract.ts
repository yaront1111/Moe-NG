import { UNSTATED } from "../data/data-contract.js";
import type { FieldProvenance } from "../data/data-contract.js";

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
export const TIMELINE_ROW_KINDS = Object.freeze(["EVENT", "REJECTED", "RESTART_GAP"] as const);

export type TimelineRowKind = (typeof TIMELINE_ROW_KINDS)[number];

/** The three filter axes §2.4 pins as `cr.timeline.filter.{node|actor|type}`. */
export const TIMELINE_FILTER_FIELDS = Object.freeze(["actor", "node", "type"] as const);

export type TimelineFilterField = (typeof TIMELINE_FILTER_FIELDS)[number];

/**
 * The daemon's gap token, pinned locally as DATA rather than imported.
 *
 * `CURSOR_GAP` is declared in `@moe/store` and `@moe/coordination`, and this app depends
 * on neither — every daemon fact reaches the UI through the gated client, so the outcome
 * arrives as payload text. Importing the producer's contract would be a second path to
 * daemon truth and would drag a reducer package into a presentation layer.
 */
export const TIMELINE_GAP_OUTCOME = "CURSOR_GAP" as const;

/**
 * Which layer refused. More than one can, so a test asserting only "refused" would stay
 * green while a different layer silently started answering first.
 */
export const TIMELINE_REFUSAL_LAYERS = Object.freeze(["INPUT", "PAGING", "RENDER"] as const);

export type TimelineRefusalLayer = (typeof TIMELINE_REFUSAL_LAYERS)[number];

/** Every code here is reachable; an unreachable code is a claim no test can pin. */
export const TIMELINE_REFUSAL_CODES = Object.freeze([
  "TIMELINE_CURSOR_NOT_ADVANCING",
  "TIMELINE_LIMIT_INVALID",
  "TIMELINE_ROW_KIND_UNSUPPORTED",
  "TIMELINE_SEQUENCE_OUT_OF_ORDER",
] as const);

export type TimelineRefusalCode = (typeof TIMELINE_REFUSAL_CODES)[number];

/**
 * Hitting the view bound is REPORTED, not refused: the rows already walked are real and
 * withholding them would lose truth. It gets its own code so the report can never be
 * mistaken for a completed walk.
 */
export const TIMELINE_TRUNCATION_CODE = "TIMELINE_VIEW_LIMIT_REACHED" as const;

/** The typed link §3.2 requires; the daemon names the kind, this layer never picks one. */
export interface TimelineTypedLink {
  readonly kind: string;
  readonly label: string;
  readonly ref: string;
}

/**
 * §3.2's popover field list, which is also this task's provenance checklist.
 *
 * Every field is required-and-nullable rather than optional: `exactOptionalPropertyTypes`
 * is on, and an absent fact must be representable as ABSENT rather than as a key that was
 * never written. `leaseEpoch` null carries §3.2's own meaning — the mutation was not
 * leased — which is why it is the one absence with wording of its own.
 */
export interface TimelineProvenance {
  readonly actor: string | null;
  readonly aggregateId: string | null;
  readonly commandId: string | null;
  readonly effectId: string | null;
  readonly eventId: string | null;
  readonly leaseEpoch: number | null;
  readonly sessionId: string | null;
  readonly timestamp: string | null;
  readonly typedLink: TimelineTypedLink | null;
}

/**
 * `sequence` is the daemon-stated source event sequence and the row's identity in
 * `cr.timeline.row.{eventSeq}`. The walker verifies it is ascending; it never assigns it.
 */
interface TimelineRowBase {
  /** The daemon's own name for what happened, e.g. `step.finish`; §4.5's `type` axis. */
  readonly eventType: string | null;
  readonly kind: TimelineRowKind;
  readonly provenance: TimelineProvenance;
  readonly sequence: number;
  readonly summary: string | null;
  readonly truthClass: unknown;
}

export interface TimelineEventRow extends TimelineRowBase {
  readonly kind: "EVENT";
}

/** §6.5/§8.2: a rejected command is a first-class row carrying its own daemon code. */
export interface TimelineRejectedRow extends TimelineRowBase {
  readonly explain: string | null;
  readonly kind: "REJECTED";
  readonly reasonCode: string | null;
}

/** §13-D3: what the daemon stated about the gap, and nothing re-derived about its span. */
export interface TimelineRestartGapRow extends TimelineRowBase {
  readonly gapOutcome: typeof TIMELINE_GAP_OUTCOME;
  readonly kind: "RESTART_GAP";
  readonly lastGoodSequence: number | null;
  readonly statedCause: string | null;
}

export type TimelineRow = TimelineEventRow | TimelineRejectedRow | TimelineRestartGapRow;

/** §8.6's applied/emitted datum. `live` is stated by the daemon, never inferred here. */
export interface TimelineCursorState {
  readonly appliedSequence: number | null;
  readonly latestSequence: number | null;
  readonly live: boolean;
}

/**
 * §4.5's cursor line, in one place so the timeline and the evidence surface cannot drift
 * into two different readings of the same position.
 */
export function describeCursor(cursor: TimelineCursorState): string {
  const applied = cursor.appliedSequence === null ? UNSTATED : String(cursor.appliedSequence);
  const latest = cursor.latestSequence === null ? UNSTATED : String(cursor.latestSequence);
  return `applied #${applied} of #${latest} · ${cursor.live ? "live" : "not live"}`;
}

/** One page exactly as the source delivered it, before any filter touches it. */
export interface TimelineSourcePage {
  readonly hasMore: boolean;
  readonly nextCursor: number | null;
  readonly rows: readonly TimelineRow[];
}

export interface TimelineTruncation {
  readonly code: typeof TIMELINE_TRUNCATION_CODE;
  readonly droppedFromSequence: number;
  readonly limit: number;
}

export interface TimelineWalked {
  readonly complete: boolean;
  readonly nextCursor: number | null;
  readonly outcome: "WALKED";
  readonly rows: readonly TimelineRow[];
  readonly truncation: TimelineTruncation | null;
}

export interface TimelineRefused {
  readonly code: TimelineRefusalCode;
  readonly detail: string;
  readonly layer: TimelineRefusalLayer;
  readonly outcome: "REFUSED";
}

export type TimelineWalkResult = TimelineRefused | TimelineWalked;

export function refuseTimeline(
  code: TimelineRefusalCode,
  layer: TimelineRefusalLayer,
  detail: string,
): TimelineRefused {
  return Object.freeze({ code, detail, layer, outcome: "REFUSED" as const });
}

/**
 * The one distinction this layer adds, reusing `data-contract`'s two-armed vocabulary
 * rather than declaring a second one. There is no third arm, because a third arm would
 * be an inference.
 */
export function statedProvenance(value: unknown): FieldProvenance {
  return value === null || value === undefined ? "ABSENT" : "DAEMON_STATED";
}
