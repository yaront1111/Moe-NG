import type { JsonObject } from "@moe/contracts";

/** Fixed wire versions. A stored envelope carries the envelope version; every endpoint
 *  request digest is domain-separated by the endpoint version. Neither is negotiable. */
export const COORDINATION_ENVELOPE_VERSION = "moe-coordination-envelope/1" as const;
export const COORDINATION_ENDPOINT_VERSION = "moe-coordination-endpoint/1" as const;
/** The one capability scope this service ever asks an authenticator to attest. */
export const COORDINATION_SCOPE = "moe:coordination" as const;

export const COORDINATION_ENDPOINTS = Object.freeze([
  "ACKNOWLEDGE", "READ", "REPLAY", "SEND",
] as const);
export const COORDINATION_ENVELOPE_KINDS = Object.freeze([
  "CONTROL", "EVENT", "HANDOFF", "REQUEST", "RESPONSE",
] as const);
export const COORDINATION_ROLES = Object.freeze([
  "CODER", "CONTROL_ROOM", "REVIEWER", "TERMINAL",
] as const);
/** Closed, deliberately NON-lifecycle vocabulary. Nothing here starts, stops, cancels,
 *  admits, or drains anything; a CONTROL envelope is a coordination signal, not a command. */
export const COORDINATION_CONTROL_KINDS = Object.freeze([
  "ATTENTION_REQUESTED", "CAPACITY_REPORTED", "HEARTBEAT", "MAILBOX_DRAINED",
  "REPLAY_REQUESTED",
] as const);
export const COORDINATION_LAYERS = Object.freeze([
  "ADDRESS", "AUTHENTICATION", "CAPABILITY", "CORRELATION", "DECODE", "MAILBOX", "STORE",
] as const);
export const COORDINATION_CODES = Object.freeze([
  "COORDINATION_ACK_REGRESSION", "COORDINATION_ACK_UNKNOWN_MESSAGE",
  "COORDINATION_ADVISORY_AUTHORITY_CLAIMED", "COORDINATION_AUTHENTICATION_FAILED",
  "COORDINATION_CAPABILITY_DENIED", "COORDINATION_CORRELATION_MISMATCH",
  "COORDINATION_FORBIDDEN_FIELD", "COORDINATION_IDEMPOTENCY_CONFLICT",
  "COORDINATION_INPUT_INVALID", "COORDINATION_LIMIT_EXCEEDED", "COORDINATION_MAILBOX_FULL",
  "COORDINATION_MESSAGE_EXPIRED", "COORDINATION_OUTCOME_UNKNOWN",
  "COORDINATION_RECIPIENT_UNKNOWN", "COORDINATION_REPLY_ADDRESS_MISMATCH",
  "COORDINATION_REPLY_TARGET_MISSING", "COORDINATION_SENDER_MISMATCH",
  "COORDINATION_STORE_BUSY", "COORDINATION_STORE_UNAVAILABLE",
  "COORDINATION_TERMINAL_BINDING_INVALID",
] as const);

/** Key names that may never appear anywhere in an envelope, at any nesting depth. The first
 *  group would forward a secret; the second would let free-form data read as a command. */
export const COORDINATION_FORBIDDEN_FIELDS = Object.freeze([
  "apiKey", "argv", "authorization", "bearer", "cmd", "command", "credential", "credentialId",
  "eval", "exec", "password", "privateKey", "proof", "script", "secret", "sessionCredential",
  "shell", "spawn", "token",
] as const);

export const COORDINATION_LIMITS = Object.freeze({
  maxAdvisoryUtf8Bytes: 4_096,
  maxDataDepth: 8,
  maxEnvelopeBytes: 65_536,
  maxHandoffEntries: 32,
  maxIdentifierUtf8Bytes: 128,
  maxOutstandingMessages: 32,
  maxPageBytes: 262_144,
  maxPageSize: 32,
  maxSendAttempts: 8,
  maxTextUtf8Bytes: 1_024,
  maxTtlMilliseconds: 86_400_000,
  minTtlMilliseconds: 0,
});

export type CoordinationEndpoint = (typeof COORDINATION_ENDPOINTS)[number];
export type CoordinationEnvelopeKind = (typeof COORDINATION_ENVELOPE_KINDS)[number];
export type CoordinationRole = (typeof COORDINATION_ROLES)[number];
export type CoordinationControlKind = (typeof COORDINATION_CONTROL_KINDS)[number];
export type CoordinationLayer = (typeof COORDINATION_LAYERS)[number];
export type CoordinationCode = (typeof COORDINATION_CODES)[number];

/** An exact session address. `effectId` is non-null only for a terminal/effect wrapper, and
 *  such an address is accepted only against a current positive effect binding. */
export interface CoordinationAddress {
  readonly effectId: string | null;
  readonly role: CoordinationRole;
  readonly sessionId: string;
}

