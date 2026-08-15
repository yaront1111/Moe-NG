/**
 * Four-phase timing for the standalone control room (spec §11.4).
 *
 * This module owns no time source. Every reading arrives from the caller — either as a
 * pair of timestamps it already observed, or through an injected {@link Clock}. That is
 * DoD 1, and it is enforced structurally by a source scan in the sibling spec rather
 * than by behaviour, because a green evaluator cannot prove the absence of a path that
 * reaches for the host's real time API.
 *
 * Two rules shape everything below.
 *
 * 1. ABSENT IS NOT ZERO. A phase with no usable pair resolves to an unknown carrying a
 *    stable code and no `durationMs` property at all. Epic rail 4: missing evidence stays
 *    UNKNOWN and never gains authority. A zero-millisecond span, by contrast, is a real
 *    measurement and is reported as one.
 *
 * 2. THE CONTROL ROOM'S OWN OBSERVATIONS ARE LABELLED AS ITS OWN. Task rail 2 forbids
 *    presenting a locally measured duration as a daemon-supplied fact. Only `server` is
 *    sourced entirely from daemon timestamps; the other three each end at something this
 *    application watched happen, so they carry `CONTROL_ROOM`. Nothing here upgrades a
 *    truth class or derives authority — a duration is an observation, not a verdict.
 *
 * The evaluator deliberately does NOT source its own timestamps for the four phases. A
 * monotonic client clock and a daemon's wall clock are not comparable, and `stream`
 * straddles both machines. Feeding it caller-supplied pairs keeps the arithmetic honest
 * and turns cross-machine skew into an explicit TIMING_NEGATIVE_INTERVAL refusal instead
 * of a plausible wrong number.
 */

/** The single call this package knows how to make against a time source. */
export interface Clock {
  now: () => number;
}

/** Declaration order is the render order; the sibling spec pins both. */
export const TIMING_PHASE_NAMES = Object.freeze([
  "server",
  "stream",
  "render",
  "human",
] as const);

export type TimingPhaseName = (typeof TIMING_PHASE_NAMES)[number];

/**
 * Who watched the interval end. `DAEMON` means both readings came from the daemon's own
 * timestamps; `CONTROL_ROOM` means this application observed it and says so.
 */
export type TimingObserver = "CONTROL_ROOM" | "DAEMON";

/**
 * TIMING_CLOCK_MISMATCH and TIMING_UPSTREAM_UNKNOWN name two facts the original four
 * could not express, and both had to be their own code rather than a reuse.
 *
 * MISMATCH is two real readings taken on two DIFFERENT clocks. It is not
 * TIMING_CLOCK_UNAVAILABLE — a clock was available, two of them were — and it is not
 * TIMING_NEGATIVE_INTERVAL, because that guard only fires on the half of the skew that
 * happens to run backwards; skew the other way subtracts to a plausible, confidently
 * wrong number. Declared clock identity is compared BEFORE any subtraction.
 *
 * UPSTREAM_UNKNOWN is another layer stating that IT does not know. "The daemon says it
 * has no reading" and "we never received a reading" are different facts owned by
 * different layers, so they never share a code.
 */
export type TimingUnknownCode =
  | "TIMING_CLOCK_MISMATCH"
  | "TIMING_CLOCK_UNAVAILABLE"
  | "TIMING_NEGATIVE_INTERVAL"
  | "TIMING_SOURCE_ABSENT"
  | "TIMING_SOURCE_UNPARSEABLE"
  | "TIMING_UPSTREAM_UNKNOWN";

export const TIMING_UNKNOWN_CODES = Object.freeze([
  "TIMING_CLOCK_MISMATCH",
  "TIMING_CLOCK_UNAVAILABLE",
  "TIMING_NEGATIVE_INTERVAL",
  "TIMING_SOURCE_ABSENT",
  "TIMING_SOURCE_UNPARSEABLE",
  "TIMING_UPSTREAM_UNKNOWN",
] as const);

/**
 * The refusing layer's OWN code, forwarded verbatim. There is deliberately no
 * translation table: mapping a seam code onto a control-room code would put this
 * module's guess where the other layer's answer belongs, and the operator would lose
 * the one string that identifies which layer actually refused.
 */
export interface TimingUpstreamRefusal {
  readonly code: string;
  readonly layer: string;
}

/** A pair the caller already observed. Both ends must come from the same clock. */
export interface TimingInterval {
  readonly end?: number | undefined;
  readonly start?: number | undefined;
}

export type TimingInput = {
  readonly [Name in TimingPhaseName]?: TimingInterval | undefined;
};

export interface TimingMeasured {
  readonly durationMs: number;
  readonly known: true;
  readonly observedBy: TimingObserver;
}

export interface TimingUnknown {
  readonly known: false;
  readonly observedBy: TimingObserver;
  readonly reasonCode: TimingUnknownCode;
  /** Present only when another layer refused; absent when this one did. */
  readonly upstream?: TimingUpstreamRefusal | undefined;
}

export type TimingPhase = TimingMeasured | TimingUnknown;

