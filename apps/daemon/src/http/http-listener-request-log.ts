import type { IncomingMessage, ServerResponse } from "node:http";

import { faultFrameTagOf, refusalTagOf } from "./http-refusal-tag.js";

/**
 * THE RESPONSE SIDE OF THE ONE PER-REQUEST LINE. The listener writes a line before dispatch
 * carrying method and path only; this module writes the line AFTER, and only when there is
 * something to say. A refusal the listener made names its code and status (a control room
 * whose CSRF token drifted got 403 on every call while the daemon's output read as an ordinary
 * list of paths). A request that took longer than `slowRequestMs` names its status and
 * duration — a store that has gone slow shows up here first, on the reads the control room
 * polls, long before anything refuses. A frame the daemon answered that reports its OWN fault
 * (`faultFrameOf`) names its code and layer, because the control room shows that code while the
 * daemon's output would read as an ordinary served request. A handler that THREW is reported
 * with its cause, host-side, never in the client's 500.
 *
 * Nothing here may turn an answered request into a failed one: every log call is fenced, and
 * `onThrown` runs whether or not the sink accepted the line.
 */

/** A served request slower than this, in milliseconds, earns a LISTENER_SLOW line. */
export const SLOW_REQUEST_MS = 2_000;

export interface ServedRequestLogInput {
  readonly log: ((line: string) => void) | undefined;
  /** Monotonic milliseconds; injected so a test never waits. */
  readonly now: () => number;
  /** The listener's own stable 500, written when the handler threw before answering. */
  readonly onThrown: () => void;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly served: Promise<unknown>;
  readonly slowRequestMs: number;
}

function say(log: ((line: string) => void) | undefined, line: string): void {
  try {
    log?.(line);
  } catch {
    // A failed diagnostic sink must not change what the client was answered.
  }
}

function pathOf(request: IncomingMessage): string {
  return (request.url ?? "?").split("?")[0] ?? "";
}

export function logServedRequest(input: ServedRequestLogInput): void {
  const { log, request, response } = input;
  const startedAt = input.now();
  const method = request.method ?? "?";
  void input.served.then(() => {
    const path = pathOf(request);
    const refusal = refusalTagOf(response);
    if (refusal !== null) {
      say(log, `LISTENER_REFUSED ${method} ${path} ${refusal} ${String(response.statusCode)}`);
    }
    const fault = faultFrameTagOf(response);
    if (fault !== null) {
      say(log, `LISTENER_FAULT_FRAME ${method} ${path} ${fault.code} ${fault.layer} ${String(response.statusCode)}`);
    }
    const elapsed = input.now() - startedAt;
    if (elapsed >= input.slowRequestMs) {
      say(log, `LISTENER_SLOW ${method} ${path} ${String(response.statusCode)} ${String(Math.round(elapsed))}ms`);
    }
  }, (error: unknown) => {
    // A throw from the handler must still answer and must still leave the listener closable;
    // it may never surface as a hung socket. The cause is logged host-side (never sent to the
    // client) so a 500 stays diagnosable.
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    say(log, `LISTENER_REQUEST_FAILED ${method} ${pathOf(request)} ${cause}`);
    input.onThrown();
  });
}