/** Free-form text carried as data. `advisoryOnly` is structurally pinned to `true`: there is
 *  no shape in which advisory text arrives claiming authority. */
export interface CoordinationAdvisory {
  readonly advisoryOnly: true;
  readonly text: string;
}

/** A structured handoff. Every field is bounded data; `nextAction` is a description of the
 *  exact next action, never an executable instruction the service will run. */
export interface CoordinationHandoff {
  readonly artifactDigests: readonly string[];
  readonly baseRef: string;
  readonly blockers: readonly string[];
  readonly criteria: readonly string[];
  readonly decisions: readonly string[];
  readonly headRef: string;
  readonly nextAction: string;
  readonly objective: string;
  readonly repository: string;
  readonly scopes: readonly string[];
  readonly verificationDigests: readonly string[];
}

/** Caller-owned envelope fields. Sequence and timestamps are deliberately absent: they are
 *  server-owned and stamped at storage, so they can never be asserted by a sender. */
export interface CoordinationEnvelopeFields {
  readonly advisory: CoordinationAdvisory | null;
  readonly correlationId: string;
  readonly data: JsonObject;
  readonly messageId: string;
  readonly recipient: CoordinationAddress;
  readonly sender: CoordinationAddress;
  readonly ttlMilliseconds: number;
}

export interface CoordinationControlEnvelope extends CoordinationEnvelopeFields {
  readonly control: CoordinationControlKind; readonly kind: "CONTROL";
}
export interface CoordinationEventEnvelope extends CoordinationEnvelopeFields {
  readonly kind: "EVENT";
}
export interface CoordinationHandoffEnvelope extends CoordinationEnvelopeFields {
  readonly handoff: CoordinationHandoff; readonly kind: "HANDOFF";
}
export interface CoordinationRequestEnvelope extends CoordinationEnvelopeFields {
  readonly kind: "REQUEST";
}
export interface CoordinationResponseEnvelope extends CoordinationEnvelopeFields {
  readonly inReplyTo: string; readonly kind: "RESPONSE";
}
export type CoordinationEnvelope =
  | CoordinationControlEnvelope | CoordinationEventEnvelope | CoordinationHandoffEnvelope
  | CoordinationRequestEnvelope | CoordinationResponseEnvelope;

/** One durable mailbox entry as a reader sees it. `sequence` is the mailbox aggregate
 *  sequence; an EXPIRED entry is still returned so a consumer can acknowledge it explicitly
 *  rather than have it silently vanish from the cursor. */
export interface CoordinationDelivery {
  readonly digest: string;
  readonly envelope: CoordinationEnvelope;
  readonly envelopeVersion: typeof COORDINATION_ENVELOPE_VERSION;
  readonly expiresAt: number;
  readonly sentAt: number;
  readonly sequence: number;
  readonly state: "DELIVERABLE" | "EXPIRED";
}

export interface CoordinationRefused {
  readonly code: CoordinationCode; readonly detail: string;
  readonly layer: CoordinationLayer; readonly outcome: "REFUSED";
}
export interface CoordinationAccepted {
  readonly digest: string; readonly expiresAt: number; readonly messageId: string;
  readonly outcome: "ACCEPTED" | "DEDUPLICATED"; readonly sentAt: number;
  readonly sequence: number;
}
export interface CoordinationPage {
  readonly hasMore: boolean; readonly items: readonly CoordinationDelivery[];
  readonly nextCursor: number | null; readonly outcome: "PAGE";
}
/** A cursor that is ahead of, or not contiguous with, the durable mailbox. Carries both
 *  positions so the caller can reseat deliberately instead of guessing. */
export interface CoordinationCursorGap {
  readonly durableCursor: number; readonly mailboxSequence: number;
  readonly outcome: "CURSOR_GAP";
}
export interface CoordinationAcknowledged {
  readonly outcome: "ACKNOWLEDGED"; readonly sequence: number;
}

export type CoordinationSendResult = CoordinationAccepted | CoordinationRefused;
export type CoordinationReadResult =
  | CoordinationCursorGap | CoordinationPage | CoordinationRefused;
export type CoordinationAckResult = CoordinationAcknowledged | CoordinationRefused;

export function refuse(
  code: CoordinationCode, layer: CoordinationLayer, detail: string,
): CoordinationRefused {
  return Object.freeze({ code, detail, layer, outcome: "REFUSED" as const });
}

/**
 * The exact capability string an endpoint requires. SEND is scoped per envelope kind AND
 * per recipient session; the mailbox endpoints are scoped per mailbox session. Callers and
 * tests must derive grants through this function so a grant format change cannot drift.
 */
export function coordinationCapability(
  endpoint: CoordinationEndpoint,
  sessionId: string,
  kind: CoordinationEnvelopeKind | null = null,
): string {
  const scope = kind === null ? "" : `${kind.toLowerCase()}:`;
  return `coordination:${endpoint.toLowerCase()}:${scope}${sessionId}`;
}