export type SurfaceTimingReceipt = {
  readonly [Name in TimingPhaseName]: TimingPhase;
};

/**
 * One presentable line per phase. `durationMs` and `reasonCode` are never both set.
 *
 * The two upstream fields are how a refusal stays attributable all the way to what the
 * operator sees: a line that showed only TIMING_UPSTREAM_UNKNOWN would say another layer
 * refused without ever saying which one, or why.
 */
export interface TimingLine {
  readonly durationMs: number | null;
  readonly observedBy: TimingObserver;
  readonly phase: TimingPhaseName;
  readonly reasonCode: TimingUnknownCode | null;
  readonly upstreamCode: string | null;
  readonly upstreamLayer: string | null;
}

/**
 * `server` runs daemon-emitted to daemon-observed, so both readings are the daemon's.
 * `stream` ends when this client received the event, `render` when it painted, `human`
 * when the operator acted — all three end on a control-room observation.
 */
export const TIMING_PHASE_OBSERVERS: Readonly<Record<TimingPhaseName, TimingObserver>> =
  Object.freeze({
    human: "CONTROL_ROOM",
    render: "CONTROL_ROOM",
    server: "DAEMON",
    stream: "CONTROL_ROOM",
  });

/**
 * The one constructor for an unmeasurable phase, exported so a caller assembling a
 * receipt from readings this module never saw still produces the same frozen shape and
 * attributes its refusal to the same observer. `upstream` is omitted entirely rather
 * than set to a null, so an absent carrier is absent rather than a stated nothing.
 */
export function timingUnknown(
  observedBy: TimingObserver,
  reasonCode: TimingUnknownCode,
  upstream?: TimingUpstreamRefusal | undefined,
): TimingUnknown {
  return Object.freeze(upstream === undefined
    ? { known: false as const, observedBy, reasonCode }
    : { known: false as const, observedBy, reasonCode, upstream: Object.freeze(upstream) });
}

function measured(observedBy: TimingObserver, durationMs: number): TimingMeasured {
  return Object.freeze({ durationMs, known: true, observedBy });
}

/**
 * The one place a pair becomes a phase. Order is load-bearing: absent is checked before
 * parseability so a missing reading is never reported as a malformed one, and the
 * skew guard runs last so it only ever judges two readings that are both real.
 */
function fromInterval(
  observedBy: TimingObserver,
  start: number | undefined,
  end: number | undefined,
): TimingPhase {
  if (start === undefined || end === undefined) {
    return timingUnknown(observedBy, "TIMING_SOURCE_ABSENT");
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return timingUnknown(observedBy, "TIMING_SOURCE_UNPARSEABLE");
  }
  if (end < start) {
    // Two machines, two clocks. An absolute value here would publish a confident number
    // built from a contradiction, so the skew is surfaced instead of smoothed.
    return timingUnknown(observedBy, "TIMING_NEGATIVE_INTERVAL");
  }
  return measured(observedBy, end - start);
}

/**
 * Measures how long something has been pending, against an injected clock.
 *
 * The clock is checked FIRST and on its own: with no clock this returns
 * TIMING_CLOCK_UNAVAILABLE rather than reaching for the host's time API. A caller with
 * no clock learns that it cannot measure — it is never quietly told that no time passed.
 */
export function measureElapsed(
  startedAt: number | undefined,
  clock: Clock | null | undefined,
): TimingPhase {
  if (clock === null || clock === undefined) {
    return timingUnknown("CONTROL_ROOM", "TIMING_CLOCK_UNAVAILABLE");
  }
  return fromInterval("CONTROL_ROOM", startedAt, clock.now());
}

/** Maps caller-supplied pairs onto the four named phases. Pure; reads no clock. */
export function evaluateTiming(input: TimingInput): SurfaceTimingReceipt {
  return Object.freeze({
    human: fromInterval(TIMING_PHASE_OBSERVERS.human, input.human?.start, input.human?.end),
    render: fromInterval(TIMING_PHASE_OBSERVERS.render, input.render?.start, input.render?.end),
    server: fromInterval(TIMING_PHASE_OBSERVERS.server, input.server?.start, input.server?.end),
    stream: fromInterval(TIMING_PHASE_OBSERVERS.stream, input.stream?.start, input.stream?.end),
  });
}

/**
 * The receipt's presentation: one line per phase, in declaration order, each naming the
 * phase it belongs to. Deliberately not a total — a single summed number would make the
 * four phases indistinguishable, which is exactly what DoD 2's sweep refuses.
 */
export function describeTimingReceipt(
  receipt: SurfaceTimingReceipt,
): readonly TimingLine[] {
  return Object.freeze(
    TIMING_PHASE_NAMES.map((phase) => {
      const resolved = receipt[phase];
      const upstream = resolved.known ? undefined : resolved.upstream;
      return Object.freeze({
        durationMs: resolved.known ? resolved.durationMs : null,
        observedBy: resolved.observedBy,
        phase,
        reasonCode: resolved.known ? null : resolved.reasonCode,
        upstreamCode: upstream?.code ?? null,
        upstreamLayer: upstream?.layer ?? null,
      });
    }),
  );
}
