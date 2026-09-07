import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { readEnvironmentVariables } from "../../live/live-environment-variables.js";
import type { EnvironmentVariablesOutcome } from "../../live/live-environment-variables.js";
import type { LiveSetup } from "../../live/live-config.js";
import { createEnvironmentVariablesPort } from "./environment-variables-port.js";
import type { EnvironmentVariablesPort } from "./environment-variables-port.js";
import { EnvironmentVariablesScreen } from "./environment-variables-screen.js";

/**
 * THE ENVIRONMENTS SCREEN, ON THE WIRE. One read per environment on mount, again every few
 * seconds, and once more the instant a write settles - because the fingerprint the operator is
 * waiting on is the DAEMON's, and waiting a poll interval for it would leave them unable to tell
 * a slow refresh from a write that did not take.
 *
 * A FAILED READ IS NEVER AN EMPTY TABLE. A throw settles as TRANSPORT_REQUEST_FAILED at this
 * layer rather than as zero variables; a table that says "nothing is set" about an environment it
 * could not read is how an operator sets a variable that was already set.
 *
 * THIS MODULE HOLDS NO VALUE. It wires a read and a port; the typed value never enters its state,
 * never reaches a prop it passes down, and is not part of anything it re-reads.
 */

const POLL_MS = 15_000;
const LAYER = "CONTROL_ROOM_ENVIRONMENT_VARIABLES";

export const ENVIRONMENT_VARIABLES_READ_FAILED: EnvironmentVariablesOutcome = Object.freeze({
  code: "TRANSPORT_REQUEST_FAILED", layer: LAYER, status: "ERROR" as const,
});

export interface LiveEnvironmentVariablesProps {
  readonly environment: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly pollMs?: number | undefined;
  /** Injectable for tests; the default POSTs /environments/read with the session headers. */
  readonly read?: (() => Promise<EnvironmentVariablesOutcome>) | undefined;
  readonly port?: EnvironmentVariablesPort | undefined;
  /**
   * Reports each settled read upward, so a caller that summarises the same table (the goal's
   * unset-variables card) counts THIS read rather than making a second one of its own. Two reads
   * would be two answers, and the card and the table could then disagree about one environment.
   */
  readonly onOutcome?: ((environment: string, outcome: EnvironmentVariablesOutcome) => void) | undefined;
  /** The names the approved contract requires. Read by the caller, never derived here. */
  readonly requiredNames: readonly string[];
  /** The attached session; absent (fixtures, tests) means the screen can read but not write. */
  readonly setup?: LiveSetup | undefined;
}

export function LiveEnvironmentVariables({
  environment, headers, onOutcome, pollMs, port, read, requiredNames, setup,
}: LiveEnvironmentVariablesProps): JSX.Element {
  const [outcome, setOutcome] = useState<EnvironmentVariablesOutcome | null>(null);
  const [reader] = useState(() => read
    ?? ((): Promise<EnvironmentVariablesOutcome> => readEnvironmentVariables(headers, environment)));
  const [writer] = useState<EnvironmentVariablesPort | null>(
    () => port ?? (setup === undefined ? null : createEnvironmentVariablesPort(setup)),
  );
  const generation = useRef(0);
  const tickRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const run = generation.current + 1;
    generation.current = run;
    let inFlight = false;
    const tick = (): void => {
      if (inFlight) return;
      inFlight = true;
      void reader().then((next) => {
        onOutcome?.(environment, next);
        inFlight = false;
        if (generation.current === run) setOutcome(next);
      }, () => {
        inFlight = false;
        // A thrown read is a FAILED read, never an empty one.
        onOutcome?.(environment, ENVIRONMENT_VARIABLES_READ_FAILED);
        if (generation.current === run) setOutcome(ENVIRONMENT_VARIABLES_READ_FAILED);
      });
    };
    tickRef.current = tick;
    tick();
    const timer = setInterval(tick, pollMs ?? POLL_MS);
    return (): void => {
      generation.current += 1;
      tickRef.current = () => undefined;
      clearInterval(timer);
    };
  }, [environment, onOutcome, pollMs, reader]);
  const onSettled = useCallback((): void => { tickRef.current(); }, []);
  return (
    <EnvironmentVariablesScreen
      environment={environment} onSettled={onSettled} outcome={outcome} port={writer}
      requiredNames={requiredNames}
    />
  );
}
