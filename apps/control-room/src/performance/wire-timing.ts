import { TIMING_PHASE_OBSERVERS, evaluateTiming, timingUnknown } from "./timing.js";
import type {
  Clock,
  SurfaceTimingReceipt,
  TimingInterval,
  TimingObserver,
  TimingUnknown,
  TimingUnknownCode,
  TimingUpstreamRefusal,
} from "./timing.js";

/**
 * The one bridge between the daemon's event-stream wire and the pure timing evaluator.
 *
 * `timing.ts` is deliberately pure: it reads no clock and knows nothing of the wire.
 * Teaching it the seam's vocabulary would couple the evaluator to the daemon's frame
 * format, so the conversion lives here instead, and lives here ONLY — a second converter
 * elsewhere is how two layers start disagreeing about what a missing reading means.
 *
 * The wire types below are STRUCTURAL mirrors, not imports. This package declares no
 * dependency on the daemon, and `readEventPage` is an untyped passthrough, so a wire
 * frame arrives as `unknown` and is shaped here exactly as `live-event-feed.ts` already
 * shapes event rows: fields are copied, and a field that is not there stays absent
 * rather than becoming a default.
 *
 * Three rules govern everything below.
 *
 * 1. A REFUSAL NEVER BECOMES A NUMBER. When the seam says it has no reading, that is
 *    TIMING_UPSTREAM_UNKNOWN carrying the seam's own code and layer verbatim — never
 *    TIMING_SOURCE_ABSENT, which would claim the reading never arrived.
 * 2. A READING IS PARSED EXPLICITLY. The wire carries strings; intervals take numbers.
 *    An unparseable string refuses here rather than flowing on as a NaN.
 * 3. CLOCK IDENTITY IS COMPARED BEFORE ANY SUBTRACTION. See {@link pairing}.
 */

/** The identity every reading taken from this application's own injected clock carries. */
export const CONTROL_ROOM_CLOCK = "CONTROL_ROOM_CLOCK";

export interface WireKnownReading {
  readonly known: true;
  readonly value: string;
}

export interface WireRefusedReading {
  readonly code: string;
  readonly known: false;
  readonly layer: string;
}

export type WireReading = WireKnownReading | WireRefusedReading;

/** One daemon reading, bound to the observer and clock that produced it. */
export interface WireObservationRow {
  readonly clock: string;
  readonly observer: string;
  readonly reading: WireReading;
}

/**
 * A reading resolved onto a comparable scale, or the reason it could not be. The
 * measurable arm carries its CLOCK IDENTITY, which is the field the cross-clock guard
 * reads; a reading without one could never be shown to be comparable to anything.
 */
export type TimingReading =
  | { readonly clock: string; readonly known: true; readonly value: number }
  | {
    readonly code: TimingUnknownCode;
    readonly known: false;
    readonly upstream?: TimingUpstreamRefusal | undefined;
  };

/** No observation was taken at all — distinct from one that was taken and refused. */
export const READING_ABSENT: TimingReading = Object.freeze({
  code: "TIMING_SOURCE_ABSENT" as const,
  known: false as const,
});

