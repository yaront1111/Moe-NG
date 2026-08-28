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
  readonly resolveSubscriberId: (principal: EventStreamPrincipal) => string | undefined;
  readonly store: SqliteEventStore;
}

export interface EventStreamSubscriberResolverConfig {
  readonly clock: () => number;
  readonly operatorCapabilities: readonly string[];
  readonly operatorPrincipalId: string;
  readonly operatorSubscriberId: string | undefined;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

export type EventStreamSubscriberResolver =
  (principal: EventStreamPrincipal) => string | undefined;

function sameCapabilities(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return actualSet.size === expected.length
    && expectedSet.size === expected.length
    && expected.every((capability) => actualSet.has(capability));
}

/**
 * Resolves the daemon-owned reader from durable session identity. The configured operator and
 * first durable full pairing session keep the legacy reader; later sessions use disjoint readers.
 */
export function createEventStreamSubscriberResolver(
  config: EventStreamSubscriberResolverConfig,
): EventStreamSubscriberResolver {
  return (principal) => {
    const operatorSubscriberId = config.operatorSubscriberId;
    if (operatorSubscriberId === undefined || operatorSubscriberId.length === 0
      || principal.principalId.length === 0 || principal.projectId !== config.projectId
      || !sameCapabilities(principal.capabilities, config.operatorCapabilities)) {
      return undefined;
    }
    if (principal.principalId === config.operatorPrincipalId) return operatorSubscriberId;
    const ledger = readSessionLedger(config.store, config.projectId);
    const session = ledger.sessions.get(principal.principalId);
    const expiresAt = session === undefined ? Number.NaN : Date.parse(session.expiresAt);
    const now = config.clock();
    // Map insertion order is durable decision order; updates never reassign this compatibility slot.
    const legacySessionId = [...ledger.sessions.values()].find((candidate) =>
      candidate.principalId === config.operatorPrincipalId
      && sameCapabilities(candidate.capabilities, config.operatorCapabilities))?.sessionId;
    if (ledger.unreadable || session === undefined || session.status !== "OPEN"
      || session.principalId !== config.operatorPrincipalId
      || !sameCapabilities(session.capabilities, config.operatorCapabilities)
      || !Number.isFinite(expiresAt) || !Number.isFinite(now) || now >= expiresAt) {
      return undefined;
    }
    return session.sessionId === legacySessionId
      ? operatorSubscriberId
      : `reader:${session.sessionId}`;
  };
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

function hasUnavailableSessionBinding(input: EventStreamOperatorAuthorityInput): boolean {
  const {
    operatorCapabilities, operatorPrincipalId, principal, projectId, store,
  } = input;
  if (principal.projectId !== projectId
    || !sameCapabilities(principal.capabilities, operatorCapabilities)) {
    return false;
  }
  if (typeof principal.principalId !== "string" || principal.principalId.length === 0) return true;
  if (principal.principalId === operatorPrincipalId) return false;
  const ledger = readSessionLedger(store, projectId);
  if (ledger.unreadable) return true;
  const session = ledger.sessions.get(principal.principalId);
  return session !== undefined
    && session.principalId === operatorPrincipalId
    && sameCapabilities(session.capabilities, operatorCapabilities)
    && session.status === "CLOSED";
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
  const refused = Object.freeze({
    code: "EVENT_STREAM_OPERATOR_AUTHORITY_REQUIRED" as const,
    httpStatus: 403 as const,
    layer: "DAEMON_AUTHORIZATION" as const,
    ok: false as const,
  });
  return Object.freeze({
    authorize: (principal: EventStreamPrincipal): EventStreamAccessDecision => {
      const authorityInput = {
        operatorCapabilities: config.operatorCapabilities,
        operatorPrincipalId: config.operatorPrincipalId,
        principal,
        projectId: config.projectId,
        store: config.store,
      };
      const hasAuthority = hasEventStreamOperatorAuthority(authorityInput);
      if (!hasAuthority) {
        return hasUnavailableSessionBinding(authorityInput)
          ? eventStreamAccessUnavailable()
          : refused;
      }
      const subscriberId = config.resolveSubscriberId(principal);
      return subscriberId === undefined || subscriberId.length === 0
        ? eventStreamAccessUnavailable()
        : Object.freeze({ ok: true, subscriberId });
    },
  });
}
