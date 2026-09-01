import type { SessionHandshakePort } from "../identity/session-handshake.js";
import {
  refusePairingApproval,
} from "./pairing-approval-window.js";
import type {
  PairingApprovalRefusal,
  PairingClaimReservation,
  PairingRequestCreated,
  PairingRequestPort,
} from "./pairing-approval-window.js";
import { assembleClaimChallenge, readPairingClaim } from "./pairing-claim-challenge.js";
import { validMinted, validRefused } from "./pairing-mint-vetting.js";
import type { PairingClaimChallenge, PairingClaimMaterial } from "./pairing-claim-challenge.js";
import type { SessionChallengeOperandsReadPort } from "./session-challenge-operands-read.js";

export const PAIRING_REQUEST_PATH = "/session/pair/request" as const;
export const PAIRING_CLAIM_PATH = "/session/pair/claim" as const;
/** `{\"requestId\":\"<64 lowercase hex>\"}` plus bounded JSON whitespace. */
export const PAIRING_APPROVAL_MAX_BODY_BYTES = 96;

/**
 * The CLAIM route's own bound, deliberately SEPARATE from the 96 above rather than a widening
 * of it (ruling `comment-1b17ab9b`).
 *
 * WHY NOT JUST RAISE THE 96. That constant is not this route's alone: it is read at
 * `project-manager-http-routing.ts:132` and `:163`, a different ORIGIN and COOKIE authority, and
 * is pinned to 96 by `pairing-approval-window.test.ts:79`. Raising it would silently loosen a
 * body bound on the manager surface as a side effect of a pairing change — two authorities
 * moving together because they happened to share a number.
 *
 * WHY 1024. Under the ruling's arm (A) an approved claim carries a possession proof, not just a
 * request id: `publicKeySpkiHex` (88 hex), `clientKeyId` (64), `requestDigest` (64) and a proof
 * object whose `signatureHex` alone is 128 hex — roughly 600 bytes serialized, which cannot fit
 * 96. 1024 admits that shape with headroom for bounded JSON whitespace and nothing larger.
 */
export const PAIRING_CLAIM_MAX_BODY_BYTES = 1024;

export interface PairingClaimed {
  readonly capabilities: readonly string[];
  /**
   * Present EXACTLY when the claim carried key material. Approval is the disclosure
   * gate (ruling `comment-d3a24ac8`), so these three store-held scalars reach the
   * approved claimant here and travel no other route; a bearer claim, and every
   * refusal, answer without the field at all rather than with an empty one.
   */
  readonly challenge?: PairingClaimChallenge;
  readonly expiresAt: string;
  readonly ok: true;
  /** The HUMAN principal this claim minted; a browser needs it to sign an open request. */
  readonly principalId: string;
  readonly projectId: string;
  readonly sessionCredential: string;
}

