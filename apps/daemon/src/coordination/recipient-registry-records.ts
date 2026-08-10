/**
 * The pure half of the coordination recipient registry: the closed address grammar, the
 * durable event vocabulary, and the all-or-nothing fold over committed events.
 *
 * Nothing here reads a session, writes a decision, or grants authority. It exists so the
 * registry's writer and resolver can share one reading of the bytes: if the fold and the
 * writer ever disagreed about what a record means, a row could be written that can never be
 * resolved, or resolved as something it was not written to be.
 */

import { COORDINATION_LIMITS, COORDINATION_ROLES } from "@moe/coordination";
import type {
  CoordinationAddress, CoordinationCode, CoordinationLayer, CoordinationRefused, CoordinationRole,
} from "@moe/coordination";
import { DurableStoreError } from "@moe/store";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { isUnsignedSafeInteger, readExactRecord } from "../identity/session-authority-protocol.js";

export const COORDINATION_RECIPIENT_SCHEMA_VERSION = "moe.coordination-recipient.v1" as const;

export const COORDINATION_RECIPIENT_EVENT_TYPES = Object.freeze([
  "CoordinationRecipientRegistered",
  "CoordinationRecipientReplaced",
  "CoordinationRecipientRevoked",
] as const);

export type RecipientEventType = (typeof COORDINATION_RECIPIENT_EVENT_TYPES)[number];
export type RecipientCommandKind = "REGISTER" | "REPLACE" | "REVOKE";

export interface RecipientCommand {
  readonly commandId: string;
  readonly correlationId: string;
  readonly recipient: CoordinationAddress;
}

export interface RecipientRecord {
  readonly effectId: string | null;
  readonly generation: number;
  readonly projectId: string;
  readonly revoked: boolean;
  readonly role: CoordinationRole;
  readonly version: number;
}

export type RecipientRead =
  | Readonly<{ status: "FOUND"; record: RecipientRecord }>
  | Readonly<{ status: "ABSENT" }>
  | Readonly<{ status: "UNKNOWN" }>;

const ROLES: readonly string[] = COORDINATION_ROLES;
const ADDRESS_KEYS = ["effectId", "role", "sessionId"] as const;
const COMMAND_KEYS = ["commandId", "correlationId", "recipient"] as const;
const STATE_KEYS = ["effectId", "generation", "projectId", "role", "sessionId"] as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UNKNOWN = Object.freeze({ status: "UNKNOWN" as const });
const ABSENT = Object.freeze({ status: "ABSENT" as const });

export function refuse(
  code: CoordinationCode, layer: CoordinationLayer, detail: string,
): CoordinationRefused {
  return Object.freeze({ code, detail, layer, outcome: "REFUSED" as const });
}

/** Printable ASCII with no space, bounded by the coordination identifier budget. Every
 *  accepted code unit is one UTF-8 byte, so the length check is the byte check. */
export function isRecipientIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > COORDINATION_LIMITS.maxIdentifierUtf8Bytes) return false;
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index);
    if (point < 0x21 || point > 0x7e) return false;
  }
  return true;
}

export function recipientAggregateId(sessionId: string): string {
  return `${COORDINATION_RECIPIENT_SCHEMA_VERSION}/recipient/${sessionId}`;
}

/** Fixed key order, so a retry of the same request hashes identically. */
export function recipientJsonBytes(value: Readonly<Record<string, unknown>>): Uint8Array {
  const sorted = Object.keys(value).sort().map((key) => [key, value[key]] as const);
  return encoder.encode(JSON.stringify(Object.fromEntries(sorted)));
}

export function readRecipientAddress(value: unknown): CoordinationAddress | null {
  const raw = readExactRecord(value, ADDRESS_KEYS);
  if (raw === null) return null;
  const { effectId, role, sessionId } = raw;
  if (!isRecipientIdentifier(sessionId)) return null;
  if (typeof role !== "string" || !ROLES.includes(role)) return null;
  if (effectId !== null && !isRecipientIdentifier(effectId)) return null;
  return Object.freeze({
    effectId: effectId as string | null, role: role as CoordinationRole, sessionId,
  });
}

