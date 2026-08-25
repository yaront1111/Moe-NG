import type { SqliteEventStore } from "@moe/store";

import { readSessionLedger } from "../identity/session-read-model.js";

export interface EventStreamPrincipal {
  readonly capabilities: readonly string[];
  readonly principalId: string;
  readonly projectId: string;
}

export type EventStreamAccessRefusalCode =
  | "EVENT_STREAM_AUTHORITY_UNAVAILABLE"
  | "EVENT_STREAM_OPERATOR_AUTHORITY_REQUIRED"
  | "EVENT_STREAM_SUBSCRIBER_MISMATCH";

export interface EventStreamAccessGranted {
  readonly ok: true;
  /** The daemon-owned reader. Caller bytes may only agree with it, never select it. */
  readonly subscriberId: string;
}

export interface EventStreamAccessRefused {
  readonly code: EventStreamAccessRefusalCode;
  readonly httpStatus: 403 | 503;
  readonly layer: "DAEMON_AUTHORIZATION";
  readonly ok: false;
}

export type EventStreamAccessDecision = EventStreamAccessGranted | EventStreamAccessRefused;

export interface EventStreamAccessPort {
  authorize(principal: EventStreamPrincipal): EventStreamAccessDecision;
}

export interface EventStreamOperatorAuthorityInput {
  readonly operatorCapabilities: readonly string[];
  readonly operatorPrincipalId: string;
  readonly principal: EventStreamPrincipal;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

export interface EventStreamAccessConfig {
  readonly operatorCapabilities: readonly string[];
  readonly operatorPrincipalId: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
  readonly subscriberId: string;
}

function sameCapabilities(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return actualSet.size === expected.length
    && expectedSet.size === expected.length
    && expected.every((capability) => actualSet.has(capability));
}

/**
 * The shared control-room cursor is operator state. A WORK session is not enough:
 * authority belongs only to the configured operator or to a durable, OPEN session
 * opened by that operator with the exact full pairing capability set. The session
 * record is re-read from daemon-owned storage on every decision.
 */
export function hasEventStreamOperatorAuthority(
  input: EventStreamOperatorAuthorityInput,
): boolean {
  const {
    operatorCapabilities, operatorPrincipalId, principal, projectId, store,
  } = input;
  if (principal.projectId !== projectId
    || !sameCapabilities(principal.capabilities, operatorCapabilities)) {
    return false;
  }
  if (principal.principalId === operatorPrincipalId) return true;

  const ledger = readSessionLedger(store, projectId);
  if (ledger.unreadable) return false;
  const session = ledger.sessions.get(principal.principalId);
  return session !== undefined
    && session.status === "OPEN"
    && session.principalId === operatorPrincipalId
    && sameCapabilities(session.capabilities, operatorCapabilities);
}

export function eventStreamAccessUnavailable(): EventStreamAccessRefused {
  return Object.freeze({
    code: "EVENT_STREAM_AUTHORITY_UNAVAILABLE",
    httpStatus: 503,
    layer: "DAEMON_AUTHORIZATION",
    ok: false,
  });
}

export function eventStreamSubscriberMismatch(): EventStreamAccessRefused {
  return Object.freeze({
    code: "EVENT_STREAM_SUBSCRIBER_MISMATCH",
    httpStatus: 403,
    layer: "DAEMON_AUTHORIZATION",
    ok: false,
  });
}

export function createEventStreamAccessPort(config: EventStreamAccessConfig): EventStreamAccessPort {
  const granted = Object.freeze({ ok: true as const, subscriberId: config.subscriberId });
  const refused = Object.freeze({
    code: "EVENT_STREAM_OPERATOR_AUTHORITY_REQUIRED" as const,
    httpStatus: 403 as const,
    layer: "DAEMON_AUTHORIZATION" as const,
    ok: false as const,
  });
  return Object.freeze({
    authorize: (principal: EventStreamPrincipal): EventStreamAccessDecision =>
      hasEventStreamOperatorAuthority({
        operatorCapabilities: config.operatorCapabilities,
        operatorPrincipalId: config.operatorPrincipalId,
        principal,
        projectId: config.projectId,
        store: config.store,
      }) ? granted : refused,
  });
}
