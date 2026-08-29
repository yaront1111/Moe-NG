import { createContext, useContext } from "react";
import type { JSX, ReactNode } from "react";

import { UNKNOWN_FACT_VALUE } from "../presentation-constants.js";
import { describeTimingReceipt, measureElapsed } from "./timing.js";
import type { Clock, SurfaceTimingReceipt } from "./timing.js";

/** Re-exported so a consuming surface needs exactly one specifier from this package. */
export type { Clock, SurfaceTimingReceipt } from "./timing.js";

/**
 * The shared spec §11.4 latency feedback. Every surface renders command outcomes through
 * this one component, so the contract cannot drift between them.
 *
 * What it does NOT do is as load-bearing as what it does. It derives no authority: the
 * state, the message, the reason code and the refusing layer are all the daemon's, echoed
 * unchanged. The single thing it computes is elapsed time between two moments it was told
 * about, and that measurement is labelled `CONTROL_ROOM` so it can never be read as a
 * daemon-supplied fact or upgrade a truth class (task rail 2).
 *
 * The clock is read during render and nothing is stored, which is what makes this safe
 * under StrictMode's double invocation: two renders read the same injected clock twice
 * and reach the same answer. A component that sampled a start time into state would
 * record two different starts and quietly report the wrong span in development.
 */

/** Spec §11.4 line 711, verbatim, and the only copy in the application. */
export const COMMAND_STILL_WORKING_COPY =
  "still working — the daemon accepted the command (event pending)";

/**
 * Spec §11.4 reads "> 2 s", so the comparison below is strict. This is not a performance
 * budget and asserts nothing about the charter's 500 ms p95 target — it is the one
 * threshold the spec gives the UI for saying something out loud.
 */
export const STILL_WORKING_THRESHOLD_MS = 2_000;

export type CommandLatencyState = "CONFIRMED" | "PENDING" | "REFUSED";

/** A refusal names both the stable code and the layer that produced it. */
export interface CommandRefusalReason {
  readonly layer: string;
  readonly phrase?: string | undefined;
  readonly reasonCode: string;
}

export interface CommandLatencyFeedback {
  readonly commandId: string;
  readonly message: string;
  readonly reason?: CommandRefusalReason | undefined;
  /** When the command was sent, on the injected clock's own scale. */
  readonly startedAt?: number | undefined;
  readonly state: CommandLatencyState;
}

export interface CommandLatencyProps {
  /** Absent means this surface cannot measure; it never means no time passed. */
  readonly clock?: Clock | null | undefined;
  readonly feedback: CommandLatencyFeedback;
  readonly receipt?: SurfaceTimingReceipt | undefined;
  /** The calling surface's namespace, e.g. `cr.recovery.feedback`. */
  readonly testIdPrefix: string;
}

/**
 * The application's time source, supplied once at the composition root.
 *
 * `null` is the honest default: a tree with no provider cannot measure, and every surface
 * under it says TIMING_CLOCK_UNAVAILABLE rather than behaving as though no time passed.
 * This module never creates a clock — reading a real time API here is what DoD 1 forbids,
 * and it is enforced by a source scan over this directory rather than by convention.
 */
const ClockContext = createContext<Clock | null>(null);

export function ClockProvider(props: {
  readonly children: ReactNode;
  readonly clock: Clock;
}): JSX.Element {
  const { children, clock } = props;
  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>;
}

/**
 * The composition root's clock, for a live surface that must take its OWN reading rather
 * than render one it was handed. Returns null when no provider is mounted, which is the
 * honest answer: that surface cannot measure, and says so with a code.
 */
export function useClock(): Clock | null {
  return useContext(ClockContext);
}

function stated(value: string | undefined): string {
  return value !== undefined && value.trim() !== "" ? value : UNKNOWN_FACT_VALUE;
}

/**
 * One line per phase. Each carries its own duration or its own code — never both, and
 * never a zero standing in for an absent reading.
 */
function PhaseLines(props: {
  readonly prefix: string;
  readonly receipt: SurfaceTimingReceipt;
}): JSX.Element {
  const { prefix, receipt } = props;
  return (
    <>
      {describeTimingReceipt(receipt).map((line) => (
        <span
          data-duration-ms={line.durationMs === null ? undefined : String(line.durationMs)}
          data-observed-by={line.observedBy}
          data-testid={`${prefix}.phase.${line.phase}`}
          data-unknown-code={line.reasonCode ?? undefined}
          // Which layer refused, in the refusing layer's own words. A line showing only
          // TIMING_UPSTREAM_UNKNOWN would say another layer refused and never say which.
          data-upstream-code={line.upstreamCode ?? undefined}
          data-upstream-layer={line.upstreamLayer ?? undefined}
          key={line.phase}
        >
          {line.phase}
        </span>
      ))}
    </>
  );
}

export function CommandLatency(props: CommandLatencyProps): JSX.Element {
  const { clock, feedback, receipt, testIdPrefix } = props;
  // An explicit prop wins; otherwise the composition root's clock reaches this surface
  // without every intermediate component having to thread one through.
  const provided = useContext(ClockContext);
  const refused = feedback.state === "REFUSED";
  const elapsed = measureElapsed(feedback.startedAt, clock ?? provided);
  // Both conditions are required. A settled command has stopped waiting, so however long
  // it took it is never "still working"; and an unmeasurable wait says so rather than
  // assuming the threshold was not reached.
  const stillWorking = feedback.state === "PENDING"
    && elapsed.known
    && elapsed.durationMs > STILL_WORKING_THRESHOLD_MS;

  return (
    <div
      data-elapsed-ms={elapsed.known ? String(elapsed.durationMs) : undefined}
      data-elapsed-unknown={elapsed.known ? undefined : elapsed.reasonCode}
      data-observed-by={elapsed.observedBy}
      data-state={feedback.state}
      data-testid={`${testIdPrefix}.${feedback.commandId}`}
      role={refused ? "alert" : "status"}
    >
      <span data-testid={`${testIdPrefix}.message`}>{stated(feedback.message)}</span>
      {stillWorking ? (
        <span data-testid={`${testIdPrefix}.stillworking`}>{COMMAND_STILL_WORKING_COPY}</span>
      ) : null}
      {refused ? (
        <>
          <span data-testid={`${testIdPrefix}.code`}>{stated(feedback.reason?.reasonCode)}</span>
          <span data-testid={`${testIdPrefix}.layer`}>{stated(feedback.reason?.layer)}</span>
        </>
      ) : null}
      {receipt === undefined ? null : <PhaseLines prefix={testIdPrefix} receipt={receipt} />}
    </div>
  );
}