export function readRecipientCommand(input: unknown): RecipientCommand | CoordinationRefused {
  const raw = readExactRecord(input, COMMAND_KEYS);
  if (raw === null || !isRecipientIdentifier(raw.commandId)) {
    return refuse("COORDINATION_INPUT_INVALID", "DECODE",
      "a recipient command is exactly a commandId, a correlationId, and a recipient");
  }
  if (!isRecipientIdentifier(raw.correlationId)) {
    return refuse("COORDINATION_INPUT_INVALID", "DECODE",
      "a recipient command needs a bounded correlation identifier");
  }
  const recipient = readRecipientAddress(raw.recipient);
  if (recipient === null) {
    return refuse("COORDINATION_INPUT_INVALID", "ADDRESS",
      "the recipient is not an exact address in the closed coordination role vocabulary");
  }
  return { commandId: raw.commandId, correlationId: raw.correlationId, recipient };
}

export function recipientStoreCode(error: unknown): CoordinationCode {
  if (!(error instanceof DurableStoreError)) return "COORDINATION_OUTCOME_UNKNOWN";
  if (error.code === "STORE_BUSY") return "COORDINATION_STORE_BUSY";
  const conflict = error.code === "IDEMPOTENCY_CONFLICT" ||
    error.code === "COMMAND_ID_CONFLICT" || error.code === "DURABLE_ID_CONFLICT";
  return conflict ? "COORDINATION_IDEMPOTENCY_CONFLICT" : "COORDINATION_STORE_UNAVAILABLE";
}

function decodePayload(event: StoredEvent): Record<string, unknown> | null {
  try {
    if (event.domainSchemaVersion !== COORDINATION_RECIPIENT_SCHEMA_VERSION) return null;
    const parsed: unknown = JSON.parse(decoder.decode(event.payload));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Revocation is terminal: a revoked record accepts no further event, so a revoked address can
 *  never be quietly resurrected by a later write. */
function applyEvent(
  previous: RecipientRecord | null, event: StoredEvent, sessionId: string, version: number,
): RecipientRecord | null {
  const payload = decodePayload(event);
  if (payload === null || previous?.revoked === true) return null;
  if (event.eventType === "CoordinationRecipientRevoked") {
    const raw = readExactRecord(payload, ["sessionId"]);
    if (previous === null || raw === null || raw.sessionId !== sessionId) return null;
    return { ...previous, revoked: true, version };
  }
  if (event.eventType === "CoordinationRecipientRegistered") {
    if (previous !== null) return null;
  } else if (event.eventType !== "CoordinationRecipientReplaced" || previous === null) {
    return null;
  }
  const raw = readExactRecord(payload, STATE_KEYS);
  if (raw === null || raw.sessionId !== sessionId) return null;
  const { effectId, generation, projectId, role } = raw;
  if (!isUnsignedSafeInteger(generation) || !isRecipientIdentifier(projectId)) return null;
  if (typeof role !== "string" || !ROLES.includes(role)) return null;
  if (effectId !== null && !isRecipientIdentifier(effectId)) return null;
  return {
    effectId: effectId as string | null, generation, projectId, revoked: false,
    role: role as CoordinationRole, version,
  };
}

/** All-or-nothing: a sequence gap, an unknown event type, a foreign schema version, or a
 *  malformed payload yields UNKNOWN rather than a partial positive record. */
export function readRecipientFold(store: SqliteEventStore, sessionId: string): RecipientRead {
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(recipientAggregateId(sessionId));
  } catch {
    return UNKNOWN;
  }
  if (events.length === 0) return ABSENT;
  let record: RecipientRecord | null = null;
  for (const [index, event] of events.entries()) {
    if (event.aggregateSequence !== index + 1) return UNKNOWN;
    const folded = applyEvent(record, event, sessionId, index + 1);
    if (folded === null) return UNKNOWN;
    record = folded;
  }
  return record === null ? UNKNOWN : Object.freeze({ status: "FOUND" as const, record });
}
