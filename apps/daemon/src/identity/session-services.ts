import type { JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import {
  decodeSessionRequestBytes,
  isCredentialSha256,
  isIsoInstant,
} from "./session-contracts.js";
import type { SessionRequest } from "./session-contracts.js";
import {
  aggregateIdFor,
  commitAccepted,
  payloadRef,
  readSessionLedger,
  refuse,
  replayOf,
} from "./session-ledger.js";
import type {
  CommandHandler,
  HandlerContext,
  HandlerTable,
  SessionOutcome,
} from "./session-ledger.js";
import type { SessionRecord } from "./session-read-model.js";

/**
 * The session-lifecycle services and the pipeline every session command runs through.
 *
 * A handler composes and never keeps state: it validates payload facts, checks the durable fold's
 * prerequisites, and commits exactly one decision. Everything time-flavoured is deliberately
 * ABSENT here — the pipeline is clockless, deciding purely over the ledger, so replaying the same
 * commands always reproduces the same decisions. Whether a session is EXPIRED is an
 * authentication-time judgment owned by `createSessionAuthenticator`'s injected clock; a renew of
 * an already-expired but still-open session is therefore accepted, which is precisely the
 * recovery path the error registry prescribes for `SESSION_EXPIRED` (`session.renew`).
 */

function parseCapabilities(value: JsonValue | undefined): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((entry): entry is string => typeof entry === "string" && entry.length > 0)) {
    return null;
  }
  // Sorted and deduplicated so two equivalent grants fold to identical stored facts — the same
  // canonicalization `@moe/core`'s session record applies to transport ids. An EMPTY list is
  // allowed: a session with no capabilities authenticates but is denied per-command by the seam.
  return Object.freeze([...new Set(value)].sort());
}

function record(context: HandlerContext, sessionId: string): SessionRecord | undefined {
  return context.ledger.sessions.get(sessionId);
}

/**
 * Opens a session: binds a client-generated credential HASH to a session id, a capability set
 * and an expiry. The plaintext credential never appears in the payload, the event, or the result.
 * A session id is single-use — reopening a CLOSED id refuses `SESSION_ALREADY_CLOSED`, because a
 * revived id would resurrect every capability the close revoked.
 */