export interface PairingApprovalHandshakePort {
  claim(body: Uint8Array): PairingClaimed | PairingApprovalRefusal;
  request(body: Uint8Array): PairingRequestCreated | PairingApprovalRefusal;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
/** Consumes the approval so no further claim of it can reach the mint again. */
function consumeApproval(reservation: PairingClaimReservation): void {
  try {
    reservation.commit();
  } catch {
    // A broken reservation remains CLAIMING and therefore still cannot mint again.
  }
}

function burnAmbiguous(reservation: PairingClaimReservation): PairingApprovalRefusal {
  consumeApproval(reservation);
  return refusePairingApproval("PAIRING_SESSION_MINT_OUTCOME_UNKNOWN");
}

function recordOf(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(decoder.decode(body)) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isCreateBody(body: Uint8Array): boolean {
  const record = recordOf(body);
  return record !== null && Object.keys(record).length === 0;
}

/**
 * The claim body's shape lives in `pairing-claim-challenge.ts` beside the challenge it
 * gates, so the roster that admits a key and the assembly that answers one cannot drift
 * apart. This seam only decides what a null means.
 */
function claimMaterial(body: Uint8Array): PairingClaimMaterial | null {
  return readPairingClaim(recordOf(body));
}

/** Status is transport metadata; the stable refusing code and layer stay unchanged. */
export function pairingApprovalStatusFor(code: PairingApprovalRefusal["code"]): number {
  if (code === "PAIRING_APPROVAL_CAPACITY_EXHAUSTED") return 429;
  if (code === "PAIRING_APPROVAL_REQUIRED" || code === "PAIRING_REQUEST_BUSY") return 409;
  if (code === "PAIRING_REQUEST_ALREADY_CLAIMED" || code === "PAIRING_REQUEST_EXPIRED") return 410;
  if (code === "PAIRING_REQUEST_UNKNOWN" || code === "PAIRING_CONFIRMATION_UNKNOWN") return 404;
  if (code === "PAIRING_APPROVAL_CLOCK_UNAVAILABLE"
    || code === "PAIRING_APPROVAL_ENTROPY_UNAVAILABLE"
    || code === "PAIRING_APPROVAL_IDENTITY_EXHAUSTED"
    || code === "PAIRING_APPROVAL_UNAVAILABLE"
    || code === "PAIRING_CLAIM_CHALLENGE_UNAVAILABLE"
    || code === "PAIRING_SESSION_MINT_FAILED"
    || code === "PAIRING_SESSION_MINT_OUTCOME_UNKNOWN") return 503;
  return 400;
}

export function createPairingApprovalHandshake(
  requests: PairingRequestPort,
  pairing: SessionHandshakePort,
  operands?: SessionChallengeOperandsReadPort,
): PairingApprovalHandshakePort {
  return Object.freeze({
    claim: (body: Uint8Array): PairingClaimed | PairingApprovalRefusal => {
      const material = claimMaterial(body);
      if (material === null) return refusePairingApproval("PAIRING_CLAIM_REQUEST_INVALID");
      // FAIL CLOSED BEFORE RESERVING. A claim that asks for a challenge this daemon
      // cannot assemble must not consume the operator's approval, so the wiring check
      // happens above `reserve` rather than after the mint has already burned it.
      if (material.publicKeySpkiHex !== undefined && operands === undefined) {
        return refusePairingApproval("PAIRING_CLAIM_CHALLENGE_UNAVAILABLE");
      }
      let reserved: ReturnType<PairingRequestPort["reserve"]>;
      try {
        reserved = requests.reserve(material.requestId);
      } catch {
        return refusePairingApproval("PAIRING_APPROVAL_UNAVAILABLE");
      }
      if (!reserved.ok) return reserved;
      try {
        const minted: unknown = pairing.mint(material);
        const refused = validRefused(minted);
        if (refused !== null) {
          // FAIL CLOSED ON UNCERTAINTY. The ONLY path back to a retryable approval is
          // an explicit RELEASE, which the mint declares exactly when nothing durable
          // was written. A BURN, a missing disposition and any unrecognised value all
          // consume the approval, so a refusal that already committed a durable HUMAN
          // principal can never be retried into a second one.
          if (refused.disposition === "RELEASE") reserved.reservation.release();
          else consumeApproval(reserved.reservation);
          return refusePairingApproval(
            "PAIRING_SESSION_MINT_FAILED",
            refused.cause ?? undefined,
          );
        }
        if (!validMinted(minted)) return burnAmbiguous(reserved.reservation);
        // READ-ONLY, AND ONLY FOR A KEY-BEARING CLAIM. The operand read touches no
        // aggregate and writes nothing, so between this line and the later open
        // completion there is still no durable key-bound record — the property ruling
        // comment-d3a24ac8 protects. A bearer claim never reaches this branch and its
        // response keeps exactly the shape it had before this row.
        let challenge: PairingClaimChallenge | null = null;
        if (material.publicKeySpkiHex !== undefined && operands !== undefined) {
          challenge = assembleClaimChallenge(operands, minted.principalId);
          // The approval already committed a durable principal, so an unreadable
          // challenge BURNS rather than releases: a retry would mint a second one.
          if (challenge === null) {
            consumeApproval(reserved.reservation);
            return refusePairingApproval("PAIRING_CLAIM_CHALLENGE_UNAVAILABLE");
          }
        }
        const claimed = Object.freeze({
          capabilities: Object.freeze([...minted.capabilities]),
          ...(challenge === null ? {} : { challenge }),
          expiresAt: minted.expiresAt,
          ok: true as const,
          principalId: minted.principalId,
          projectId: pairing.boundProjectId,
          sessionCredential: minted.credential,
        });
        reserved.reservation.commit();
        return claimed;
      } catch {
        return burnAmbiguous(reserved.reservation);
      }
    },
    request: (body: Uint8Array): PairingRequestCreated | PairingApprovalRefusal => {
      if (!isCreateBody(body)) return refusePairingApproval("PAIRING_CREATE_REQUEST_INVALID");
      try {
        return requests.create();
      } catch {
        return refusePairingApproval("PAIRING_APPROVAL_UNAVAILABLE");
      }
    },
  });
}
