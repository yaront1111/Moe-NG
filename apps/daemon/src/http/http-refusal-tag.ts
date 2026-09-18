import type { ServerResponse } from "node:http";

/**
 * WHAT THE LISTENER REFUSED, CARRIED BACK OUT WITHOUT TOUCHING THE WIRE.
 *
 * Every refusal the control-room listener can make was silent host-side. The single per-request
 * line is written BEFORE dispatch and carries method and path only, so nothing anywhere records
 * that a request was refused, which code answered, or what status went back. A control room
 * whose CSRF token has drifted gets 403 on every call while the daemon's output shows an
 * ordinary list of paths — the board renders empty and there is no reason to suspect the daemon.
 *
 * The refusals are made deep inside a 795-line dispatch that threads no sink and returns
 * `{kind: "LISTENER_REFUSAL"}` values flattened by 25 different helpers. Rather than thread a
 * logger through all of them — hundreds of edited lines, and a signature change on every helper
 * — the code is stamped on the `ServerResponse` that is already passed everywhere, at the ONE
 * funnel every refusal goes through, and read back where the request completes.
 *
 * A SYMBOL, so the tag cannot collide with a Node property, cannot be serialised into a
 * response body by any `JSON.stringify`, and is invisible to anything that enumerates the
 * response's keys. No wire byte changes, and no refusal's own bytes are touched.
 */

const REFUSAL_TAG = Symbol("moe.listener.refusal");

interface Tagged {
  [REFUSAL_TAG]?: string;
}

/**
 * Records the code THIS response was refused with. Total: a response object that refuses the
 * write (frozen, a proxy, an exotic double in a test) must never turn a refusal into a throw —
 * the refusal is the answer the client is owed, and the tag is only an observation of it.
 */
export function tagRefusal(response: ServerResponse, code: string): void {
  try {
    (response as unknown as Tagged)[REFUSAL_TAG] = code;
  } catch {
    // An unwritable response loses its tag and nothing else. The reader answers null.
  }
}

/** The code this response was refused with, or null if it was not refused. */
export function refusalTagOf(response: ServerResponse): string | null {
  try {
    const code = (response as unknown as Tagged)[REFUSAL_TAG];
    return typeof code === "string" && code !== "" ? code : null;
  } catch {
    return null;
  }
}

/**
 * THE OTHER SILENT ANSWER. A refusal the listener makes is tagged above. A frame the DAEMON
 * answers that describes a fault of its own — a read model whose store could not be read, a
 * commit the durable store refused, a port that threw behind a code — is not a listener refusal:
 * it goes out as 200 or 503 with a body, the control room shows the code, and the listener wrote
 * nothing. Tagged at `reply()`, the one funnel every frame passes, and named on the completion
 * line as LISTENER_FAULT_FRAME.
 *
 * The predicate is deliberately narrow: the durable-store layer, or a code whose suffix says the
 * daemon could not READ or a store call FAILED or THREW. A bare `_UNAVAILABLE` is not a fault —
 * it is how an uncomposed port answers, on every poll, forever — and a domain verdict is not one
 * either. A command result nests its refusal; a read frame carries code and layer at the top.
 */
export interface FaultFrame {
  readonly code: string;
  readonly layer: string;
}

const FAULT_TAG = Symbol("moe.listener.fault-frame");

interface FaultTagged {
  [FAULT_TAG]?: FaultFrame;
}

const FAULT_CODE = /(_UNREADABLE|_STORE_FAILED|_STORE_THREW|_STORE_UNAVAILABLE|_THREW)$/u;
const FAULT_LAYER = "DURABLE_STORE";

function factsOf(value: unknown): FaultFrame | null {
  if (typeof value !== "object" || value === null) return null;
  const { code, layer } = value as { code?: unknown; layer?: unknown };
  return typeof code === "string" && typeof layer === "string" ? { code, layer } : null;
}

/** The fault a frame reports, or null for every frame that reports none. */
export function faultFrameOf(body: unknown): FaultFrame | null {
  if (typeof body !== "object" || body === null) return null;
  const facts = factsOf((body as { refusal?: unknown }).refusal) ?? factsOf(body);
  if (facts === null) return null;
  return facts.layer === FAULT_LAYER || FAULT_CODE.test(facts.code) ? facts : null;
}

/** Total, as `tagRefusal` is: an unwritable response loses its tag and nothing else. */
export function tagFaultFrame(response: ServerResponse, frame: FaultFrame): void {
  try {
    (response as unknown as FaultTagged)[FAULT_TAG] = frame;
  } catch {
    // The reader answers null.
  }
}

export function faultFrameTagOf(response: ServerResponse): FaultFrame | null {
  try {
    const frame = (response as unknown as FaultTagged)[FAULT_TAG];
    return frame === undefined ? null : factsOf(frame);
  } catch {
    return null;
  }
}
