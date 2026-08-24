/**
 * The in-process lifetime and one-use reservation for the browser pairing bearer.
 *
 * This is deliberately separate from the HTTP route. Token equality belongs to the listener
 * guard, while time and consume state belong here; combining either with the credential mint
 * would let a failed mint spend a token or let a clock rollback revive an expired one.
 */

import { performance } from "node:perf_hooks";

import { pairingTokenMatches } from "./http-listener-guards.js";

/** Short enough that an abandoned launcher line does not remain authority for the daemon life. */
export const PAIRING_TOKEN_TTL_MS = 60_000;

export interface PairingTokenWindow {
  /** Atomically reserves a live matching token. Wrong, used, and expired all answer false. */
  reserve(presented: string, expected: string): boolean;
  /** Releases only the consume reservation after a mint that produced no credential. */
  release(): void;
}

function readMonotonic(now: () => number): number | null {
  try {
    const value = now();
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Creates one fail-closed window at token-mint/listener-start time.
 *
 * `now` is injectable so the real socket test can cross the deadline without sleeping. The
 * production default is monotonic, so wall-clock correction cannot extend bearer authority.
 * Once expiry is observed it is latched: even a broken injected clock moving backwards cannot
 * reopen the token. Equality is still evaluated for every presentation, including expired or
 * reused ones, so those states do not introduce a cheap token-shape timing branch.
 */
export function createPairingTokenWindow(
  now: () => number = () => performance.now(),
): PairingTokenWindow {
  const openedAt = readMonotonic(now);
  const deadline = openedAt === null ? null : openedAt + PAIRING_TOKEN_TTL_MS;
  let consumed = false;
  let expired = deadline === null || !Number.isFinite(deadline);

  return Object.freeze({
    release: (): void => {
      consumed = false;
    },
    reserve: (presented: string, expected: string): boolean => {
      const matches = pairingTokenMatches(presented, expected);
      const observed = readMonotonic(now);
      if (observed === null || deadline === null || observed >= deadline) expired = true;
      if (consumed || expired || !matches) return false;
      consumed = true;
      return true;
    },
  });
}
