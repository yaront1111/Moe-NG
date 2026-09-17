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
