/**
 * The durable half of the session authority: deterministic aggregate identity,
 * strict event folding, and the single commit seam every mutation funnels
 * through. A fold is all-or-nothing: any sequence gap, unknown event type,
 * foreign schema version, or malformed payload yields UNKNOWN rather than a
 * partial positive record, so unverifiable bytes never become authority.
 */

import { createCredential, createPrincipal, createSession } from "@moe/core";
import type { Principal } from "@moe/core";
import { DurableStoreError } from "@moe/store";
import type { CommandDecisionKey, EffectsCommittedDecision } from "@moe/store";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import {
  SESSION_AUTHORITY_SCHEMA_VERSION,
  SESSION_PROOF_ALGORITHM,
} from "./session-authority-contracts.js";
import type {
  MutationReceipt,
  ReplayReceipt,
  SessionAuthorityCode,
  SessionAuthorityEventType,
  SessionAuthorityRefusal,
  SessionAuthoritySnapshot,
} from "./session-authority-contracts.js";
import {
  isBoundedId,
  isCanonicalSessionPublicKey,
  isSessionDigest,
  isUnsignedSafeInteger,
  readExactRecord,
} from "./session-authority-protocol.js";

export interface CredentialRecord {
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

export interface AuthorityCommit {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly commandKind: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly eventPayload: Readonly<Record<string, unknown>>;
  readonly eventType: SessionAuthorityEventType;
  readonly expectedVersion: number;
  readonly principalId: string;
  readonly projectId: string;
  readonly requestFacts: Readonly<Record<string, unknown>>;
  readonly resultFacts: Readonly<Record<string, unknown>>;
}

export type AuthorityCommitOutcome =
  | Readonly<{ ok: true; disposition: "DECIDED" | "REPLAYED"; decision: EffectsCommittedDecision }>
  | SessionAuthorityRefusal;

export type ReplayObservation =
  | Readonly<{ outcome: "FRESH"; receipt: ReplayReceipt }>
  | Readonly<{ outcome: "REPLAYED" }>
  | Readonly<{ outcome: "UNKNOWN" }>;

export interface ReplayMarker {
  readonly decidedAt: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly replayDigest: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UNKNOWN = Object.freeze({ status: "UNKNOWN" as const });
const ABSENT = Object.freeze({ status: "ABSENT" as const });
const REPLAYED = Object.freeze({ outcome: "REPLAYED" as const });
const UNKNOWN_REPLAY = Object.freeze({ outcome: "UNKNOWN" as const });

const OPENED_KEYS = [
  "projectId", "principalId", "principalKind", "profileRevisionId", "sessionId",
  "credentialId", "clientKeyId", "publicKeySpkiHex", "transportIds", "createdAt",
  "expiresAt", "absoluteExpiresAt",
] as const;
const ROTATED_KEYS = ["credentialId", "generation", "clientKeyId", "publicKeySpkiHex"] as const;
const PRINCIPAL_KEYS = ["principalId", "kind", "profileRevisionId"] as const;

export function principalAggregateId(principalId: string): string {
  return `${SESSION_AUTHORITY_SCHEMA_VERSION}/principal/${principalId}`;
}

export function sessionAggregateId(sessionId: string): string {
  return `${SESSION_AUTHORITY_SCHEMA_VERSION}/session/${sessionId}`;
}

export function replayAggregateId(replayDigest: string): string {
  return `${SESSION_AUTHORITY_SCHEMA_VERSION}/replay/${replayDigest}`;
}

function refusal(code: SessionAuthorityCode): SessionAuthorityRefusal {
  return Object.freeze({ ok: false as const, code, layer: "DURABLE_STORE" as const });
}

function storeCode(error: unknown): SessionAuthorityCode {
  if (!(error instanceof DurableStoreError)) return "OUTCOME_UNKNOWN";
  const conflict =
    error.code === "IDEMPOTENCY_CONFLICT" ||
    error.code === "COMMAND_ID_CONFLICT" ||
    error.code === "DURABLE_ID_CONFLICT";
  return conflict ? "SESSION_AUTHORITY_COMMAND_CONFLICT" : error.code;
}

/** Fixed key order, so a retry of the same request hashes identically. */
function jsonBytes(value: Readonly<Record<string, unknown>>): Uint8Array {
  const sorted = Object.keys(value).sort().map((key) => [key, value[key]] as const);
  return encoder.encode(JSON.stringify(Object.fromEntries(sorted)));
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

function credentialOf(raw: Record<string, unknown>, generation: number): CredentialRecord | null {
  const { clientKeyId, credentialId, publicKeySpkiHex } = raw;
  if (typeof credentialId !== "string" || typeof clientKeyId !== "string") return null;
  if (!isCanonicalSessionPublicKey(publicKeySpkiHex)) return null;
  return { credentialId, generation, clientKeyId, publicKeySpkiHex, revoked: false };
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
  const next = credentialOf(raw, raw.generation);
  const previous = draft.credentials.at(-1);
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
  });
  const credential = createCredential({
    credentialId: current.credentialId, sessionId,
    generation: current.generation, revoked: current.revoked,
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

export function receiptOf(decision: EffectsCommittedDecision): MutationReceipt {
  return Object.freeze({
    aggregateId: decision.targetAggregateId,
    commandId: decision.key.commandId,
    committedAt: decision.decidedAt,
    eventIds: Object.freeze([...decision.businessEventIds]),
    previousVersion: decision.previousVersion,
    currentVersion: decision.currentVersion,
    requestSha256: decision.requestSha256, resultSha256: decision.resultSha256,
  });
}

/** The single durable mutation seam; every lifecycle command commits exactly here. */
export function commitAuthorityDecision(
  store: SqliteEventStore,
  plan: AuthorityCommit,
): AuthorityCommitOutcome {
  const key: CommandDecisionKey = {
    commandId: plan.commandId,
    principalId: plan.principalId,
    projectId: plan.projectId,
  };
  try {
    // The decision key carries no kind, so without this guard an unrelated
    // command reusing the id would come back as an accepted replay of a command
    // that was never decided.
    const existing = store.getCommandDecision(key);
    if (existing !== null && existing.commandKind !== plan.commandKind) {
      return refusal("SESSION_AUTHORITY_COMMAND_CONFLICT");
    }
    const response = store.commitExpectedVersionDecision({
      commandKind: plan.commandKind,
      committedResultBytes: jsonBytes(plan.resultFacts),
      correlationId: plan.correlationId,
      decidedAt: plan.decidedAt,
      events: [{
        domainSchemaVersion: SESSION_AUTHORITY_SCHEMA_VERSION,
        eventId: `${plan.commandId}/${plan.eventType}`,
        eventType: plan.eventType,
        payload: jsonBytes(plan.eventPayload),
      }],
      expectedVersion: plan.expectedVersion,
      key,
      requestBytes: jsonBytes(plan.requestFacts),
      targetAggregateId: plan.aggregateId,
    });
    const decision = response.decision;
    if (decision.effectDisposition !== "EFFECTS_COMMITTED") return refusal(decision.resultCode);
    return Object.freeze({ ok: true as const, disposition: response.disposition, decision });
  } catch (error) {
    return refusal(storeCode(error));
  }
}

/**
 * Burns the hashed replay identity at expected version 0. Only the digest is
 * persisted, so the presented nonce never reaches an event, a result, or an id.
 */
export function observeReplayMarker(
  store: SqliteEventStore,
  marker: ReplayMarker,
): ReplayObservation {
  if (!isSessionDigest(marker.replayDigest)) return UNKNOWN_REPLAY;
  const outcome = commitAuthorityDecision(store, {
    aggregateId: replayAggregateId(marker.replayDigest),
    commandId: `${SESSION_AUTHORITY_SCHEMA_VERSION}/replay/${marker.replayDigest}`,
    commandKind: "OBSERVE_REPLAY",
    correlationId: `${SESSION_AUTHORITY_SCHEMA_VERSION}/replay`,
    decidedAt: marker.decidedAt,
    eventPayload: { replayDigest: marker.replayDigest },
    eventType: "SessionAuthorityReplayObserved",
    expectedVersion: 0,
    principalId: marker.principalId,
    projectId: marker.projectId,
    requestFacts: { kind: "OBSERVE_REPLAY", replayDigest: marker.replayDigest },
    resultFacts: { observed: true, replayDigest: marker.replayDigest },
  });
  if (!outcome.ok) {
    return outcome.code === "EXPECTED_VERSION_CONFLICT" ? REPLAYED : UNKNOWN_REPLAY;
  }
  if (outcome.disposition === "REPLAYED") return REPLAYED;
  const decision = outcome.decision;
  const eventId = decision.businessEventIds[0];
  if (decision.previousVersion !== 0 || decision.currentVersion !== 1) return UNKNOWN_REPLAY;
  if (eventId === undefined) return UNKNOWN_REPLAY;
  const receipt: ReplayReceipt = Object.freeze({
    aggregateId: decision.targetAggregateId,
    eventId,
    committedAt: decision.decidedAt,
    previousVersion: 0 as const,
    currentVersion: 1 as const,
    replayDigest: marker.replayDigest,
  });
  return Object.freeze({ outcome: "FRESH" as const, receipt });
}
