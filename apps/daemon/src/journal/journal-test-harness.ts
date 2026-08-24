import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandKind } from "@moe/contracts";
import { createDeadEndJournal } from "@moe/context";
import type { DeadEndJournalEntry } from "@moe/context";
import type { SqliteEventStore } from "@moe/store";

import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import { OPERATOR_CAPABILITIES, createDaemonCommandPorts } from "../daemon-command-registry.js";
import { ensureGenesisRecoveryBinding } from "../identity/genesis-recovery-binding.js";
import { createSessionAuthenticator } from "../identity/session-authenticator.js";
import { handleCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import type { CommandAdapterDeps } from "../http/http-contract.js";
import {
  PRINCIPAL_ID, PROJECT_ID, openHarnessStore, trackHarnessRoot,
} from "../recovery/restore-test-harness.js";
import { deriveDispatchAggregateId, encodeFoundationPayload } from "../work/foundation-attempt-codec.js";
import type { FoundationAttemptBound } from "../work/foundation-attempt-contracts.js";
import {
  JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_EVENT_TYPE, JOURNAL_RECORD_VERSION,
  deriveAttemptJournalAggregateId,
} from "./journal-contracts.js";

/**
 * Test support for the state production can honestly reach while policy cannot
 * authoritatively ALLOW: a real file-backed store with no committed activation.
 * Reader rows may be planted to exercise strict decoding, but no helper below
 * claims that those bytes were reachable through the production writer.
 */

const encoder = new TextEncoder();
const IDENTITY_DOMAIN = "moe.unactivated-journal-identity.v1";

export const DIGEST = "a".repeat(64);
export const DECIDED_AT = "2026-08-15T00:00:00.000Z";
export const DECIDED_AT_MS = Date.parse(DECIDED_AT);
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

export interface ActivationOptions {
  readonly deadlineSeconds?: number;
  readonly sessionId?: string;
}

interface NonAuthoritativeRecordView {
  readonly activationDigest: string;
  readonly attempt: Readonly<{ attemptId: string }>;
  readonly effectIntent: Readonly<{ intentId: string }>;
  readonly lease: Readonly<{ leaseId: string }>;
}

/**
 * Historical name retained so step-lifecycle-test-harness.ts stays byte-identical.
 * This is an identity tuple, NOT an ActivationLedgerRecord and not evidence that
 * any activation exists. The nested view is compatibility plumbing only.
 */
export interface UnactivatedAttemptIdentity {
  readonly activationDigest: string;
  readonly aggregateId: string;
  readonly attemptRef: string;
  readonly effectIntentRef: string;
  readonly sessionId: string;
}

export interface ActivationFixture extends UnactivatedAttemptIdentity {
  readonly record: NonAuthoritativeRecordView;
}

function identityFor(slug: string, options: ActivationOptions = {}): UnactivatedAttemptIdentity {
  const sessionId = options.sessionId ?? SESSION_ID;
  const aggregateId = deriveActivationAggregateId(`agg-${slug}`, `idem-${slug}`);
  const activationDigest = sha256Hex(`${IDENTITY_DOMAIN}\n${aggregateId}\n${sessionId}`);
  const attemptRef = `attempt-${slug}`;
  const effectIntentRef = `intent-${slug}`;
  return Object.freeze({ activationDigest, aggregateId, attemptRef, effectIntentRef, sessionId });
}

function compatibilityAttempt(
  identity: UnactivatedAttemptIdentity, slug: string,
): ActivationFixture {
  const record = Object.freeze({
    activationDigest: identity.activationDigest,
    attempt: Object.freeze({ attemptId: identity.attemptRef }),
    effectIntent: Object.freeze({ intentId: identity.effectIntentRef }),
    lease: Object.freeze({ leaseId: `lease-${slug}` }),
  });
  return Object.freeze({ ...identity, record });
}

/** Compatibility export only: it writes nothing and grants no authority. */
export function activate(
  store: SqliteEventStore, slug: string, options: ActivationOptions = {},
): ActivationFixture {
  void store;
  return compatibilityAttempt(identityFor(slug, options), slug);
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

export interface UnactivatedJournalFixture {
  readonly attempt: ActivationFixture;
  readonly identity: UnactivatedAttemptIdentity;
  readonly root: string;
  readonly store: SqliteEventStore;
}

const safeLabel = (label: string): string => label.replace(/[^\w.-]/gu, "_");

/** A globally empty file-backed store plus identity inputs that grant no authority. */
export function openUnactivatedJournalFixture(
  label: string, options: ActivationOptions = {},
): UnactivatedJournalFixture {
  const root = trackHarnessRoot(
    mkdtempSync(join(tmpdir(), `moe-journal-${safeLabel(label)}-`)));
  const store = openHarnessStore(join(root, "project.db"));
  const identity = identityFor(label, options);
  return Object.freeze({
    attempt: compatibilityAttempt(identity, label), identity, root, store,
  });
}

export type SeamResult = ReturnType<typeof handleCommandRequest>;

export interface JournalHarness extends UnactivatedJournalFixture {
  readonly deps: CommandAdapterDeps;
  openSession: (sessionId: string, capabilities?: readonly string[]) => string;
  send: (
    commandId: string, kind: RuntimeCommandKind, payload: Readonly<Record<string, unknown>>,
    credential: string,
  ) => SeamResult;
  readonly sessionCredential: string;
}

export interface HarnessOptions extends ActivationOptions {
  readonly capabilities?: readonly string[];
}

/** Authenticated production seam over genesis + session.open evidence only. */
export function openJournalHarness(label: string, options: HarnessOptions = {}): JournalHarness {
  const bare = openUnactivatedJournalFixture(label, options);
  const { attempt, identity, root, store } = bare;
  const genesis = ensureGenesisRecoveryBinding(
    store, { clock: () => DECIDED_AT, projectId: PROJECT_ID });
  if (!genesis.ok) throw new Error(`genesis binding refused: ${genesis.code}`);
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
    attempt, deps, identity, openSession, root, send, sessionCredential, store,
  });
}

