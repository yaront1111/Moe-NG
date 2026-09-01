import type {
  SessionChallengeOperandsReadPort,
} from "./session-challenge-operands-read.js";

/**
 * The claim body's EXACT key roster, in two admitted shapes.
 *
 * A bearer claim names only its request. A key-bearing claim adds the public key the
 * browser will later prove possession of. Anything else — a third key, a misspelling,
 * a missing request id — is refused by code rather than silently dropped, so a client
 * that sends the wrong shape learns it instead of pairing with a field ignored.
 */
export const PAIRING_CLAIM_BEARER_KEYS: readonly string[] = Object.freeze(["requestId"]);
export const PAIRING_CLAIM_KEYED_KEYS: readonly string[] =
  Object.freeze(["publicKeySpkiHex", "requestId"]);

const REQUEST_ID = /^[0-9a-f]{64}$/u;
/** SubjectPublicKeyInfo for an Ed25519 key is 44 bytes, so 88 lowercase hex characters. */
const SPKI_HEX = /^[0-9a-f]{88}$/u;

/**
 * What one approved claim carried, after its body passed the roster above.
 */
export interface PairingClaimMaterial {
  /**
   * ABSENT, not null, on the bearer path. The seam forwards this object to the mint, so
   * an explicit `null` would be a new own property on a shape DoD 2 requires to stay
   * unchanged — the bearer claim must reach the mint carrying exactly what it carried
   * before this row.
   */
  readonly publicKeySpkiHex?: string;
  readonly requestId: string;
}

/**
 * The claim-bound challenge operands, disclosed ONLY to an approved claimant.
 *
 * These are the three store-held scalars `openSession` folds into its expected request
 * digest (`session-authority.ts:162-166`). A browser needs all three to sign before it
 * calls, which is why `task-c338dd23` published them; under ruling `comment-d3a24ac8`
 * the approved claim is the disclosure gate, so they never travel an unauthenticated
 * route.
 */
export interface PairingClaimChallenge {
  readonly keyEpochRef: string;
  readonly profileRevisionId: string;
  readonly recoveryIncarnationRef: string;
}

/** Both rosters are declared sorted, and `keys` is sorted by the caller, so this is positional. */
function exactKeys(keys: readonly string[], expected: readonly string[]): boolean {
  return keys.length === expected.length && expected.every((key, index) => keys[index] === key);
}

/**
 * Parses one claim body into its vetted material, or null when the body is not one of
 * the two admitted shapes.
 *
 * Both hex fields are validated HERE rather than at the mint, so a malformed key is a
 * claim-shape refusal and never reaches a durable write.
 */
export function readPairingClaim(record: Record<string, unknown> | null): PairingClaimMaterial | null {
  if (record === null) return null;
  const keys = Object.keys(record).sort();
  const requestId = record["requestId"];
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return null;
  if (exactKeys(keys, PAIRING_CLAIM_BEARER_KEYS)) return Object.freeze({ requestId });
  if (!exactKeys(keys, PAIRING_CLAIM_KEYED_KEYS)) return null;
  const publicKeySpkiHex = record["publicKeySpkiHex"];
  return typeof publicKeySpkiHex === "string" && SPKI_HEX.test(publicKeySpkiHex)
    ? Object.freeze({ publicKeySpkiHex, requestId })
    : null;
}

/**
 * Assembles the challenge for one minted principal by COMPOSING the production operand
 * reader that `task-c338dd23` landed.
 *
 * Nothing is recomputed, defaulted or copied from a literal: every scalar is whatever
 * the durable store answers for this principal at this instant. A caller that cannot
 * read the operands gets null, which the seam turns into a coded refusal rather than a
 * partial challenge.
 */
export function assembleClaimChallenge(
  operands: SessionChallengeOperandsReadPort,
  principalId: string,
): PairingClaimChallenge | null {
  const read = operands.readOperands(principalId);
  if (read.outcome !== "OPERANDS") return null;
  return Object.freeze({
    keyEpochRef: read.operands.keyEpochRef,
    profileRevisionId: read.operands.profileRevisionId,
    recoveryIncarnationRef: read.operands.recoveryIncarnationRef,
  });
}
