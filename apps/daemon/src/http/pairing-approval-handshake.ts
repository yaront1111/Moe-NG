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
const DISPOSED_REFUSED_KEYS = Object.freeze(["code", "disposition", "ok"]);
const LAYERED_REFUSED_KEYS = Object.freeze(["code", "layer", "ok"]);
const DISPOSED_LAYERED_KEYS = Object.freeze(["code", "disposition", "layer", "ok"]);
/** Distinguishes "no such own enumerable data property" from a property whose value is null. */
const ABSENT_PROPERTY = Symbol("absent-property");

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

/** What a validated port refusal is allowed to tell the pairing seam. */
interface ValidatedRefusal {
  /** Exactly `code` and `layer`, or null when the refusal carried no layer. */
  readonly cause: Readonly<{ readonly code: string; readonly layer: string }> | null;
  /** The declared retry disposition verbatim, or null when the refusal declared none. */
  readonly disposition: string | null;
}

/**
 * Reads an own ENUMERABLE DATA property. A hidden key, an accessor, a prototype
 * carrier or a missing key all read ABSENT_PROPERTY, so no getter is ever invoked
 * and no inherited value can pose as the port's own refusal fact.
 */
function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor
    ? descriptor.value
    : ABSENT_PROPERTY;
}

function validRefused(value: unknown): ValidatedRefusal | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  const hasExactKeys = (expected: readonly string[]): boolean =>
    keys.length === expected.length && expected.every((key) => keys.includes(key));
  // Four exact shapes, each a cross of "carries a layer" and "declares a
  // disposition". `layer` and `disposition` are both optional on the port type so
  // hand-written doubles stay valid, so all four have to be recognisable here.
  const disposedLayered = hasExactKeys(DISPOSED_LAYERED_KEYS);
  const layered = disposedLayered || hasExactKeys(LAYERED_REFUSED_KEYS);
  const disposed = disposedLayered || hasExactKeys(DISPOSED_REFUSED_KEYS);
  if (!layered && !disposed && !hasExactKeys(REFUSED_KEYS)) return null;

  const code = ownDataValue(value, "code");
  if (ownDataValue(value, "ok") !== false || !nonEmpty(code)) return null;

  let cause: Readonly<{ readonly code: string; readonly layer: string }> | null = null;
  if (layered) {
    const layer = ownDataValue(value, "layer");
    if (!nonEmpty(layer)) return null;
    // THE ONE CAUSE CONSTRUCTION: exactly `code` and `layer`, copied field by field
    // from vetted own data values. The port's own object is never forwarded and
    // never spread, so no structural extra can ride into the response or the wire.
    cause = Object.freeze({ code, layer });
  }
  if (!disposed) return Object.freeze({ cause, disposition: null });

  const disposition = ownDataValue(value, "disposition");
  return typeof disposition === "string" ? Object.freeze({ cause, disposition }) : null;
}

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
