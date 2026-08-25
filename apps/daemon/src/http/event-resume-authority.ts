import { hasEventStreamOperatorAuthority } from "./event-stream-access.js";
import type { EventStreamOperatorAuthorityInput } from "./event-stream-access.js";

/**
 * Authorizes recovery of the daemon's one shared control-room reader.
 *
 * A plain WORK session is deliberately insufficient: advancing this cursor can
 * change what the live control room observes. Authority belongs to the configured
 * operator itself or to a durable operator-opened session carrying the exact full
 * operator capability set used by the approved pairing flow. The session record is
 * re-read from daemon-owned storage; caller payload and target bytes choose nothing.
 */
export function hasEventResumeOperatorAuthority(
  input: EventStreamOperatorAuthorityInput,
): boolean {
  return hasEventStreamOperatorAuthority(input);
}
