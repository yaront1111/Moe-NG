/**
 * Strict, fail-closed readers for durable session-authority aggregates.
 * Any malformed event, sequence gap, or foreign schema yields UNKNOWN.
 */

import { createCredential, createPrincipal, createSession } from "@moe/core";
import type { Principal, RecoveryAuthenticationBinding } from "@moe/core";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { SESSION_AUTHORITY_SCHEMA_VERSION, SESSION_PROOF_ALGORITHM }
  from "./session-authority-contracts.js";
import type { SessionAuthoritySnapshot } from "./session-authority-contracts.js";
import {
  isBoundedId, isCanonicalSessionPublicKey, isUnsignedSafeInteger, readExactRecord,
} from "./session-authority-protocol.js";
import { isRecoveryAuthenticationRef } from "./recovery-authentication-binding.js";

export interface CredentialRecord extends RecoveryAuthenticationBinding {
  readonly credentialId: string;
  readonly generation: number;
  readonly clientKeyId: string;
  readonly publicKeySpkiHex: string;
  readonly revoked: boolean;
}

/** The current snapshot plus every historical credential this session has held. */
export interface SessionFold {
  readonly snapshot: SessionAuthoritySnapshot;
  readonly credentials: readonly CredentialRecord[];
}

export type SessionFoldRead =
  | Readonly<{ status: "FOUND"; fold: SessionFold }>
  | Readonly<{ status: "ABSENT" }>
  | Readonly<{ status: "UNKNOWN" }>;

export type PrincipalRead =
  | Readonly<{ status: "FOUND"; principal: Principal }>
  | Readonly<{ status: "ABSENT" }>
  | Readonly<{ status: "UNKNOWN" }>;

const decoder = new TextDecoder("utf-8", { fatal: true });
const UNKNOWN = Object.freeze({ status: "UNKNOWN" as const });
const ABSENT = Object.freeze({ status: "ABSENT" as const });

const OPENED_KEYS = [
  "projectId", "principalId", "principalKind", "profileRevisionId", "sessionId",
  "credentialId", "clientKeyId", "publicKeySpkiHex", "transportIds", "createdAt",
  "expiresAt", "absoluteExpiresAt", "recoveryIncarnationRef", "keyEpochRef",
] as const;
const ROTATED_KEYS = ["credentialId", "generation", "clientKeyId", "publicKeySpkiHex"] as const;
const PRINCIPAL_KEYS = ["principalId", "kind", "profileRevisionId"] as const;

export function principalAggregateId(principalId: string): string {
  return `${SESSION_AUTHORITY_SCHEMA_VERSION}/principal/${principalId}`;
}

export function sessionAggregateId(sessionId: string): string {
  return `${SESSION_AUTHORITY_SCHEMA_VERSION}/session/${sessionId}`;
}

