/**
 * The durable coordination recipient registry.
 *
 * It answers one question — is this exact coordination address a known recipient — from
 * committed evidence only. A caller may present an address, never an answer: every write is
 * authorised by a CURRENT active session read here from the durable session authority, and the
 * resolver derives its facts from committed registry events plus that same authority.
 *
 * It carries no command, lifecycle, effect, or mailbox authority: nothing here sends, reads,
 * acknowledges, starts, stops, admits, or drains anything. The address grammar and the fold
 * live in `recipient-registry-records.ts`.
 */

import type {
  CoordinationAddress, CoordinationRecipientRegistry, CoordinationRefused,
} from "@moe/coordination";
import type { CommandDecisionKey, CommandDecisionRecord, SqliteEventStore } from "@moe/store";

import type {
  MutationReceipt, SessionAuthorityService, SessionAuthoritySnapshot,
} from "../identity/session-authority-contracts.js";
import { isUnsignedSafeInteger } from "../identity/session-authority-protocol.js";
import { receiptOf } from "../identity/session-authority-store.js";
import {
  COORDINATION_RECIPIENT_SCHEMA_VERSION, isRecipientIdentifier, readRecipientAddress,
  readRecipientCommand, readRecipientFold, recipientAggregateId, recipientJsonBytes,
  recipientStoreCode, refuse,
} from "./recipient-registry-records.js";
import type {
  RecipientCommand, RecipientCommandKind, RecipientEventType, RecipientRecord,
} from "./recipient-registry-records.js";

export {
  COORDINATION_RECIPIENT_EVENT_TYPES, COORDINATION_RECIPIENT_SCHEMA_VERSION,
  recipientAggregateId,
} from "./recipient-registry-records.js";
export type {
  RecipientCommand, RecipientCommandKind, RecipientEventType, RecipientRecord, RecipientRead,
} from "./recipient-registry-records.js";

export interface RecipientRegistryOptions {
  readonly clock: () => number;
  readonly projectId: string;
  readonly sessions: SessionAuthorityService;
  readonly store: SqliteEventStore;
}

export interface RecipientAccepted {
  readonly outcome: "ACCEPTED" | "DEDUPLICATED";
  readonly receipt: MutationReceipt;
  readonly recipient: CoordinationAddress;
  readonly version: number;
}

export type RecipientMutationResult = RecipientAccepted | CoordinationRefused;

export interface RecipientRegistryService {
  readonly register: (input: unknown) => RecipientMutationResult;
  readonly replace: (input: unknown) => RecipientMutationResult;
  readonly revoke: (input: unknown) => RecipientMutationResult;
  readonly resolveRecipient: CoordinationRecipientRegistry;
}

interface RecipientCommit {
  readonly command: RecipientCommand;
  readonly eventPayload: Readonly<Record<string, unknown>>;
  readonly eventType: RecipientEventType;
  readonly expectedVersion: number;
  readonly kind: RecipientCommandKind;
  readonly principalId: string;
}

/** The only negative answer that means "looked, found nothing". Unreadable evidence answers
 *  `undefined` instead, so "we never looked" can never read as a durable absence. */
const NOT_KNOWN = Object.freeze({ known: false as const, role: null });