export function journalEventCount(store: SqliteEventStore, activationDigest: string): number {
  return store.readEvents(deriveAttemptJournalAggregateId(activationDigest)).length;
}

/** Canonical planted body for strict-reader tests; never writer-reachability evidence. */
export function journalBody(
  attempt: UnactivatedAttemptIdentity, entries: readonly DeadEndJournalEntry[],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const admitted = createDeadEndJournal(entries);
  if (admitted.kind !== "ADMITTED") throw new Error(`body fixture refused: ${admitted.limit}`);
  return {
    activationDigest: attempt.activationDigest,
    attemptRef: attempt.attemptRef,
    effectId: attempt.effectIntentRef,
    entries: admitted.journal.entries,
    journalDigest: admitted.journal.digest,
    leaseRef: `lease-${attempt.attemptRef}`,
    nodeKey: NODE_KEY,
    projectId: PROJECT_ID,
    recordVersion: JOURNAL_RECORD_VERSION,
    sessionId: attempt.sessionId,
    truthClass: "DAEMON_VERIFIED",
    ...overrides,
  };
}

/** Plant bytes solely to reach reader guards that no honest writer emits. */
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

export function entry(
  id: string, overrides: Partial<Record<string, unknown>> = {},
): DeadEndJournalEntry {
  nextEntry += 1;
  return {
    actorId: "agent-1", baseDigest: "b".repeat(64), environmentDigest: "c".repeat(64),
    failureCode: "VERIFY_FAILED", id, kind: "VERIFICATION_FAILURE",
    occurredAt: `2026-08-15T00:00:0${String(nextEntry % 10)}.000Z`,
    primaryScope: "scope-1", recipeDigest: "d".repeat(64),
    retryPredicate: {
      expectedVersion: 2, factId: "fact-1", kind: "FACT_VERSION", operator: "GREATER_THAN",
    },
    text: `dead end ${id}`,
    ...overrides,
  } as DeadEndJournalEntry;
}
