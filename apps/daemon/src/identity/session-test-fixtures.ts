import { RECOVERY_BINDING_CODEC_VERSION, SqliteEventStore } from "@moe/store";

import { credentialSha256Of } from "./session-authenticator.js";
import { SESSION_SCHEMA_VERSION, decodeSessionRequestBytes } from "./session-contracts.js";
import { aggregateIdFor, commitAccepted } from "./session-ledger.js";
import { runSessionCommand } from "./session-services.js";
import type { SessionOutcome } from "./session-ledger.js";

/**
 * Request fixtures for the session-lifecycle suites.
 *
 * Every helper builds INPUT or reads the store back; none restates a rule. `send` drives the
 * production `runSessionCommand` and `hashOf` is the production hashing function, so an
 * assertion written against these helpers is an assertion about shipped code.
 *
 * This module is test-tier scaffolding: it is reached only from `*.test.ts`, never from a
 * published unit, so it deliberately has no `.js` runtime bridge.
 */

export const PROJECT_ID = "project-session-1";
export const OPENER = "principal-opener-1";
export const SESSION_ID = "session-alpha";
export const CREDENTIAL = "client-generated-bearer-credential-alpha";
export const EXPIRES_AT = "2026-08-09T12:00:00.000Z";
export const EXPIRES_AT_MS = Date.parse(EXPIRES_AT);
export const CAPABILITIES = ["work.claim", "review.submit"] as const;
export const TEST_RECOVERY_INCARNATION_REF = "71".repeat(32);
export const TEST_RECOVERY_KEY_EPOCH_REF = "72".repeat(32);

export const hashOf = credentialSha256Of;

const encoder = new TextEncoder();
const openStores: SqliteEventStore[] = [];

export function openUnboundStore(): SqliteEventStore {
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  openStores.push(store);
  return store;
}

export function openStore(): SqliteEventStore {
  const store = openUnboundStore();
  installTestRecoveryBinding(store);
  return store;
}

export function installTestRecoveryBinding(store: SqliteEventStore): void {
  const installed = store.installRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef: TEST_RECOVERY_INCARNATION_REF,
    installedAt: "2026-08-12T00:00:00.000Z",
    keyEpochRef: TEST_RECOVERY_KEY_EPOCH_REF,
    payload: new TextEncoder().encode("session-test-recovery-binding"),
    slot: "ACTIVE",
  });
  if (!installed.ok) throw new Error(`test recovery install failed: ${installed.code}`);
}

export function closeStores(): void {
  while (openStores.length > 0) {
    try {
      openStores.pop()?.close();
    } catch {
      // Cleanup must not mask a test failure.
    }
  }
}

export interface Envelope {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly expectedVersion: number;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly principalId: string;
  readonly projectId: string;
  readonly schemaVersion: string;
}

export function envelope(
  kind: string,
  expectedVersion: number,
  payload: Record<string, unknown>,
  commandId = `cmd-${kind}-${expectedVersion}`,
  overrides: Partial<Envelope> = {},
): Envelope {
  return {
    commandId,
    correlationId: "corr-session-1",
    decidedAt: "2026-08-09T00:00:00.000Z",
    expectedVersion,
    kind,
    payload,
    principalId: OPENER,
    projectId: PROJECT_ID,
    schemaVersion: SESSION_SCHEMA_VERSION,
    ...overrides,
  };
}

export function send(
  store: SqliteEventStore, request: Envelope, reservedPrincipalId?: string,
): SessionOutcome {
  return runSessionCommand(
    store, encoder.encode(JSON.stringify(request)), undefined, reservedPrincipalId,
  );
}

export function openPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilities: [...CAPABILITIES],
    credentialSha256: hashOf(CREDENTIAL),
    expiresAt: EXPIRES_AT,
    sessionId: SESSION_ID,
    ...overrides,
  };
}

/** Opens the default session, throwing on refusal so setup gaps cannot pass silently. */
export function openDefaultSession(
  store: SqliteEventStore,
  overrides: Record<string, unknown> = {},
  commandId = "cmd-open-default",
): SessionOutcome {
  const outcome = send(store, envelope("session.open", 0, openPayload(overrides), commandId));
  if (!outcome.ok) throw new Error(`session.open setup failed: ${outcome.code}`);
  return outcome;
}

/**
 * Commits an arbitrary result through the PRODUCTION seam, bypassing the handlers.
 *
 * No handler will ever write a corrupt session record, so the only honest way to prove the fold
 * fails closed is to put the bytes there directly and then drive real code against them. It
 * decodes through the production ingress first, so it cannot smuggle in an envelope the daemon
 * would have refused.
 */
export function commitRaw(
  store: SqliteEventStore,
  request: Envelope,
  result: unknown,
  aggregateSessionId: string,
  expectedVersion = 0,
  eventType = "SessionOpened",
): SessionOutcome {
  const decoded = decodeSessionRequestBytes(encoder.encode(JSON.stringify(request)));
  if (!decoded.ok) throw new Error(`fixture envelope refused: ${decoded.code}`);
  return commitAccepted(store, decoded.request, {
    aggregateId: aggregateIdFor(aggregateSessionId),
    eventPayload: { staged: true },
    eventType,
    expectedVersion,
    result: result as never,
  });
}
