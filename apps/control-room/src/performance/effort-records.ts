/**
 * The frozen vocabulary for decision-effort and attention OBSERVATIONS.
 *
 * This domain records what a human actually had to do. Every record below is frozen,
 * names the source that observed it, and is attributable to the command identity that
 * carried it — or says, in one explicit word, that no command identity was observed.
 *
 * Four rules shape everything here and in the collector beside it.
 *
 * 1. NOTHING IS INFERRED FROM ANYTHING ELSE. A free interaction is not a demanded
 *    decision, an away interval is not the absence of a focus interval, and a recovery
 *    burden is not a count of recovery actions. Each is observed on its own or it is not
 *    recorded at all.
 * 2. AN OBSERVATION MISSING ITS SOURCE OR ITS COMMAND IDENTITY IS A REFUSAL, not a weaker
 *    observation — the discipline `wire-timing.ts` states for clocks and observers. A
 *    record with no provenance is refused with an exact code; it is never stored with a
 *    default source, because a defaulted source looks exactly like an observed one.
 * 3. THE CODES ARE OUR OWN. The SHAPE mirrors `timing.ts` — a frozen `{code, layer}`
 *    refusal, absent checked before unparseable, no translation table — but the
 *    identifiers do not. An unterminated focus interval is not a timing fact, and
 *    reusing TIMING_SOURCE_ABSENT for it would make two different facts indistinguishable
 *    at every consumer.
 * 4. OBSERVATIONAL ONLY. Nothing here produces a duration, a score, a threshold or a
 *    verdict, and nothing here reads a benchmark constant. A recorded observation grants
 *    no authority; it is evidence that something happened, and nothing more.
 */

/**
 * Two layers can refuse, so both are named. Admission refuses a payload that is not an
 * observation; the collector refuses an observation that contradicts the sequence already
 * recorded. A test asserting only "refused" could not tell them apart, and a guard moving
 * from one layer to the other would leave that test green while testing nothing.
 */
export const EFFORT_ADMISSION_LAYER = "CONTROL_ROOM_EFFORT_ADMISSION";
export const EFFORT_COLLECTOR_LAYER = "CONTROL_ROOM_EFFORT_COLLECTOR";

export const EFFORT_LAYERS = Object.freeze([
  EFFORT_ADMISSION_LAYER,
  EFFORT_COLLECTOR_LAYER,
] as const);

export type EffortLayer = (typeof EFFORT_LAYERS)[number];

/**
 * Seven facts, seven codes; each names something the other six cannot say.
 *
 * COMMAND_IDENTITY_ABSENT and SOURCE_ABSENT are deliberately not one code: an observation
 * nobody can attribute and an observation nobody can be shown to have taken are different
 * failures with different fixes. INTERVAL_OVERLAPPING and INTERVAL_UNTERMINATED are
 * likewise distinct — one is a contradiction between two intervals, the other is a single
 * interval whose end was never observed, and merging them would hide which happened.
 * OBSERVATION_ABSENT is "no such observation exists"; OBSERVATION_UNPARSEABLE is "one
 * arrived and was malformed"; OBSERVATION_CONTRADICTORY is "one arrived and disagrees
 * with what this domain already holds, or asserts a fact only this domain may derive".
 */
export const EFFORT_UNKNOWN_CODES = Object.freeze([
  "EFFORT_COMMAND_IDENTITY_ABSENT",
  "EFFORT_INTERVAL_OVERLAPPING",
  "EFFORT_INTERVAL_UNTERMINATED",
  "EFFORT_OBSERVATION_ABSENT",
  "EFFORT_OBSERVATION_CONTRADICTORY",
  "EFFORT_OBSERVATION_UNPARSEABLE",
  "EFFORT_SOURCE_ABSENT",
] as const);

export type EffortUnknownCode = (typeof EFFORT_UNKNOWN_CODES)[number];

/** Where an observation came from. Stated by the observer; never defaulted. */
export const EFFORT_SOURCES = Object.freeze([
  "CONTROL_ROOM_DOM",
  "CONTROL_ROOM_INPUT",
  "OPERATOR_REPORT",
  "SESSION_RECORDING",
] as const);

export type EffortSource = (typeof EFFORT_SOURCES)[number];

/**
 * The decisions a surface may DEMAND of a human. ADDITIONAL is absent from this set on
 * purpose: a caller able to declare "this is the first decision" could hide every
 * subsequent one, so additional-ness is derived from the observed sequence instead.
 */
export const BASELINE_DECISION_KINDS = Object.freeze([
  "ACCEPT",
  "APPROVE",
  "CREATE",
] as const);

export type BaselineDecisionKind = (typeof BASELINE_DECISION_KINDS)[number];

