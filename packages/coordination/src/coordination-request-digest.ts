import { decodeCoordinationEnvelope, digestBytes } from "./coordination-codec.js";
import { COORDINATION_ENDPOINTS, COORDINATION_LIMITS } from "./coordination-contracts.js";
import type {
  CoordinationAddress, CoordinationEndpoint,
} from "./coordination-contracts.js";
import { readLimit, readMailboxAddress } from "./coordination-service-input.js";
import { isIdentifier, isPlainRecord, textBytes } from "./coordination-shape.js";

export interface CoordinationSendRequest {
  readonly envelope: unknown; readonly presentation: unknown; readonly transportId: string;
}
export interface CoordinationMailboxRequest {
  readonly limit?: number; readonly mailbox: CoordinationAddress;
  readonly presentation: unknown; readonly transportId: string;
}
export interface CoordinationReplayRequest extends CoordinationMailboxRequest {
  readonly fromSequence: number;
}
export interface CoordinationAcknowledgeRequest {
  readonly digest: string; readonly mailbox: CoordinationAddress; readonly messageId: string;
  readonly presentation: unknown; readonly sequence: number; readonly transportId: string;
}

type MailboxEndpoint = Exclude<CoordinationEndpoint, "SEND">;
type Unsigned<T> = Omit<T, "presentation">;

export interface CoordinationUnsignedRequestByEndpoint {
  readonly ACKNOWLEDGE: Unsigned<CoordinationAcknowledgeRequest>;
  readonly READ: Unsigned<CoordinationMailboxRequest>;
  readonly REPLAY: Unsigned<CoordinationReplayRequest>;
  readonly SEND: Unsigned<CoordinationSendRequest>;
}

const SEND_KEYS = ["envelope", "presentation", "transportId"] as const;
const READ_KEYS = ["mailbox", "presentation", "transportId"] as const;
const REPLAY_KEYS = ["fromSequence", "mailbox", "presentation", "transportId"] as const;
const ACKNOWLEDGE_KEYS = [
  "digest", "mailbox", "messageId", "presentation", "sequence", "transportId",
] as const;

function readRequestRecord(
  value: unknown, required: readonly string[], optional: readonly string[] = [],
): Readonly<Record<string, unknown>> | null {
  if (!isPlainRecord(value)) return null;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return null;
  if (required.some((key) => !keys.includes(key))) return null;
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    snapshot[key as string] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

export function readCoordinationSendRequest(value: unknown): CoordinationSendRequest | null {
  return readRequestRecord(value, SEND_KEYS) as CoordinationSendRequest | null;
}

export function readCoordinationMailboxRequest(value: unknown): CoordinationMailboxRequest | null {
  return readRequestRecord(value, READ_KEYS, ["limit"]) as CoordinationMailboxRequest | null;
}

export function readCoordinationReplayRequest(value: unknown): CoordinationReplayRequest | null {
  return readRequestRecord(value, REPLAY_KEYS, ["limit"]) as CoordinationReplayRequest | null;
}

export function readCoordinationAcknowledgeRequest(
  value: unknown,
): CoordinationAcknowledgeRequest | null {
  return readRequestRecord(value, ACKNOWLEDGE_KEYS) as CoordinationAcknowledgeRequest | null;
}

/** Shared verifier/signer preimage for a decoded SEND request. */
export function digestValidatedCoordinationSendRequest(
  transportId: string, canonicalEnvelopeBytes: Uint8Array,
): string {
  return digestBytes(
    "moe-coordination-send-request/1", textBytes(transportId), canonicalEnvelopeBytes,
  );
}

/** Shared verifier/signer preimage for a validated mailbox request. */
export function digestValidatedCoordinationMailboxRequest(
  endpoint: MailboxEndpoint, transportId: string, address: CoordinationAddress, limit: number,
  extra: readonly Uint8Array[],
): string {
  return digestBytes(
    `moe-coordination-${endpoint.toLowerCase()}-request/1`, textBytes(transportId),
    textBytes(address.role), textBytes(address.sessionId), textBytes(address.effectId ?? ""),
    textBytes(String(limit)), ...extra,
  );
}

function mailboxExtra(
  endpoint: MailboxEndpoint,
  request: Unsigned<CoordinationMailboxRequest> | Unsigned<CoordinationReplayRequest>
    | Unsigned<CoordinationAcknowledgeRequest>,
): readonly Uint8Array[] | null {
  if (endpoint === "READ") return [];
  if (endpoint === "REPLAY") {
    const fromSequence = (request as Unsigned<CoordinationReplayRequest>).fromSequence;
    return Number.isSafeInteger(fromSequence) && fromSequence >= 0
      ? [textBytes(String(fromSequence))] : null;
  }
  const ack = request as Unsigned<CoordinationAcknowledgeRequest>;
  const limit = COORDINATION_LIMITS.maxIdentifierUtf8Bytes;
  if (!isIdentifier(ack.messageId, limit) || !isIdentifier(ack.digest, limit)
    || !Number.isSafeInteger(ack.sequence) || ack.sequence <= 0) return null;
  return [textBytes(ack.messageId), textBytes(ack.digest), textBytes(String(ack.sequence))];
}

/**
 * Computes the exact digest the coordination service asks its authenticator to attest.
 * Invalid requests have no signable digest.
 */
export function coordinationRequestDigest<E extends CoordinationEndpoint>(
  endpoint: E, request: CoordinationUnsignedRequestByEndpoint[E],
): string | null {
  try {
    if (!COORDINATION_ENDPOINTS.includes(endpoint)) return null;
    const keys = endpoint === "SEND" ? ["envelope", "transportId"]
      : endpoint === "READ" ? ["mailbox", "transportId"]
        : endpoint === "REPLAY" ? ["fromSequence", "mailbox", "transportId"]
          : ["digest", "mailbox", "messageId", "sequence", "transportId"];
    const optional = endpoint === "READ" || endpoint === "REPLAY" ? ["limit"] : [];
    const snapshot = readRequestRecord(request, keys, optional);
    if (snapshot === null) return null;
    const transportId = snapshot["transportId"];
    if (!isIdentifier(transportId, COORDINATION_LIMITS.maxIdentifierUtf8Bytes)) return null;
    if (endpoint === "SEND") {
      const decoded = decodeCoordinationEnvelope(snapshot["envelope"]);
      return decoded.ok
        ? digestValidatedCoordinationSendRequest(transportId, decoded.canonicalBytes)
        : null;
    }
    const mailboxRequest = snapshot as unknown as CoordinationUnsignedRequestByEndpoint[MailboxEndpoint];
    const address = readMailboxAddress(snapshot["mailbox"]);
    const limit = readLimit(snapshot["limit"] as number | undefined);
    if (address === null || "outcome" in limit) return null;
    const extra = mailboxExtra(endpoint, mailboxRequest);
    return extra === null ? null : digestValidatedCoordinationMailboxRequest(
      endpoint, transportId, address, limit.value, extra,
    );
  } catch {
    return null;
  }
}
