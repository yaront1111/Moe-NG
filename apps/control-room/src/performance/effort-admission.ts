import {
  ADDITIONAL_DECISION_KIND,
  BASELINE_DECISION_KINDS,
  EFFORT_ADMISSION_LAYER,
  EFFORT_RECORD_TYPES,
  EFFORT_SOURCES,
  INTERVAL_KINDS,
  RECOVERY_BURDENS,
  effortRefusal,
} from "./effort-records.js";
import type {
  EffortAdmission,
  EffortRecordBase,
  EffortRecordType,
  EffortRefusal,
  EffortUnknownCode,
} from "./effort-records.js";

/**
 * The one door into the effort domain: an untyped payload becomes a frozen observation,
 * or the exact reason it is not one.
 *
 * This mirrors the shaping discipline `wire-timing.ts` established for the seam — read
 * each field once, copy nothing that was not there, refuse rather than default — and it
 * lives here ONLY. A second admission path is how two callers start disagreeing about
 * what a missing source means.
 *
 * Two rules, both load-bearing.
 *
 * 1. AN OBSERVATION MISSING ITS SOURCE OR ITS COMMAND IDENTITY IS A REFUSAL, not a weaker
 *    observation. A record stored with a defaulted source is indistinguishable from one
 *    whose provenance was actually watched, which is precisely the confusion this domain
 *    exists to prevent. A caller that observed no command identity says so explicitly
 *    with UNATTRIBUTED; silence is refused, because silence and "there was none" are
 *    different facts.
 * 2. ABSENT IS CHECKED BEFORE UNPARSEABLE, per field, matching `fromInterval` in
 *    `timing.ts`, so a missing reading is never reported as a malformed one.
 */

/** The only keys each type may carry, beyond the four every record carries. */
const RECORD_FIELDS: Readonly<Record<EffortRecordType, readonly string[]>> = Object.freeze({
  ATTENTION_SWITCH: Object.freeze(["fromSurface", "toSurface"]),
  DEMANDED_DECISION: Object.freeze(["demandedKind"]),
  FREE_INTERACTION: Object.freeze(["interaction"]),
  INTERVAL_CLOSE: Object.freeze(["intervalKind"]),
  INTERVAL_OPEN: Object.freeze(["intervalKind"]),
  RECOVERY_ACTION: Object.freeze(["action", "burden"]),
  SCROLL_FOCUS_EVIDENCE: Object.freeze(["evidence", "surface"]),
});

const BASE_FIELDS: readonly string[] = Object.freeze([
  "commandId",
  "observedAt",
  "source",
  "type",
]);

function refuse(code: EffortUnknownCode): EffortRefusal {
  return effortRefusal(code, EFFORT_ADMISSION_LAYER);
}