/** The kind a recorded demand resolves to — a baseline kind, or the derived arm. */
export const DECISION_KINDS = Object.freeze([
  "ACCEPT",
  "ADDITIONAL",
  "APPROVE",
  "CREATE",
] as const);

export type DecisionKind = (typeof DECISION_KINDS)[number];

export const ADDITIONAL_DECISION_KIND = "ADDITIONAL";

/** Focus and away are recorded separately; neither is ever derived from the other. */
export const INTERVAL_KINDS = Object.freeze(["AWAY", "FOCUS"] as const);

export type IntervalKind = (typeof INTERVAL_KINDS)[number];

/**
 * OPEN is a live interval still accepting its close. UNTERMINATED is what OPEN becomes
 * once the observation set is sealed with no close ever observed — a refusal, not a
 * duration and not a zero.
 */
export const INTERVAL_STATES = Object.freeze([
  "CLOSED",
  "CONTRADICTORY",
  "OPEN",
  "OVERLAPPING",
  "UNTERMINATED",
] as const);

export type IntervalState = (typeof INTERVAL_STATES)[number];

/** What the human had to do to recover. Observed on the action; never counted into. */
export const RECOVERY_BURDENS = Object.freeze([
  "MANUAL_REPAIR",
  "REDO_FROM_SCRATCH",
  "RETRY_SAME_COMMAND",
  "UNRECOVERED",
] as const);

export type RecoveryBurden = (typeof RECOVERY_BURDENS)[number];

export const EFFORT_RECORD_TYPES = Object.freeze([
  "ATTENTION_SWITCH",
  "DEMANDED_DECISION",
  "FREE_INTERACTION",
  "INTERVAL_CLOSE",
  "INTERVAL_OPEN",
  "RECOVERY_ACTION",
  "SCROLL_FOCUS_EVIDENCE",
] as const);

export type EffortRecordType = (typeof EFFORT_RECORD_TYPES)[number];

/**
 * The one word for "this observation carried no command identity". It is stated by the
 * observer and stored verbatim: an unattributed observation is never assigned to the most
 * recent command, because that guess becomes indistinguishable from a measurement one
 * layer later, and is exactly what makes effort numbers untrustworthy.
 */
export const UNATTRIBUTED = "UNATTRIBUTED";

/**
 * A refusal, carrying the code AND the layer that refused. There is deliberately no
 * translation table between this family and any other: mapping another layer's code onto
 * one of ours would put our guess where their answer belongs.
 */
export interface EffortRefusal {
  readonly code: EffortUnknownCode;
  readonly known: false;
  readonly layer: EffortLayer;
}

export function effortRefusal(code: EffortUnknownCode, layer: EffortLayer): EffortRefusal {
  return Object.freeze({ code, known: false as const, layer });
}

/** Every record carries these four, and no record is admitted without all four. */
export interface EffortRecordBase {
  /** A command identity, or {@link UNATTRIBUTED}. Never a default, never a guess. */
  readonly commandId: string;
  readonly known: true;
  /** A timestamp the OBSERVER read. This domain owns no clock and never takes one. */
  readonly observedAt: number;
  readonly source: EffortSource;
}

export interface AttentionSwitchRecord extends EffortRecordBase {
  readonly fromSurface: string;
  readonly toSurface: string;
  readonly type: "ATTENTION_SWITCH";
}

/** What the surface DEMANDED. Whether it was an additional demand is derived, not stated. */
export interface DemandedDecisionRecord extends EffortRecordBase {
  readonly demandedKind: BaselineDecisionKind;
  readonly type: "DEMANDED_DECISION";
}

export interface FreeInteractionRecord extends EffortRecordBase {
  readonly interaction: string;
  readonly type: "FREE_INTERACTION";
}

export interface IntervalCloseRecord extends EffortRecordBase {
  readonly intervalKind: IntervalKind;
  readonly type: "INTERVAL_CLOSE";
}

export interface IntervalOpenRecord extends EffortRecordBase {
  readonly intervalKind: IntervalKind;
  readonly type: "INTERVAL_OPEN";
}

/** The burden is OBSERVED on the action. It is never counted up from several of them. */
export interface RecoveryActionRecord extends EffortRecordBase {
  readonly action: string;
  readonly burden: RecoveryBurden;
  readonly type: "RECOVERY_ACTION";
}

export interface ScrollFocusEvidenceRecord extends EffortRecordBase {
  readonly evidence: string;
  readonly surface: string;
  readonly type: "SCROLL_FOCUS_EVIDENCE";
}

export type EffortRecord =
  | AttentionSwitchRecord
  | DemandedDecisionRecord
  | FreeInteractionRecord
  | IntervalCloseRecord
  | IntervalOpenRecord
  | RecoveryActionRecord
  | ScrollFocusEvidenceRecord;

/** Admission answers with a record, or with the exact reason there is none. */
export type EffortAdmission = EffortRecord | EffortRefusal;
