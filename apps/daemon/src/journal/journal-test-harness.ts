import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandKind } from "@moe/contracts";
import { createDeadEndJournal } from "@moe/context";
import type { DeadEndJournalEntry } from "@moe/context";
import type { SqliteEventStore } from "@moe/store";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import { OPERATOR_CAPABILITIES, createDaemonCommandPorts } from "../daemon-command-registry.js";
import { ensureGenesisRecoveryBinding } from "../identity/genesis-recovery-binding.js";
import { createSessionAuthenticator } from "../identity/session-authenticator.js";
import { handleCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import type { CommandAdapterDeps } from "../http/http-contract.js";
import {
  PRINCIPAL_ID, PROJECT_ID, openHarnessStore, seedReadyProject,
} from "../recovery/restore-test-harness.js";
import { encodeFoundationPayload } from "../work/foundation-attempt-codec.js";
import { commitFoundationPhase } from "../work/foundation-attempt-store.js";
import { deriveDispatchAggregateId } from "../work/foundation-attempt-codec.js";
import {
  FOUNDATION_RESERVATION_VERSION,
} from "../work/foundation-attempt-contracts.js";
import type { FoundationAttemptBound } from "../work/foundation-attempt-contracts.js";
import {
  JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_EVENT_TYPE, JOURNAL_RECORD_VERSION,
  deriveAttemptJournalAggregateId,
} from "./journal-contracts.js";

/**
 * The fixture the journal suites share: a REAL SqliteEventStore, a REAL activation
 * committed by the production ingress, a REAL dispatch reservation written by the
 * production phase writer, and the REAL HTTP seam over the REAL session
 * authenticator.
 *
 * NOTHING HERE HAND-FORGES AN ACTIVATION. `parseActivationGrant` demands a hex64
 * grantId derived from the whole successor intent, so the only coherent activation
 * is the one `runEffectActivateCommand` commits — which is what makes the lease,
 * attempt and session facts this suite calls durable genuinely durable.
 *
 * THE RESERVATION IS WRITTEN BY `commitFoundationPhase`, the same production
 * function `foundation-attempt-service.ts:215` calls, carrying the same body its
 * lines 208-213 compose. Only the child-process launch around it is skipped.
 */

const encoder = new TextEncoder();

export const DIGEST = "a".repeat(64);
export const DECIDED_AT = "2026-08-15T00:00:00.000Z";
export const DECIDED_AT_MS = Date.parse(DECIDED_AT);
/** Wall SECONDS, and the scheduler's overdue rule is `seconds > deadline`. */
export const LIVE_DEADLINE = Math.floor(DECIDED_AT_MS / 1_000) + 3_600;
export const EXPIRED_DEADLINE = Math.floor(DECIDED_AT_MS / 1_000) - 3_600;
export const SESSION_ID = "session-1";
export const OTHER_SESSION_ID = "session-2";
export const NODE_KEY = "dev-done";
export const OPERATOR_ID = "operator-journal";
export const OPERATOR_CREDENTIAL = "journal-operator-credential";
export const WORK_CAPABILITY = "work.write";

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export interface ActivationFixture {
  readonly aggregateId: string;
  readonly record: ActivationLedgerRecord;
  readonly sessionId: string;
}

export interface ActivationOptions {
  readonly deadlineSeconds?: number;
  readonly sessionId?: string;
}

function activationBytes(slug: string, deadline: number, sessionId: string): Uint8Array {
  const lease = {
    authorityHashRef: DIGEST, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT",
    leaseId: `lease-${slug}`, leaseToken: `token-${slug}`, monotonicObservation: 500,
    ownerSessionRef: sessionId, serverWallDeadline: deadline, state: "ACTIVE", version: 7,
  } as const;
  const proof = {
    authorityHashRef: DIGEST, epoch: 3, expectedVersion: 7, leaseToken: `token-${slug}`,
    ownerSessionRef: sessionId,
  } as const;
  const claim = {
    claimId: `claim-${slug}`, claimedAt: DECIDED_AT, intentId: `intent-${slug}`,
    lockIdentity: `lock-${slug}`, wrapperIdentity: `wrapper-${slug}`,
  } as const;
  return encoder.encode(JSON.stringify({
    commandId: `cmd-activate-${slug}`, correlationId: `corr-${slug}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: structuredClone({
      activation: {
        attempt: {
          aggregateId: `agg-${slug}`, attemptId: `attempt-${slug}`, intentId: `intent-${slug}`,
          state: "LAUNCH_REQUESTED", version: 0,
        },
        claim, dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: proof,
        lockIdentity: `lock-${slug}`, observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
        tombstone: null, wrapperIdentity: `wrapper-${slug}`,
      },
      effect: {
        command: { kind: "claim" },
        intent: {
          aggregateId: `agg-${slug}`, desiredState: "ACTIVE", expectedGraphEpoch: 4,
          idempotencyKey: `idem-${slug}`, inputBinding: DIGEST, intentId: `intent-${slug}`,
          leaseBinding: lease, predecessorCursor: `cursor-${slug}`,
          protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DIGEST,
          state: "PENDING", version: 0,
        },
      },
      lease: { proof, record: lease },
      liveClaims: [{ dimension: slug, slotRef: `held-${slug}`, state: "RESERVED" }],
      slot: {
        dimension: slug, requestId: `req-${slug}`, slotRef: `slot-${slug}`,
        rows: [{
          capacityUnits: 1, effectIntentRef: `intent-ref-${slug}`, epoch: 1, external: false,
          fenceable: true, resourceId: `res-${slug}`, state: "ACTIVE",
        }],
      },
    }),
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

/** Commits one activation and its dispatch reservation, then reads BOTH back. */
export function activate(
  store: SqliteEventStore, slug: string, options: ActivationOptions = {},
): ActivationFixture {
  const sessionId = options.sessionId ?? SESSION_ID;
  const deadline = options.deadlineSeconds ?? LIVE_DEADLINE;
  const outcome = runEffectActivateCommand(store, activationBytes(slug, deadline, sessionId));
  if (!outcome.ok) throw new Error(`activation refused: ${outcome.code}`);
  const aggregateId = deriveActivationAggregateId(`agg-${slug}`, `idem-${slug}`);
  const history = readFoundationActivationHistory(
    aggregateId, store.readEvents(aggregateId), PROJECT_ID);
  if (!history.ok) throw new Error(`activation unreadable: ${history.result.status}`);
  const { record } = history.history;
  reserve(store, aggregateId, record, sessionId, slug);
  return Object.freeze({ aggregateId, record, sessionId });
}

export function boundFor(
  aggregateId: string, sessionId: string, slug: string,
): FoundationAttemptBound {
  return Object.freeze({
    aggregateId, claim: {}, commandId: `cmd-dispatch-${slug}`,
    correlationId: `corr-dispatch-${slug}`, nodeKey: NODE_KEY, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, sessionId, target: deriveDispatchAggregateId(aggregateId),
  });
}

/** The exact reservation body `foundation-attempt-service.ts:208-213` commits. */
function reserve(
  store: SqliteEventStore, aggregateId: string, record: ActivationLedgerRecord,
  sessionId: string, slug: string,
): void {
  const encoded = encodeFoundationPayload({
    activationDigest: record.activationDigest, attemptAggregateId: aggregateId,
    attemptId: record.attempt.attemptId, grantId: record.grant.grantId, nodeKey: NODE_KEY,
    recordVersion: FOUNDATION_RESERVATION_VERSION, requestDigest: DIGEST, sessionId,
  });
  if (!encoded.ok) throw new Error(`reservation fixture refused: ${encoded.code}`);
  const written = commitFoundationPhase(
    store, boundFor(aggregateId, sessionId, slug), "RESERVED", encoded.bytes, 0,
    `${record.grant.grantId}:RESERVED`);
  if (written === null || written.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error("reservation fixture was not committed");
  }
}

export type SeamResult = ReturnType<typeof handleCommandRequest>;

export interface JournalHarness {
  readonly attempt: ActivationFixture;
  readonly deps: CommandAdapterDeps;
  /** Opens a session bound to `sessionId` and returns its plaintext credential. */
  openSession: (sessionId: string, capabilities?: readonly string[]) => string;
  readonly root: string;
  send: (
    commandId: string, kind: RuntimeCommandKind, payload: Readonly<Record<string, unknown>>,
    credential: string,
  ) => SeamResult;
  readonly sessionCredential: string;
  readonly store: SqliteEventStore;
}

export interface HarnessOptions extends ActivationOptions {
  readonly capabilities?: readonly string[];
}

/**
 * One store, one seam, one live attempt. The ports and the authenticator are the
 * production ones over the SAME open store the assertions read, so a durable row
 * this suite claims to see is the row the command actually wrote.
 */
export function openJournalHarness(label: string, options: HarnessOptions = {}): JournalHarness {
  const root = mkdtempSync(join(tmpdir(), `moe-journal-${label}-`));
  const store = openHarnessStore(join(root, "project.db"));
  // Genesis FIRST: the initial installer proves the store pristine before it
  // inserts, so a seeded project would make it refuse GENESIS_INSTALL_REFUSED.
  const genesis = ensureGenesisRecoveryBinding(
    store, { clock: () => DECIDED_AT, projectId: PROJECT_ID });
  if (!genesis.ok) throw new Error(`genesis binding refused: ${genesis.code}`);
  seedReadyProject(store);
  const attempt = activate(store, label, options);
  const { decisions, registry } = createDaemonCommandPorts({
    clock: () => DECIDED_AT, operatorPrincipalId: OPERATOR_ID, projectId: PROJECT_ID, store,
  });
  const authenticator = createSessionAuthenticator(store, {
    clock: () => DECIDED_AT_MS, operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorCredential: OPERATOR_CREDENTIAL, operatorPrincipalId: OPERATOR_ID,
    projectId: PROJECT_ID,
  });
  const deps: CommandAdapterDeps = Object.freeze({ authenticator, decisions, registry });
  const send = (
    commandId: string, kind: RuntimeCommandKind, payload: Readonly<Record<string, unknown>>,
    credential: string,
  ): SeamResult => handleCommandRequest(deps, {
    body: encoder.encode(JSON.stringify({
      commandId, commandKind: kind, correlationId: `corr-${commandId}`, expectedVersion: 0,
      payload, requestDigest: DIGEST, schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential, targetAggregateId: "agg-journal",
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  });
  const openSession = (
    sessionId: string, capabilities: readonly string[] = [WORK_CAPABILITY],
  ): string => {
    const secret = `secret-${sessionId}-${label}`;
    const opened = send(`cmd-open-${sessionId}`, "session.open", {
      capabilities: [...capabilities], credentialSha256: sha256Hex(secret),
      expiresAt: "2027-01-01T00:00:00.000Z", sessionId,
    }, OPERATOR_CREDENTIAL);
    if (!opened.ok) throw new Error(`session.open refused: ${JSON.stringify(opened)}`);
    return secret;
  };
  const sessionCredential = openSession(
    attempt.sessionId, options.capabilities ?? [WORK_CAPABILITY]);
  return Object.freeze({
    attempt, deps, openSession, root, send, sessionCredential, store,
  });
}

/** Raw durable rows on the journal aggregate, read OUT of the store: "it did not
 *  throw the second time" is also exactly what a double write looks like. */
export function journalEventCount(store: SqliteEventStore, activationDigest: string): number {
  return store.readEvents(deriveAttemptJournalAggregateId(activationDigest)).length;
}

/**
 * A well-formed durable body, composed here so the READER can be driven without
 * a writer. Every planted case below drifts exactly ONE field of this value, and
 * a positive control asserts the undrifted body reads OK — without that control a
 * "refused" assertion could be caused by the fixture being invalid at an earlier
 * layer rather than by the field under test.
 */
export function journalBody(
  attempt: ActivationFixture, entries: readonly DeadEndJournalEntry[],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const admitted = createDeadEndJournal(entries);
  if (admitted.kind !== "ADMITTED") throw new Error(`body fixture refused: ${admitted.limit}`);
  return {
    activationDigest: attempt.record.activationDigest,
    attemptRef: attempt.record.attempt.attemptId,
    effectId: attempt.record.effectIntent.intentId,
    entries: admitted.journal.entries,
    journalDigest: admitted.journal.digest,
    leaseRef: attempt.record.lease.leaseId,
    nodeKey: NODE_KEY,
    projectId: PROJECT_ID,
    recordVersion: JOURNAL_RECORD_VERSION,
    sessionId: attempt.sessionId,
    truthClass: "DAEMON_VERIFIED",
    ...overrides,
  };
}

/** Writes a row this suite did not compose through the writer, so the reader's
 *  guards are reached by evidence rather than by a stub. */
export function plantJournalEvent(
  store: SqliteEventStore, activationDigest: string, body: unknown, expectedVersion: number,
): void {
  const encoded = encodeFoundationPayload(body);
  if (!encoded.ok) throw new Error(`planted body refused by the codec: ${encoded.code}`);
  const committed = store.commitExpectedVersionDecision({
    commandKind: JOURNAL_APPEND_COMMAND_KIND, committedResultBytes: encoded.bytes,
    correlationId: `corr-plant-${expectedVersion}`, decidedAt: DECIDED_AT,
    events: [{
      eventId: `planted-${activationDigest.slice(0, 8)}-${expectedVersion}`,
      eventType: JOURNAL_APPEND_EVENT_TYPE, payload: encoded.bytes,
    }],
    expectedVersion,
    key: {
      commandId: `cmd-plant-${activationDigest.slice(0, 8)}-${expectedVersion}`,
      principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    },
    requestBytes: encoded.bytes,
    targetAggregateId: deriveAttemptJournalAggregateId(activationDigest),
  });
  if (committed.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`planting refused: ${committed.decision.effectDisposition}`);
  }
}

let nextEntry = 0;

/** A well-formed dead-end entry. `occurredAt` is EXPLICIT per call wherever order
 *  matters, so a suite never asserts an ordering the fixture accidentally fixed. */
export function entry(
  id: string, overrides: Partial<Record<string, unknown>> = {},
): DeadEndJournalEntry {
  nextEntry += 1;
  return {
    actorId: "agent-1", baseDigest: "b".repeat(64), environmentDigest: "c".repeat(64),
    failureCode: "VERIFY_FAILED", id,
    kind: "VERIFICATION_FAILURE",
    occurredAt: `2026-08-15T00:00:0${String(nextEntry % 10)}.000Z`,
    primaryScope: "scope-1", recipeDigest: "d".repeat(64),
    retryPredicate: { expectedVersion: 2, factId: "fact-1", kind: "FACT_VERSION",
      operator: "GREATER_THAN" },
    text: `dead end ${id}`,
    ...overrides,
  } as DeadEndJournalEntry;
}