export function createRecipientRegistry(
  options: RecipientRegistryOptions,
): RecipientRegistryService {
  const { clock, projectId, sessions, store } = options;
  if (!isRecipientIdentifier(projectId) || typeof clock !== "function") {
    throw new TypeError("a recipient registry requires a bounded project id and a clock");
  }

  function now(): number | null {
    try {
      const value: unknown = clock();
      return isUnsignedSafeInteger(value) ? value : null;
    } catch {
      return null;
    }
  }

  /** The only positive session evidence this module accepts: durable, current, project-scoped,
   *  and read here rather than presented by a caller. */
  function activeSession(sessionId: string): SessionAuthoritySnapshot | null {
    try {
      const read = sessions.readActiveSession(sessionId);
      if (read.status !== "FOUND") return null;
      const authority = read.authority;
      if (authority.projectId !== projectId) return null;
      return authority.session.sessionId === sessionId ? authority : null;
    } catch {
      return null;
    }
  }

  function precondition(
    kind: RecipientCommandKind, current: RecipientRecord | null,
  ): CoordinationRefused | null {
    if (kind === "REGISTER") {
      return current === null ? null : refuse("COORDINATION_IDEMPOTENCY_CONFLICT", "STORE",
        "that session already carries a durable recipient record");
    }
    if (current === null || current.revoked) {
      return refuse("COORDINATION_RECIPIENT_UNKNOWN", "ADDRESS",
        "that session has no live recipient record to change");
    }
    return null;
  }

  function commit(plan: RecipientCommit): RecipientMutationResult {
    const at = now();
    const { commandId, correlationId, recipient } = plan.command;
    if (at === null) {
      return refuse("COORDINATION_STORE_UNAVAILABLE", "STORE", "the registry clock is unusable");
    }
    const key: CommandDecisionKey = { commandId, principalId: plan.principalId, projectId };
    try {
      const response = store.commitExpectedVersionDecision({
        commandKind: plan.kind,
        committedResultBytes: recipientJsonBytes({
          command: plan.kind, sessionId: recipient.sessionId, version: plan.expectedVersion + 1,
        }),
        correlationId,
        decidedAt: new Date(at).toISOString(),
        events: [{
          domainSchemaVersion: COORDINATION_RECIPIENT_SCHEMA_VERSION,
          eventId: `${commandId}/${plan.eventType}`,
          eventType: plan.eventType,
          payload: recipientJsonBytes(plan.eventPayload),
        }],
        expectedVersion: plan.expectedVersion,
        key,
        requestBytes: recipientJsonBytes({ command: plan.kind, ...plan.eventPayload }),
        targetAggregateId: recipientAggregateId(recipient.sessionId),
      });
      const decision = response.decision;
      if (decision.effectDisposition !== "EFFECTS_COMMITTED") {
        return refuse("COORDINATION_IDEMPOTENCY_CONFLICT", "STORE",
          "the recipient aggregate moved underneath this command");
      }
      const read = readRecipientFold(store, recipient.sessionId);
      if (read.status !== "FOUND") {
        return refuse("COORDINATION_STORE_UNAVAILABLE", "STORE",
          "the committed recipient record could not be read back");
      }
      return Object.freeze({
        outcome: response.disposition === "REPLAYED" ? "DEDUPLICATED" as const : "ACCEPTED" as const,
        receipt: receiptOf(decision),
        recipient: Object.freeze({
          effectId: read.record.effectId, role: read.record.role, sessionId: recipient.sessionId,
        }),
        version: read.record.version,
      });
    } catch (error) {
      return refuse(recipientStoreCode(error), "STORE",
        "the recipient decision could not be committed");
    }
  }

  function write(
    input: unknown, kind: RecipientCommandKind, eventType: RecipientEventType,
  ): RecipientMutationResult {
    const parsed = readRecipientCommand(input);
    if ("outcome" in parsed) return parsed;
    const { commandId, recipient } = parsed;
    const authority = activeSession(recipient.sessionId);
    if (authority === null) {
      return refuse("COORDINATION_AUTHENTICATION_FAILED", "AUTHENTICATION",
        "no current active session of this project owns that recipient address");
    }
    const read = readRecipientFold(store, recipient.sessionId);
    if (read.status === "UNKNOWN") {
      return refuse("COORDINATION_STORE_UNAVAILABLE", "STORE", "the recipient ledger did not fold");
    }
    const current = read.status === "FOUND" ? read.record : null;
    const principalId = authority.principal.principalId;
    let decided: CommandDecisionRecord | null;
    try {
      decided = store.getCommandDecision({ commandId, principalId, projectId });
    } catch (error) {
      return refuse(recipientStoreCode(error), "STORE",
        "the recipient decision ledger is unreadable");
    }
    // A replay is a no-op that returns the ORIGINAL receipt, so the preconditions that would
    // reject the second arrival of an already-decided command must not run for it. The store
    // hashes expectedVersion into the request identity, so a replay must also restate the
    // version the first arrival claimed rather than the one the aggregate has now.
    if (decided !== null && decided.commandKind !== kind) {
      return refuse("COORDINATION_IDEMPOTENCY_CONFLICT", "STORE",
        "that command id already decided a different recipient command");
    }
    const blocked = decided === null ? precondition(kind, current) : null;
    if (blocked !== null) return blocked;
    return commit({
      command: parsed,
      eventPayload: kind === "REVOKE" ? { sessionId: recipient.sessionId } : {
        effectId: recipient.effectId, generation: authority.session.generation,
        projectId, role: recipient.role, sessionId: recipient.sessionId,
      },
      eventType,
      expectedVersion: decided?.previousVersion ?? (current === null ? 0 : current.version),
      kind, principalId,
    });
  }

  /** Frozen, exact, and total. Six ways to stay unknown — absent, revoked, cross-project,
   *  address mismatch, inactive (expired or closed), and rotated — are separate branches, so a
   *  rotated or foreign record can never be mistaken for a merely absent one. */
  function resolveRecipient(address: CoordinationAddress): unknown {
    try {
      const wanted = readRecipientAddress(address);
      if (wanted === null) return undefined;
      const read = readRecipientFold(store, wanted.sessionId);
      if (read.status === "UNKNOWN") return undefined;
      if (read.status === "ABSENT") return NOT_KNOWN;
      const record = read.record;
      if (record.revoked || record.projectId !== projectId) return NOT_KNOWN;
      if (record.role !== wanted.role || record.effectId !== wanted.effectId) return NOT_KNOWN;
      const authority = activeSession(wanted.sessionId);
      if (authority === null) return NOT_KNOWN;
      if (authority.session.generation !== record.generation) return NOT_KNOWN;
      return Object.freeze({ known: true as const, role: record.role });
    } catch {
      return undefined;
    }
  }

  return Object.freeze({
    register: (input: unknown): RecipientMutationResult =>
      write(input, "REGISTER", "CoordinationRecipientRegistered"),
    replace: (input: unknown): RecipientMutationResult =>
      write(input, "REPLACE", "CoordinationRecipientReplaced"),
    revoke: (input: unknown): RecipientMutationResult =>
      write(input, "REVOKE", "CoordinationRecipientRevoked"),
    resolveRecipient,
  });
}
