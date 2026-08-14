/**
 * How a fault becomes a detail string the host is allowed to publish.
 *
 * Details reach logs and IDE notifications, so they carry a reason TOKEN and
 * nothing else. This lives apart from the ports because it is a different
 * concern from what any single port does, and because one sanitizer shared by
 * every port is the only version of this rule worth having: a second copy would
 * drift, and the copy that drifted would be the one that leaked.
 */

/**
 * A whitelist, deliberately, not a blacklist. An OS error message can quote a
 * full path or a URL, so anything that is not recognisably a reason code is
 * discarded rather than filtered — filtering only removes the leaks somebody
 * already thought of.
 */
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,39}$/u;

export const UNKNOWN_CODE = "UNKNOWN";
export const TIMEOUT_CODE = "PROBE_TIMEOUT";

/**
 * The first sanitized reason token on the error's cause chain.
 *
 * Node reports the interesting code one or two `cause` hops below the thrown
 * error — `fetch` rejects with a bare TypeError whose cause carries
 * ECONNREFUSED — so reading only the top-level error collapses every transport
 * fault into UNKNOWN and makes the NOT_LISTENING arm, the one that licenses a
 * daemon start, unreachable in production while every test still passes.
 */
export const codeOf = (error: unknown): string => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const carrier = current as {
      readonly cause?: unknown;
      readonly code?: unknown;
      readonly name?: unknown;
    };
    if (typeof carrier.code === "string" && SAFE_CODE.test(carrier.code)) return carrier.code;
    if (carrier.name === "TimeoutError" || carrier.name === "AbortError") return TIMEOUT_CODE;
    current = carrier.cause;
  }
  return UNKNOWN_CODE;
};