function isRecordShape(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asMember<T extends string>(value: unknown, members: readonly T[]): T | null {
  return typeof value === "string" && (members as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function isRefusal(value: string | EffortRefusal): value is EffortRefusal {
  return typeof value !== "string";
}

/**
 * A key that is missing and a key explicitly set to `undefined` are the same fact: the
 * payload states nothing there. `timing.ts` reads an undefined reading as absent rather
 * than as malformed, and the two must not disagree about what a stated nothing means.
 */
function isAbsent(payload: Readonly<Record<string, unknown>>, key: string): boolean {
  return !Object.hasOwn(payload, key) || payload[key] === undefined;
}

/** Rule 2, per field. */
function text(payload: Readonly<Record<string, unknown>>, key: string): string | EffortRefusal {
  if (isAbsent(payload, key)) return refuse("EFFORT_OBSERVATION_ABSENT");
  const value = payload[key];
  if (typeof value !== "string" || value === "") {
    return refuse("EFFORT_OBSERVATION_UNPARSEABLE");
  }
  return value;
}

/**
 * A key this type does not carry is refused, not dropped. A caller-supplied `durationMs`,
 * `count` or `burden` is exactly what this domain must never accept from outside, and
 * silently ignoring one would look, from the caller's side, like it had been honoured.
 */
function hasUnknownKey(
  payload: Readonly<Record<string, unknown>>,
  type: EffortRecordType,
): boolean {
  const allowed = RECORD_FIELDS[type] ?? [];
  return Object.keys(payload).some(
    (key) =>
      !BASE_FIELDS.includes(key) && !allowed.includes(key) && !isAbsent(payload, key),
  );
}

function build(
  base: EffortRecordBase,
  type: EffortRecordType,
  payload: Readonly<Record<string, unknown>>,
): EffortAdmission {
  switch (type) {
    case "ATTENTION_SWITCH": {
      const fromSurface = text(payload, "fromSurface");
      const toSurface = text(payload, "toSurface");
      if (isRefusal(fromSurface)) return fromSurface;
      if (isRefusal(toSurface)) return toSurface;
      // Leaving a surface for itself is not a switch; it is two readings that disagree.
      if (fromSurface === toSurface) return refuse("EFFORT_OBSERVATION_CONTRADICTORY");
      return Object.freeze({ ...base, fromSurface, toSurface, type });
    }
    case "DEMANDED_DECISION": {
      const demanded = text(payload, "demandedKind");
      if (isRefusal(demanded)) return demanded;
      // Additional-ness is DERIVED from the observed sequence. A caller able to declare
      // "this one is the first" could hide every demand that followed it.
      if (demanded === ADDITIONAL_DECISION_KIND) {
        return refuse("EFFORT_OBSERVATION_CONTRADICTORY");
      }
      const demandedKind = asMember(demanded, BASELINE_DECISION_KINDS);
      if (demandedKind === null) return refuse("EFFORT_OBSERVATION_UNPARSEABLE");
      return Object.freeze({ ...base, demandedKind, type });
    }
    case "FREE_INTERACTION": {
      const interaction = text(payload, "interaction");
      if (isRefusal(interaction)) return interaction;
      return Object.freeze({ ...base, interaction, type });
    }
    case "INTERVAL_CLOSE":
    case "INTERVAL_OPEN": {
      const read = text(payload, "intervalKind");
      if (isRefusal(read)) return read;
      const intervalKind = asMember(read, INTERVAL_KINDS);
      if (intervalKind === null) return refuse("EFFORT_OBSERVATION_UNPARSEABLE");
      return Object.freeze({ ...base, intervalKind, type });
    }
    case "RECOVERY_ACTION": {
      const action = text(payload, "action");
      const read = text(payload, "burden");
      if (isRefusal(action)) return action;
      if (isRefusal(read)) return read;
      const burden = asMember(read, RECOVERY_BURDENS);
      if (burden === null) return refuse("EFFORT_OBSERVATION_UNPARSEABLE");
      return Object.freeze({ ...base, action, burden, type });
    }
    case "SCROLL_FOCUS_EVIDENCE": {
      const evidence = text(payload, "evidence");
      const surface = text(payload, "surface");
      if (isRefusal(evidence)) return evidence;
      if (isRefusal(surface)) return surface;
      return Object.freeze({ ...base, evidence, surface, type });
    }
  }
}

/** Rule 1, then rule 2, in the order that keeps each fact owned by the field that states it. */
export function shapeEffortObservation(value: unknown): EffortAdmission {
  if (value === null || value === undefined) return refuse("EFFORT_OBSERVATION_ABSENT");
  if (!isRecordShape(value)) return refuse("EFFORT_OBSERVATION_UNPARSEABLE");
  if (isAbsent(value, "type")) return refuse("EFFORT_OBSERVATION_ABSENT");
  const type = asMember(value["type"], EFFORT_RECORD_TYPES);
  if (type === null) return refuse("EFFORT_OBSERVATION_UNPARSEABLE");
  if (isAbsent(value, "source")) return refuse("EFFORT_SOURCE_ABSENT");
  const source = asMember(value["source"], EFFORT_SOURCES);
  if (source === null) return refuse("EFFORT_OBSERVATION_UNPARSEABLE");
  if (isAbsent(value, "commandId")) return refuse("EFFORT_COMMAND_IDENTITY_ABSENT");
  const commandId = value["commandId"];
  if (typeof commandId !== "string" || commandId === "") {
    return refuse("EFFORT_OBSERVATION_UNPARSEABLE");
  }
  if (isAbsent(value, "observedAt")) return refuse("EFFORT_OBSERVATION_ABSENT");
  const observedAt = value["observedAt"];
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) {
    return refuse("EFFORT_OBSERVATION_UNPARSEABLE");
  }
  if (hasUnknownKey(value, type)) return refuse("EFFORT_OBSERVATION_UNPARSEABLE");
  return build({ commandId, known: true, observedAt, source }, type, value);
}