function refusedReading(
  code: TimingUnknownCode,
  upstream?: TimingUpstreamRefusal,
): TimingReading {
  return Object.freeze(upstream === undefined
    ? { code, known: false as const }
    : { code, known: false as const, upstream: Object.freeze(upstream) });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Shapes one wire value — a reading, or an identity field like `principal`. Both arms of
 * the seam's union are copied verbatim; anything else is null, so a value the frame did
 * not carry stays absent instead of becoming an empty string wearing a real shape.
 */
export function shapeWireValue(value: unknown): WireReading | null {
  if (!isRecord(value)) return null;
  if (value["known"] === true) {
    const reading = nonEmpty(value["value"]);
    return reading === null ? null : Object.freeze({ known: true as const, value: reading });
  }
  if (value["known"] !== false) return null;
  const code = nonEmpty(value["code"]);
  const layer = nonEmpty(value["layer"]);
  if (code === null || layer === null) return null;
  return Object.freeze({ code, known: false as const, layer });
}

/**
 * Shapes a wire observation out of an untyped frame. Every field is required: an
 * observation missing its clock or its observer is not a weaker observation, it is a
 * reading nobody can be shown to have taken, so it is refused outright rather than
 * defaulted into something that looks attributable.
 */
export function shapeWireObservation(value: unknown): WireObservationRow | null {
  if (!isRecord(value)) return null;
  const clock = nonEmpty(value["clock"]);
  const observer = nonEmpty(value["observer"]);
  const reading = shapeWireValue(value["reading"]);
  if (clock === null || observer === null || reading === null) return null;
  return Object.freeze({ clock, observer, reading });
}

/** Rule 1 and rule 2, in the order that keeps each fact owned by the layer that stated it. */
export function readWireObservation(
  observation: WireObservationRow | null | undefined,
): TimingReading {
  if (observation === null || observation === undefined) return READING_ABSENT;
  const { reading } = observation;
  if (!reading.known) {
    return refusedReading("TIMING_UPSTREAM_UNKNOWN", {
      code: reading.code, layer: reading.layer,
    });
  }
  const value = Date.parse(reading.value);
  if (!Number.isFinite(value)) return refusedReading("TIMING_SOURCE_UNPARSEABLE");
  return Object.freeze({ clock: observation.clock, known: true as const, value });
}

/**
 * Takes this application's own reading, against an INJECTED clock. With no clock the
 * answer is TIMING_CLOCK_UNAVAILABLE: a surface that cannot measure learns exactly that,
 * and is never quietly told that no time passed.
 */
export function readClientClock(clock: Clock | null | undefined): TimingReading {
  if (clock === null || clock === undefined) return refusedReading("TIMING_CLOCK_UNAVAILABLE");
  const value = clock.now();
  if (!Number.isFinite(value)) return refusedReading("TIMING_SOURCE_UNPARSEABLE");
  return Object.freeze({ clock: CONTROL_ROOM_CLOCK, known: true as const, value });
}

type PhaseSource =
  | { readonly interval: TimingInterval; readonly refusal?: undefined }
  | { readonly interval?: undefined; readonly refusal: TimingUnknown };

/**
 * RULE 3, and the guard this module exists for.
 *
 * The clock comparison runs BEFORE the pair is ever handed onward to be subtracted. The
 * evaluator's `end < start` skew guard is not a substitute: it catches only the half of
 * cross-clock skew that happens to run backwards, while skew the other way subtracts to
 * a plausible, confidently WRONG duration and every assertion stays green.
 *
 * The refusal is re-stamped with the PHASE's observer, not the reading's. A seam refusal
 * that makes `stream` unmeasurable is still an interval the control room was watching
 * for, so `stream` stays CONTROL_ROOM; the upstream carrier is what names the seam.
 */
function pairing(observedBy: TimingObserver, from: TimingReading, to: TimingReading): PhaseSource {
  if (!from.known) return { refusal: timingUnknown(observedBy, from.code, from.upstream) };
  if (!to.known) return { refusal: timingUnknown(observedBy, to.code, to.upstream) };
  if (from.clock !== to.clock) {
    return { refusal: timingUnknown(observedBy, "TIMING_CLOCK_MISMATCH") };
  }
  return { interval: { end: to.value, start: from.value } };
}

export interface LiveTimingInput {
  /** When the operator acted on what was rendered; absent until one does. */
  readonly acted?: TimingReading | undefined;
  /** The store's own commit reading, on the store's commit clock. */
  readonly ledger: WireObservationRow | null;
  /** When this client received the frame, on this application's injected clock. */
  readonly received: TimingReading;
  /** When this surface painted the frame, on this application's injected clock. */
  readonly rendered: TimingReading;
  /** The daemon seam's own reading, on the daemon's wall clock. */
  readonly seam: WireObservationRow | null;
}

/**
 * Assembles the four-phase receipt from OBSERVED readings.
 *
 * The measurable pairs go through `evaluateTiming`, which stays the only place a
 * duration is ever computed; phases this module refused outright replace their evaluated
 * slot afterwards, so a refusal is never re-derived from an interval that does not exist.
 * Nothing here sums, averages or totals: the four phases answer four different questions
 * and one number could not tell them apart.
 */
export function buildLiveTimingReceipt(input: LiveTimingInput): SurfaceTimingReceipt {
  const ledger = readWireObservation(input.ledger);
  const seam = readWireObservation(input.seam);
  const sources = {
    human: pairing(TIMING_PHASE_OBSERVERS.human, input.rendered, input.acted ?? READING_ABSENT),
    render: pairing(TIMING_PHASE_OBSERVERS.render, input.received, input.rendered),
    server: pairing(TIMING_PHASE_OBSERVERS.server, ledger, seam),
    stream: pairing(TIMING_PHASE_OBSERVERS.stream, seam, input.received),
  } as const;
  const evaluated = evaluateTiming({
    human: sources.human.interval,
    render: sources.render.interval,
    server: sources.server.interval,
    stream: sources.stream.interval,
  });
  return Object.freeze({
    human: sources.human.refusal ?? evaluated.human,
    render: sources.render.refusal ?? evaluated.render,
    server: sources.server.refusal ?? evaluated.server,
    stream: sources.stream.refusal ?? evaluated.stream,
  });
}