const openSession: CommandHandler = (context): SessionOutcome => {
  const { ledger, request, store } = context;
  const sessionId = payloadRef(request.payload, "sessionId");
  const capabilities = parseCapabilities(request.payload["capabilities"]);
  if (sessionId === null || capabilities === null) {
    return refuse(request.kind, "SESSION_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  const credentialSha256 = request.payload["credentialSha256"];
  if (!isCredentialSha256(credentialSha256)) {
    return refuse(request.kind, "SESSION_CREDENTIAL_HASH_INVALID", "DAEMON_INGRESS");
  }
  const expiresAt = request.payload["expiresAt"];
  if (!isIsoInstant(expiresAt)) {
    return refuse(request.kind, "SESSION_EXPIRED_AT_INVALID", "DAEMON_INGRESS");
  }
  if (ledger.unreadable) {
    return refuse(request.kind, "SESSION_LEDGER_UNREADABLE", "DAEMON_PREREQUISITE");
  }
  const existing = record(context, sessionId);
  if (existing !== undefined) {
    return existing.status === "CLOSED"
      ? refuse(request.kind, "SESSION_ALREADY_CLOSED", "DAEMON_PREREQUISITE")
      : refuse(request.kind, "SESSION_ALREADY_OPEN", "DAEMON_PREREQUISITE");
  }
  if (request.expectedVersion !== 0) {
    return refuse(request.kind, "SESSION_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  const facts = {
    capabilities: [...capabilities],
    credentialSha256,
    expiresAt,
    // The session principal is the principal that OPENED it: the envelope's authenticated
    // `principalId`, not a payload field a caller could point at someone else.
    principalId: request.principalId,
    sessionId,
  };
  return commitAccepted(store, request, {
    aggregateId: aggregateIdFor(sessionId),
    eventPayload: facts,
    eventType: "SessionOpened",
    expectedVersion: 0,
    result: facts,
  });
};

const closeSession: CommandHandler = (context): SessionOutcome => {
  const { ledger, request, store } = context;
  const sessionId = payloadRef(request.payload, "sessionId");
  if (sessionId === null) {
    return refuse(request.kind, "SESSION_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  if (ledger.unreadable) {
    return refuse(request.kind, "SESSION_LEDGER_UNREADABLE", "DAEMON_PREREQUISITE");
  }
  const existing = record(context, sessionId);
  if (existing === undefined) {
    return refuse(request.kind, "SESSION_NOT_FOUND", "DAEMON_PREREQUISITE");
  }
  if (existing.status === "CLOSED") {
    return refuse(request.kind, "SESSION_ALREADY_CLOSED", "DAEMON_PREREQUISITE");
  }
  if (request.expectedVersion !== existing.version) {
    return refuse(request.kind, "SESSION_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  const facts = { sessionId, status: "CLOSED" };
  return commitAccepted(store, request, {
    aggregateId: aggregateIdFor(sessionId),
    eventPayload: facts,
    eventType: "SessionClosed",
    expectedVersion: existing.version,
    result: facts,
  });
};

/**
 * Renewal replaces the expiry and nothing else — capabilities, principal and credential binding
 * are carried across unchanged, matching `@moe/core`'s `rotateCredential` posture that extending
 * scope is a separate authority.
 */
const renewSession: CommandHandler = (context): SessionOutcome => {
  const { ledger, request, store } = context;
  const sessionId = payloadRef(request.payload, "sessionId");
  if (sessionId === null) {
    return refuse(request.kind, "SESSION_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  const expiresAt = request.payload["expiresAt"];
  if (!isIsoInstant(expiresAt)) {
    return refuse(request.kind, "SESSION_EXPIRED_AT_INVALID", "DAEMON_INGRESS");
  }
  if (ledger.unreadable) {
    return refuse(request.kind, "SESSION_LEDGER_UNREADABLE", "DAEMON_PREREQUISITE");
  }
  const existing = record(context, sessionId);
  if (existing === undefined) {
    return refuse(request.kind, "SESSION_NOT_FOUND", "DAEMON_PREREQUISITE");
  }
  if (existing.status === "CLOSED") {
    return refuse(request.kind, "SESSION_ALREADY_CLOSED", "DAEMON_PREREQUISITE");
  }
  if (request.expectedVersion !== existing.version) {
    return refuse(request.kind, "SESSION_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  const facts = { expiresAt, sessionId, status: "OPEN" };
  return commitAccepted(store, request, {
    aggregateId: aggregateIdFor(sessionId),
    eventPayload: facts,
    eventType: "SessionRenewed",
    expectedVersion: existing.version,
    result: facts,
  });
};

export const SESSION_HANDLERS: HandlerTable = Object.freeze({
  "session.close": closeSession,
  "session.open": openSession,
  "session.renew": renewSession,
});

/**
 * The pipeline: decode -> replay lookup -> handler lookup -> prerequisite checks -> handler.
 *
 * Replay lookup precedes every handler deliberately: `openSession` refuses a duplicate session
 * id, so an identical retried open would be refused and could never be recognised as the replay
 * it actually is. The ledger is read AFTER the replay short-circuit so a replayed command costs
 * no fold.
 */
export function runSessionCommand(
  store: SqliteEventStore,
  input: unknown,
  handlers: HandlerTable = SESSION_HANDLERS,
): SessionOutcome {
  const decoded = decodeSessionRequestBytes(input);
  if (!decoded.ok) return refuse(null, decoded.code, "DAEMON_INGRESS");

  const request: SessionRequest = decoded.request;
  const replay = replayOf(store, request);
  if (replay !== null) return replay;

  const handler = handlers[request.kind];
  if (handler === undefined) {
    return refuse(request.kind, "SESSION_COMMAND_UNKNOWN", "DAEMON_INGRESS");
  }

  const ledger = readSessionLedger(store, request.projectId);
  const context: HandlerContext = { ledger, request, store };
  return handler(context);
}
