import type { SessionHandshakePort } from "../identity/session-handshake.js";
import { isIsoInstant } from "../identity/session-contracts.js";
import {
  refusePairingApproval,
} from "./pairing-approval-window.js";
import type {
  PairingApprovalRefusal,
  PairingClaimReservation,
  PairingRequestCreated,
  PairingRequestPort,
} from "./pairing-approval-window.js";

export const PAIRING_REQUEST_PATH = "/session/pair/request" as const;
export const PAIRING_CLAIM_PATH = "/session/pair/claim" as const;
/** `{\"requestId\":\"<64 lowercase hex>\"}` plus bounded JSON whitespace. */
export const PAIRING_APPROVAL_MAX_BODY_BYTES = 96;

export interface PairingClaimed {
  readonly capabilities: readonly string[];
  readonly expiresAt: string;
  readonly ok: true;
  readonly projectId: string;
  readonly sessionCredential: string;
}

export interface PairingApprovalHandshakePort {
  claim(body: Uint8Array): PairingClaimed | PairingApprovalRefusal;
  request(body: Uint8Array): PairingRequestCreated | PairingApprovalRefusal;
}

const REQUEST_ID = /^[0-9a-f]{64}$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });
const MINTED_KEYS = Object.freeze(["capabilities", "credential", "expiresAt", "ok"]);
const REFUSED_KEYS = Object.freeze(["code", "ok"]);

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validMinted(value: unknown): value is Readonly<{
  readonly capabilities: readonly string[];
  readonly credential: string;
  readonly expiresAt: string;
  readonly ok: true;
}> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const capabilities = record["capabilities"];
  const expiresAt = record["expiresAt"];
  return keys.length === MINTED_KEYS.length
    && keys.every((key, index) => key === MINTED_KEYS[index])
    && record["ok"] === true
    && nonEmpty(record["credential"])
    && typeof expiresAt === "string"
    && isIsoInstant(expiresAt)
    && Array.isArray(capabilities)
    && capabilities.length > 0
    && capabilities.every(nonEmpty);
}

function validRefused(value: unknown): value is Readonly<{
  readonly code: string;
  readonly ok: false;
}> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === REFUSED_KEYS.length
    && keys.every((key, index) => key === REFUSED_KEYS[index])
    && record["ok"] === false
    && nonEmpty(record["code"]);
}

function burnAmbiguous(reservation: PairingClaimReservation): PairingApprovalRefusal {
  try {
    reservation.commit();
  } catch {
    // A broken reservation remains CLAIMING and therefore still cannot mint again.
  }
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

function claimRequestId(body: Uint8Array): string | null {
  const record = recordOf(body);
  if (record === null) return null;
  const keys = Object.keys(record);
  const requestId = record["requestId"];
  return keys.length === 1 && keys[0] === "requestId"
    && typeof requestId === "string" && REQUEST_ID.test(requestId)
    ? requestId
    : null;
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
    || code === "PAIRING_SESSION_MINT_FAILED"
    || code === "PAIRING_SESSION_MINT_OUTCOME_UNKNOWN") return 503;
  return 400;
}

export function createPairingApprovalHandshake(
  requests: PairingRequestPort,
  pairing: SessionHandshakePort,
): PairingApprovalHandshakePort {
  return Object.freeze({
    claim: (body: Uint8Array): PairingClaimed | PairingApprovalRefusal => {
      const requestId = claimRequestId(body);
      if (requestId === null) return refusePairingApproval("PAIRING_CLAIM_REQUEST_INVALID");
      let reserved: ReturnType<PairingRequestPort["reserve"]>;
      try {
        reserved = requests.reserve(requestId);
      } catch {
        return refusePairingApproval("PAIRING_APPROVAL_UNAVAILABLE");
      }
      if (!reserved.ok) return reserved;
      try {
        const minted: unknown = pairing.mint();
        if (validRefused(minted)) {
          reserved.reservation.release();
          return refusePairingApproval("PAIRING_SESSION_MINT_FAILED");
        }
        if (!validMinted(minted)) return burnAmbiguous(reserved.reservation);
        const claimed = Object.freeze({
          capabilities: Object.freeze([...minted.capabilities]),
          expiresAt: minted.expiresAt,
          ok: true as const,
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