function decodePayload(event: StoredEvent): Record<string, unknown> | null {
  try {
    if (event.domainSchemaVersion !== SESSION_AUTHORITY_SCHEMA_VERSION) return null;
    const parsed: unknown = JSON.parse(decoder.decode(event.payload));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface Draft {
  readonly opened: Record<string, unknown>;
  readonly credentials: CredentialRecord[];
  expiresAt: number;
  status: "ACTIVE" | "CLOSED";
  generation: number;
}

function credentialOf(
  raw: Record<string, unknown>,
  generation: number,
  recovery?: RecoveryAuthenticationBinding,
): CredentialRecord | null {
  const { clientKeyId, credentialId, publicKeySpkiHex } = raw;
  if (typeof credentialId !== "string" || typeof clientKeyId !== "string") return null;
  if (!isCanonicalSessionPublicKey(publicKeySpkiHex)) return null;
  const recoveryIncarnationRef = recovery?.recoveryIncarnationRef ?? raw.recoveryIncarnationRef;
  const keyEpochRef = recovery?.keyEpochRef ?? raw.keyEpochRef;
  if (!isRecoveryAuthenticationRef(recoveryIncarnationRef)) return null;
  if (!isRecoveryAuthenticationRef(keyEpochRef)) return null;
  return {
    credentialId, generation, clientKeyId, publicKeySpkiHex, revoked: false,
    recoveryIncarnationRef, keyEpochRef,
  };
}

function openDraft(payload: Record<string, unknown>): Draft | null {
  const raw = readExactRecord(payload, OPENED_KEYS);
  if (raw === null || !isUnsignedSafeInteger(raw.expiresAt)) return null;
  const credential = credentialOf(raw, 1);
  if (credential === null) return null;
  return {
    opened: raw,
    credentials: [credential],
    expiresAt: raw.expiresAt,
    status: "ACTIVE",
    generation: 1,
  };
}

function applyRotation(draft: Draft, payload: Record<string, unknown>): boolean {
  const raw = readExactRecord(payload, ROTATED_KEYS);
  if (raw === null || raw.generation !== draft.generation + 1) return false;
  const previous = draft.credentials.at(-1);
  const next = previous === undefined ? null : credentialOf(raw, raw.generation, previous);
  if (next === null || previous === undefined || previous.revoked) return false;
  draft.credentials[draft.credentials.length - 1] = { ...previous, revoked: true };
  draft.credentials.push(next);
  draft.generation = next.generation;
  return true;
}

function applyEvent(draft: Draft, event: StoredEvent, payload: Record<string, unknown>): boolean {
  if (draft.status === "CLOSED") return false;
  if (event.eventType === "SessionAuthorityCredentialRotated") return applyRotation(draft, payload);
  if (event.eventType === "SessionAuthorityRenewed") {
    const raw = readExactRecord(payload, ["expiresAt"]);
    if (raw === null || !isUnsignedSafeInteger(raw.expiresAt)) return false;
    draft.expiresAt = raw.expiresAt;
    return true;
  }
  if (event.eventType === "SessionAuthorityClosed") {
    const raw = readExactRecord(payload, ["closedAt"]);
    if (raw === null || !isUnsignedSafeInteger(raw.closedAt)) return false;
    draft.status = "CLOSED";
    return true;
  }
  return false;
}

/** Every record is built by a core factory, so the fold cannot mint its own shapes. */
function snapshotOf(draft: Draft, version: number): SessionAuthoritySnapshot | null {
  const current = draft.credentials.at(-1);
  if (current === undefined) return null;
  const { absoluteExpiresAt, createdAt, principalId, profileRevisionId } = draft.opened;
  const { principalKind, projectId, sessionId, transportIds } = draft.opened;
  const principal = createPrincipal({ principalId, kind: principalKind, profileRevisionId });
  const session = createSession({
    sessionId, principalId, profileRevisionId,
    clientKeyId: current.clientKeyId, transportIds,
    status: draft.status, expiresAt: draft.expiresAt, generation: draft.generation,
    recoveryIncarnationRef: current.recoveryIncarnationRef,
    keyEpochRef: current.keyEpochRef,
  });
  const credential = createCredential({
    credentialId: current.credentialId, sessionId,
    generation: current.generation, revoked: current.revoked,
    recoveryIncarnationRef: current.recoveryIncarnationRef,
    keyEpochRef: current.keyEpochRef,
  });
  if (principal === null || session === null || credential === null) return null;
  if (!isBoundedId(projectId) || !isUnsignedSafeInteger(createdAt)) return null;
  if (!isUnsignedSafeInteger(absoluteExpiresAt) || session.generation !== credential.generation) {
    return null;
  }
  return Object.freeze({
    projectId, principal, session, credential,
    publicKey: Object.freeze({
      algorithm: SESSION_PROOF_ALGORITHM,
      clientKeyId: current.clientKeyId,
      publicKeySpkiHex: current.publicKeySpkiHex,
    }),
    createdAt, absoluteExpiresAt, version,
  });
}

/** Reads every page of an aggregate, refusing any sequence gap. */
function readAllEvents(store: SqliteEventStore, aggregateId: string): readonly StoredEvent[] | null {
  try {
    const events: StoredEvent[] = [];
    let after = 0;
    for (;;) {
      const page = store.readAggregateEvents(aggregateId, after, 100);
      for (const event of page.items) {
        if (event.aggregateSequence !== events.length + 1) return null;
        events.push(event);
      }
      if (!page.hasMore || page.nextCursor === null) return events;
      after = page.nextCursor;
    }
  } catch {
    return null;
  }
}

export function readSessionFold(store: SqliteEventStore, sessionId: unknown): SessionFoldRead {
  if (!isBoundedId(sessionId)) return UNKNOWN;
  const events = readAllEvents(store, sessionAggregateId(sessionId));
  if (events === null) return UNKNOWN;
  if (events.length === 0) return ABSENT;
  const first = events[0];
  if (first?.eventType !== "SessionAuthorityOpened") return UNKNOWN;
  const openedPayload = decodePayload(first);
  const draft = openedPayload === null ? null : openDraft(openedPayload);
  if (draft === null || draft.opened.sessionId !== sessionId) return UNKNOWN;
  for (const event of events.slice(1)) {
    const payload = decodePayload(event);
    if (payload === null || !applyEvent(draft, event, payload)) return UNKNOWN;
  }
  const snapshot = snapshotOf(draft, events.length);
  if (snapshot === null) return UNKNOWN;
  return Object.freeze({
    status: "FOUND" as const,
    fold: Object.freeze({ snapshot, credentials: Object.freeze([...draft.credentials]) }),
  });
}

export function readPrincipalRecord(store: SqliteEventStore, principalId: unknown): PrincipalRead {
  if (!isBoundedId(principalId)) return UNKNOWN;
  const events = readAllEvents(store, principalAggregateId(principalId));
  if (events === null) return UNKNOWN;
  if (events.length === 0) return ABSENT;
  const only = events[0];
  if (events.length !== 1 || only?.eventType !== "SessionAuthorityPrincipalCreated") return UNKNOWN;
  const payload = decodePayload(only);
  const raw = payload === null ? null : readExactRecord(payload, PRINCIPAL_KEYS);
  const principal = raw === null ? null : createPrincipal(raw);
  if (principal === null || principal.principalId !== principalId) return UNKNOWN;
  return Object.freeze({ status: "FOUND" as const, principal });
}
