import { COORDINATION_LIMITS, refuse } from "./coordination-contracts.js";
import type {
  CoordinationAddress, CoordinationDelivery, CoordinationRefused,
  CoordinationResponseEnvelope,
} from "./coordination-contracts.js";
import { decodeAddress } from "./coordination-parts.js";
import { isSafeCount } from "./coordination-shape.js";

export interface LimitOk { readonly value: number }

export function addressLabel(address: CoordinationAddress): string {
  return address.effectId === null ? "recipient" : "terminal recipient";
}

/** Re-decodes a caller-supplied mailbox address through the same strict reader the envelope
 *  uses, so an endpoint argument gets no weaker treatment than an envelope field. */
export function readMailboxAddress(value: unknown): CoordinationAddress | null {
  const decoded = decodeAddress(value, "mailbox");
  return decoded.ok ? decoded.value : null;
}

export function readLimit(value: number | undefined): CoordinationRefused | LimitOk {
  if (value === undefined) return { value: COORDINATION_LIMITS.maxPageSize };
  if (!isSafeCount(value) || value === 0) {
    return refuse("COORDINATION_INPUT_INVALID", "DECODE", "limit must be a positive integer");
  }
  if (value > COORDINATION_LIMITS.maxPageSize) {
    return refuse(
      "COORDINATION_LIMIT_EXCEEDED", "DECODE", "limit exceeds the supported page size",
    );
  }
  return { value };
}

function sameAddress(left: CoordinationAddress, right: CoordinationAddress): boolean {
  return left.effectId === right.effectId && left.role === right.role
    && left.sessionId === right.sessionId;
}

/**
 * A RESPONSE is valid only against a durable REQUEST that this sender actually received:
 * the addresses must reverse exactly and the correlation id must be identical. A reply to a
 * non-request, to a message that never existed, or across a swapped address pair is refused.
 */
export function checkCorrelation(
  envelope: CoordinationResponseEnvelope, stored: CoordinationDelivery | null,
): CoordinationRefused | null {
  if (stored === null || stored.envelope.kind !== "REQUEST") {
    return refuse(
      "COORDINATION_REPLY_TARGET_MISSING", "CORRELATION",
      "the referenced message is not a durable request in this mailbox",
    );
  }
  const request = stored.envelope;
  if (!sameAddress(request.sender, envelope.recipient)
    || !sameAddress(request.recipient, envelope.sender)) {
    return refuse(
      "COORDINATION_REPLY_ADDRESS_MISMATCH", "CORRELATION",
      "a response must exactly reverse the addresses of the request it answers",
    );
  }
  if (request.correlationId !== envelope.correlationId) {
    return refuse(
      "COORDINATION_CORRELATION_MISMATCH", "CORRELATION",
      "a response must carry the correlation id of the request it answers",
    );
  }
  return null;
}
