import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COORDINATION_ROLES, coordinationCapability, createCoordinationService, createDurableMailbox,
} from "@moe/coordination";
import type { CoordinationAddress, CoordinationRole } from "@moe/coordination";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  SESSION_PROOF_ALGORITHM, SESSION_PROOF_PROTOCOL_VERSION,
} from "../identity/session-authority-contracts.js";
import type { SessionAuthorityService } from "../identity/session-authority-contracts.js";
import {
  canonicalSessionProofBytes, sessionAuthorityRequestDigest, sessionClientKeyId,
} from "../identity/session-authority-protocol.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import { createRecipientRegistry, recipientAggregateId } from "./recipient-registry.js";
import type { RecipientRegistryService } from "./recipient-registry.js";

const PROJECT_ID = "project-recipient-registry";
const FOREIGN_PROJECT_ID = "project-recipient-foreign";
const PRINCIPAL_ID = "agent-recipient-registry";
const PROFILE_REVISION_ID = "profile-recipient-v1";
const TRANSPORT_ID = "coordination.v1";
const TRANSPORT_IDS = Object.freeze([TRANSPORT_ID]);
const NOW = Date.parse("2026-08-10T12:00:00.000Z");
const NOT_KNOWN = { known: false, role: null };

const directories: string[] = [];
const stores: SqliteEventStore[] = [];

interface Harness {
  readonly path: string;
  now: number;
  store: SqliteEventStore;
  sessions: SessionAuthorityService;
  registry: RecipientRegistryService;
  readonly reopen: () => void;
  readonly registryFor: (projectId: string) => RecipientRegistryService;
}

function harness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), "moe-recipient-registry-"));
  directories.push(directory);
  const path = join(directory, "store.sqlite");
  const opened = SqliteEventStore.openForProject(path, PROJECT_ID);
  stores.push(opened);
  const state: Harness = {
    path,
    now: NOW,
    store: opened,
    sessions: createSessionAuthority(opened, { projectId: PROJECT_ID, clock: () => state.now }),
    registry: undefined as unknown as RecipientRegistryService,
    registryFor: (projectId: string): RecipientRegistryService =>
      createRecipientRegistry({
        clock: () => state.now, projectId, sessions: state.sessions, store: state.store,
      }),
    reopen: (): void => {
      state.store.close();
      const next = SqliteEventStore.openForProject(path, PROJECT_ID);
      stores.push(next);
      state.store = next;
      state.sessions = createSessionAuthority(next, { projectId: PROJECT_ID, clock: () => state.now });
      state.registry = state.registryFor(PROJECT_ID);
    },
  };
  state.registry = state.registryFor(PROJECT_ID);
  return state;
}

afterEach(() => {
  while (stores.length > 0) {
    try {
      stores.pop()?.close();
    } catch {
      // A recreation test may already have closed the handle.
    }
  }
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { force: true, recursive: true });
  }
});

interface ClientKey {
  readonly privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  readonly publicKeySpkiHex: string;
  readonly clientKeyId: string;
}

function clientKey(): ClientKey {
  const pair = generateKeyPairSync("ed25519");
  const publicKeySpkiHex = pair.publicKey.export({ format: "der", type: "spki" }).toString("hex");
  const clientKeyId = sessionClientKeyId(publicKeySpkiHex);
  if (clientKeyId === null) throw new Error("production rejected Node's canonical Ed25519 SPKI");
  return Object.freeze({ privateKey: pair.privateKey, publicKeySpkiHex, clientKeyId });
}

function proofOf(challenge: Uint8Array, key: ClientKey, issuedAt: number, nonce: string) {
  return Object.freeze({
    protocolVersion: SESSION_PROOF_PROTOCOL_VERSION,
    algorithm: SESSION_PROOF_ALGORITHM,
    issuedAt,
    nonce,
    signatureHex: sign(null, challenge, key.privateKey).toString("hex"),
  });
}

interface OpenedSession {
  readonly sessionId: string;
  readonly key: ClientKey;
  readonly credentialId: string;
  readonly expiresAt: number;
  readonly generation: number;
}

function createPrincipalIn(sessions: SessionAuthorityService): void {
  const result = sessions.createPrincipal({
    commandId: "command-create-principal",
    correlationId: "correlation-create-principal",
    principalId: PRINCIPAL_ID,
    kind: "AGENT" as const,
    profileRevisionId: PROFILE_REVISION_ID,
  });
  if (!result.ok) throw new Error(`principal setup failed: ${result.code}`);
}

function createPrincipal(state: Harness): void {
  createPrincipalIn(state.sessions);
}

function openSessionIn(
  sessions: SessionAuthorityService, projectId: string, sessionId: string, suffix: string,
  at: number, key = clientKey(),
): OpenedSession {
  const credentialId = `credential-${suffix}`;
  const commandId = `command-open-${suffix}`;
  const requestDigest = sessionAuthorityRequestDigest({
    kind: "OPEN_SESSION", projectId, principalId: PRINCIPAL_ID,
    profileRevisionId: PROFILE_REVISION_ID, sessionId, credentialId, generation: 1,
    clientKeyId: key.clientKeyId, publicKeySpkiHex: key.publicKeySpkiHex,
    transportId: TRANSPORT_ID, transportIds: TRANSPORT_IDS,
  });
  const challenge = canonicalSessionProofBytes({
    principalId: PRINCIPAL_ID, projectId, sessionId, credentialId, generation: 1,
    clientKeyId: key.clientKeyId, transportId: TRANSPORT_ID, requestId: commandId,
    requestDigest, issuedAt: at, nonce: "12".repeat(16),
  });
  const opened = sessions.openSession({
    commandId, correlationId: `correlation-open-${suffix}`, principalId: PRINCIPAL_ID,
    sessionId, credentialId, clientKeyId: key.clientKeyId,
    publicKeySpkiHex: key.publicKeySpkiHex, transportId: TRANSPORT_ID,
    transportIds: TRANSPORT_IDS, requestDigest,
    proof: proofOf(challenge, key, at, "12".repeat(16)),
  });
  if (!opened.ok) throw new Error(`session setup failed: ${opened.code}`);
  return Object.freeze({
    sessionId, key, credentialId,
    expiresAt: opened.authority.session.expiresAt,
    generation: opened.authority.session.generation,
  });
}

function openSession(state: Harness, suffix: string, key = clientKey()): OpenedSession {
  return openSessionIn(state.sessions, PROJECT_ID, `session-${suffix}`, suffix, state.now, key);
}

/**
 * A SECOND project, in its own database, holding a session of the SAME id opened through the
 * production writer. It exists so the registry's own record-level project scoping can be
 * isolated: a registry pointed at this authority accepts the session, so only the recorded
 * projectId can refuse.
 */
function foreignSessions(state: Harness, sessionId: string): SessionAuthorityService {
  const directory = mkdtempSync(join(tmpdir(), "moe-recipient-foreign-"));
  directories.push(directory);
  const store = SqliteEventStore.openForProject(join(directory, "store.sqlite"), FOREIGN_PROJECT_ID);
  stores.push(store);
  const sessions = createSessionAuthority(store, {
    projectId: FOREIGN_PROJECT_ID, clock: () => state.now,
  });
  createPrincipalIn(sessions);
  openSessionIn(sessions, FOREIGN_PROJECT_ID, sessionId, "foreign-twin", state.now);
  return sessions;
}

function authentication(
  session: OpenedSession, requestDigest: string, requestId: string, nonce: string,
) {
  const challenge = canonicalSessionProofBytes({
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID, sessionId: session.sessionId,
    credentialId: session.credentialId, generation: session.generation,
    clientKeyId: session.key.clientKeyId, transportId: TRANSPORT_ID, requestId, requestDigest,
    issuedAt: NOW, nonce,
  });
  return Object.freeze({
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID, sessionId: session.sessionId,
    credentialId: session.credentialId, generation: session.generation,
    clientKeyId: session.key.clientKeyId, transportId: TRANSPORT_ID, requestId, requestDigest,
    proof: proofOf(challenge, session.key, NOW, nonce),
  });
}

function closeSession(state: Harness, session: OpenedSession, nonce: string): void {
  const commandId = `command-close-${session.sessionId}`;
  const requestDigest = sessionAuthorityRequestDigest({
    kind: "CLOSE_SESSION", projectId: PROJECT_ID, principalId: PRINCIPAL_ID,
    sessionId: session.sessionId, credentialId: session.credentialId,
    generation: session.generation, clientKeyId: session.key.clientKeyId,
  });
  const closed = state.sessions.closeSession({
    commandId, correlationId: `correlation-${commandId}`,
    authentication: authentication(session, requestDigest, commandId, nonce),
  });
  if (!closed.ok) throw new Error(`close setup failed: ${closed.code}`);
}

function rotateSession(state: Harness, session: OpenedSession, nonce: string): void {
  const commandId = `command-rotate-${session.sessionId}`;
  const next = clientKey();
  const nextCredentialId = `${session.credentialId}-next`;
  const requestDigest = sessionAuthorityRequestDigest({
    kind: "ROTATE_CREDENTIAL", projectId: PROJECT_ID, principalId: PRINCIPAL_ID,
    sessionId: session.sessionId, credentialId: session.credentialId,
    generation: session.generation, clientKeyId: session.key.clientKeyId,
    nextCredentialId, nextGeneration: session.generation + 1,
    nextClientKeyId: next.clientKeyId, nextPublicKeySpkiHex: next.publicKeySpkiHex,
  });
  const presented = authentication(session, requestDigest, commandId, nonce);
  const challenge = canonicalSessionProofBytes({
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID, sessionId: session.sessionId,
    credentialId: session.credentialId, generation: session.generation,
    clientKeyId: session.key.clientKeyId, transportId: TRANSPORT_ID, requestId: commandId,
    requestDigest, issuedAt: NOW, nonce,
  });
  const rotated = state.sessions.rotateCredential({
    commandId, correlationId: `correlation-${commandId}`, authentication: presented,
    nextCredentialId, nextClientKeyId: next.clientKeyId,
    nextPublicKeySpkiHex: next.publicKeySpkiHex,
    nextSignatureHex: sign(null, challenge, next.privateKey).toString("hex"),
  });
  if (!rotated.ok) throw new Error(`rotation setup failed: ${rotated.code}`);
}

function addressOf(session: OpenedSession, role: CoordinationRole): CoordinationAddress {
  return Object.freeze({ effectId: null, role, sessionId: session.sessionId });
}

function command(recipient: CoordinationAddress, suffix: string) {
  const slug = suffix.replaceAll(" ", "-");
  return {
    commandId: `command-recipient-${slug}`,
    correlationId: `correlation-recipient-${slug}`,
    recipient,
  };
}

function eventCount(store: SqliteEventStore): number {
  let cursor = 0n;
  let count = 0;
  for (;;) {
    const page = store.readEventsAfter(cursor, 100);
    count += page.items.length;
    if (!page.hasMore || page.nextCursor === null) return count;
    cursor = page.nextCursor;
  }
}

/** Every persisted decision digest, so "unchanged durable state" is a byte claim. */
function decisionDigests(store: SqliteEventStore): string {
  const values: string[] = [];
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, 100);
    for (const decision of page.items) {
      values.push(decision.key.commandId, decision.requestSha256, decision.resultSha256);
    }
    if (!page.hasMore || page.nextCursor === null) return values.join("|");
    cursor = page.nextCursor;
  }
}

/**
 * Drives the REAL consumer. `coordination-ports.isKnownRecipient` is not exported from
 * `@moe/coordination`, so re-checking frozenness and key exactness in the test would only
 * restate the rule. Reading a mailbox through the shipped service asserts the answer against
 * the gate that actually decides, and it adds no authority here: the service already exists.
 */
function consumerRead(state: Harness, address: CoordinationAddress) {
  const service = createCoordinationService({
    authenticate: () => Object.freeze({
      capabilities: Object.freeze([coordinationCapability("READ", address.sessionId)]),
      ok: true as const, principalId: PRINCIPAL_ID, sessionId: address.sessionId,
    }),
    mailbox: createDurableMailbox(state.store),
    now: () => state.now,
    resolveEffectBinding: () => undefined,
    resolveRecipient: state.registry.resolveRecipient,
  });
  return service.read({ mailbox: address, presentation: {}, transportId: TRANSPORT_ID });
}

describe("durable coordination recipient registration", () => {
  it("registers an active session and answers the shipped consumer's acceptance gate", () => {
    const state = harness();
    createPrincipal(state);
    const session = openSession(state, "register");
    const address = addressOf(session, "CODER");

    const unknownBefore = consumerRead(state, address);
    const registered = state.registry.register(command(address, "register"));
    expect(registered).toMatchObject({ outcome: "ACCEPTED", recipient: address, version: 1 });
    if (registered.outcome === "REFUSED") throw new Error("expected registration to succeed");

    const decision = state.store.getCommandDecision({
      commandId: registered.receipt.commandId,
      principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
    });
    expect(decision).not.toBeNull();
    expect(registered.receipt).toMatchObject({
      aggregateId: recipientAggregateId(session.sessionId),
      previousVersion: 0,
      currentVersion: 1,
      requestSha256: decision?.requestSha256,
      resultSha256: decision?.resultSha256,
    });
    expect(state.store.readEvents(recipientAggregateId(session.sessionId))).toHaveLength(1);

    const answer = state.registry.resolveRecipient(address);
    expect(answer).toEqual({ known: true, role: "CODER" });
    expect(Object.isFrozen(answer)).toBe(true);
    expect(unknownBefore).toMatchObject({
      outcome: "REFUSED", code: "COORDINATION_RECIPIENT_UNKNOWN", layer: "ADDRESS",
    });
    expect(consumerRead(state, address)).toMatchObject({ outcome: "PAGE" });
  });

  it("replays an identical register with no second event and byte-identical receipts", () => {
    const state = harness();
    createPrincipal(state);
    const session = openSession(state, "replay");
    const address = addressOf(session, "REVIEWER");
    const request = command(address, "replay");

    const first = state.registry.register(request);
    const events = eventCount(state.store);
    const digests = decisionDigests(state.store);
    const replay = state.registry.register(request);

    expect(first).toMatchObject({ outcome: "ACCEPTED" });
    expect(replay).toMatchObject({ outcome: "DEDUPLICATED" });
    if (first.outcome === "REFUSED" || replay.outcome === "REFUSED") {
      throw new Error("expected the replay to be accepted as a duplicate");
    }
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.version).toBe(first.version);
    expect(eventCount(state.store)).toBe(events);
    expect(decisionDigests(state.store)).toBe(digests);
    expect(state.store.readEvents(recipientAggregateId(session.sessionId))).toHaveLength(1);
  });

  it("replaces the recorded role at the next version and revokes back to unknown", () => {
    const state = harness();
    createPrincipal(state);
    const session = openSession(state, "lifecycle");
    const coder = addressOf(session, "CODER");
    const reviewer = addressOf(session, "REVIEWER");

    expect(state.registry.register(command(coder, "life-1"))).toMatchObject({ version: 1 });
    const replaced = state.registry.replace(command(reviewer, "life-2"));
    expect(replaced).toMatchObject({ outcome: "ACCEPTED", recipient: reviewer, version: 2 });
    expect(state.registry.resolveRecipient(reviewer)).toEqual({ known: true, role: "REVIEWER" });
    expect(state.registry.resolveRecipient(coder)).toEqual(NOT_KNOWN);

    const revoked = state.registry.revoke(command(reviewer, "life-3"));
    expect(revoked).toMatchObject({ outcome: "ACCEPTED", version: 3 });
    expect(state.registry.resolveRecipient(reviewer)).toEqual(NOT_KNOWN);
    expect(consumerRead(state, reviewer)).toMatchObject({
      outcome: "REFUSED", code: "COORDINATION_RECIPIENT_UNKNOWN", layer: "ADDRESS",
    });
    expect(state.store.readEvents(recipientAggregateId(session.sessionId))).toHaveLength(3);
  });

  it("registers and resolves every role in the closed vocabulary", () => {
    const state = harness();
    createPrincipal(state);
    const cases = COORDINATION_ROLES.map((role, index) => ({
      role, session: openSession(state, `role-${index}`),
    }));
    expect(cases.length).toBeGreaterThan(0);
    expect(cases).toHaveLength(COORDINATION_ROLES.length);

    for (const entry of cases) {
      const address = addressOf(entry.session, entry.role);
      expect(state.registry.register(command(address, entry.role)), entry.role)
        .toMatchObject({ outcome: "ACCEPTED" });
      expect(state.registry.resolveRecipient(address), entry.role)
        .toEqual({ known: true, role: entry.role });
    }
  });
});

describe("recipient writer refusals", () => {
  it("refuses absent, closed, and expired sessions at AUTHENTICATION and writes nothing", () => {
    const state = harness();
    createPrincipal(state);
    const expired = openSession(state, "expired");
    const closed = openSession(state, "closed");
    closeSession(state, closed, "31".repeat(16));
    state.now = expired.expiresAt;

    // Rotation is deliberately absent here: a rotated session is still ACTIVE, so registering
    // it is correct and records the NEW generation. Rotation only invalidates an OLDER row,
    // which is a resolver property and is proved there.
    const rows = [
      { name: "absent", address: { effectId: null, role: "CODER" as const, sessionId: "session-never" } },
      { name: "closed", address: addressOf(closed, "CODER") },
      { name: "expired", address: addressOf(expired, "CODER") },
    ];
    expect(rows.length).toBeGreaterThan(0);
    const events = eventCount(state.store);
    const digests = decisionDigests(state.store);

    for (const row of rows) {
      for (const write of [state.registry.register, state.registry.replace, state.registry.revoke]) {
        expect(write(command(row.address, `refuse-${row.name}`)), row.name).toEqual({
          code: "COORDINATION_AUTHENTICATION_FAILED",
          detail: expect.any(String),
          layer: "AUTHENTICATION",
          outcome: "REFUSED",
        });
      }
    }
    expect(eventCount(state.store)).toBe(events);
    expect(decisionDigests(state.store)).toBe(digests);
  });

  it("refuses a session owned by another project at AUTHENTICATION", () => {
    const state = harness();
    createPrincipal(state);
    const session = openSession(state, "foreign-writer");
    const foreign = state.registryFor(FOREIGN_PROJECT_ID);
    const events = eventCount(state.store);
    const digests = decisionDigests(state.store);

    expect(foreign.register(command(addressOf(session, "TERMINAL"), "foreign"))).toEqual({
      code: "COORDINATION_AUTHENTICATION_FAILED",
      detail: expect.any(String),
      layer: "AUTHENTICATION",
      outcome: "REFUSED",
    });
    expect(eventCount(state.store)).toBe(events);
    expect(decisionDigests(state.store)).toBe(digests);
  });

  it("refuses every malformed role and address at ADDRESS and every bad envelope at DECODE", () => {
    const state = harness();
    createPrincipal(state);
    const session = openSession(state, "grammar");
    const valid = addressOf(session, "CODER");
    const addressCases: readonly { readonly name: string; readonly recipient: unknown }[] = [
      { name: "lowercase role", recipient: { ...valid, role: "coder" } },
      { name: "role outside vocabulary", recipient: { ...valid, role: "ADMIN" } },
      { name: "numeric role", recipient: { ...valid, role: 42 } },
      { name: "empty session id", recipient: { ...valid, sessionId: "" } },
      { name: "spaced session id", recipient: { ...valid, sessionId: "session with space" } },
      { name: "numeric session id", recipient: { ...valid, sessionId: 7 } },
      { name: "numeric effect id", recipient: { ...valid, effectId: 5 } },
      { name: "empty effect id", recipient: { ...valid, effectId: "" } },
      { name: "missing effect id", recipient: { role: "CODER", sessionId: session.sessionId } },
      { name: "extra key", recipient: { ...valid, extra: true } },
      { name: "null address", recipient: null },
      { name: "array address", recipient: [valid] },
    ];
    const envelopeCases: readonly { readonly name: string; readonly input: unknown }[] = [
      { name: "missing commandId", input: { correlationId: "c", recipient: valid } },
      { name: "numeric commandId", input: { commandId: 1, correlationId: "c", recipient: valid } },
      { name: "extra envelope key", input: { ...command(valid, "x"), extra: true } },
      { name: "null envelope", input: null },
    ];
    expect(addressCases.length).toBeGreaterThan(0);
    expect(envelopeCases.length).toBeGreaterThan(0);
    const events = eventCount(state.store);
    const digests = decisionDigests(state.store);

    for (const entry of addressCases) {
      const input = { ...command(valid, entry.name), recipient: entry.recipient };
      for (const write of [state.registry.register, state.registry.replace, state.registry.revoke]) {
        expect(write(input), entry.name).toEqual({
          code: "COORDINATION_INPUT_INVALID",
          detail: expect.any(String),
          layer: "ADDRESS",
          outcome: "REFUSED",
        });
      }
    }
    for (const entry of envelopeCases) {
      expect(state.registry.register(entry.input), entry.name).toEqual({
        code: "COORDINATION_INPUT_INVALID",
        detail: expect.any(String),
        layer: "DECODE",
        outcome: "REFUSED",
      });
    }
    expect(eventCount(state.store)).toBe(events);
    expect(decisionDigests(state.store)).toBe(digests);
  });

  it("refuses replace and revoke on an unregistered session and a second register at STORE", () => {
    const state = harness();
    createPrincipal(state);
    const session = openSession(state, "preconditions");
    const address = addressOf(session, "CONTROL_ROOM");
    const events = eventCount(state.store);

    for (const write of [state.registry.replace, state.registry.revoke]) {
      expect(write(command(address, "missing"))).toEqual({
        code: "COORDINATION_RECIPIENT_UNKNOWN",
        detail: expect.any(String),
        layer: "ADDRESS",
        outcome: "REFUSED",
      });
    }
    expect(eventCount(state.store)).toBe(events);

    expect(state.registry.register(command(address, "first"))).toMatchObject({ version: 1 });
    const after = eventCount(state.store);
    const digests = decisionDigests(state.store);
    expect(state.registry.register(command(address, "second"))).toEqual({
      code: "COORDINATION_IDEMPOTENCY_CONFLICT",
      detail: expect.any(String),
      layer: "STORE",
      outcome: "REFUSED",
    });
    expect(eventCount(state.store)).toBe(after);
    expect(decisionDigests(state.store)).toBe(digests);
  });
});

describe("frozen recipient resolver", () => {
  it("keeps a rotated session unknown while the same session still authenticates", () => {
    const state = harness();
    createPrincipal(state);
    const session = openSession(state, "rotation");
    const address = addressOf(session, "CODER");
    state.registry.register(command(address, "rotation"));
    expect(state.registry.resolveRecipient(address)).toEqual({ known: true, role: "CODER" });

    rotateSession(state, session, "41".repeat(16));
    expect(state.sessions.readActiveSession(session.sessionId)).toMatchObject({ status: "FOUND" });
    expect(state.registry.resolveRecipient(address)).toEqual(NOT_KNOWN);
  });

  it("treats expiry exclusively, matching the session authority to the millisecond", () => {
    const state = harness();
    createPrincipal(state);
    const session = openSession(state, "expiry");
    const address = addressOf(session, "TERMINAL");
    state.registry.register(command(address, "expiry"));

    state.now = session.expiresAt - 1;
    expect(state.registry.resolveRecipient(address)).toEqual({ known: true, role: "TERMINAL" });
    state.now = session.expiresAt;
    expect(state.registry.resolveRecipient(address)).toEqual(NOT_KNOWN);
  });

  it("keeps a session owned by another project unknown to a differently scoped registry", () => {
    const state = harness();
    createPrincipal(state);
    const session = openSession(state, "foreign-session");
    const address = addressOf(session, "CODER");
    state.registry.register(command(address, "foreign-session"));

    // This case is answered by the registry's session-project gate: the record exists and the
    // authority holds the session, but it belongs to a project this registry does not serve.
    const foreign = state.registryFor(FOREIGN_PROJECT_ID);
    expect(state.sessions.readActiveSession(session.sessionId)).toMatchObject({ status: "FOUND" });
    expect(foreign.resolveRecipient(address)).toEqual(NOT_KNOWN);
    expect(state.registry.resolveRecipient(address)).toEqual({ known: true, role: "CODER" });
  });

  it("keeps a record written for another project unknown even when the session is accepted", () => {
    const state = harness();
    createPrincipal(state);
    const session = openSession(state, "foreign-record");
    const address = addressOf(session, "CODER");
    state.registry.register(command(address, "foreign-record"));

    // A registry serving the FOREIGN project, reading this project's ledger, asking an
    // authority that DOES hold this session id under the foreign project. Every other gate
    // passes, so only the recorded projectId can refuse.
    const twin = foreignSessions(state, session.sessionId);
    const crossed = createRecipientRegistry({
      clock: () => state.now, projectId: FOREIGN_PROJECT_ID, sessions: twin, store: state.store,
    });
    expect(twin.readActiveSession(session.sessionId)).toMatchObject({
      status: "FOUND", authority: { projectId: FOREIGN_PROJECT_ID },
    });
    expect(crossed.resolveRecipient(address)).toEqual(NOT_KNOWN);
    expect(state.registry.resolveRecipient(address)).toEqual({ known: true, role: "CODER" });
  });

  it("refuses a role or effect the record never carried", () => {
    const state = harness();
    createPrincipal(state);
    const session = openSession(state, "mismatch");
    state.registry.register(command(addressOf(session, "CODER"), "mismatch"));
    const mismatches: readonly CoordinationAddress[] = [
      { effectId: null, role: "REVIEWER", sessionId: session.sessionId },
      { effectId: "effect-one", role: "CODER", sessionId: session.sessionId },
    ];
    expect(mismatches.length).toBeGreaterThan(0);
    for (const address of mismatches) {
      expect(state.registry.resolveRecipient(address), address.role).toEqual(NOT_KNOWN);
    }
  });

  it("separates a look that found nothing from a look it could not make", () => {
    const state = harness();
    createPrincipal(state);
    const session = openSession(state, "negative");
    const looked = state.registry.resolveRecipient(addressOf(session, "CODER"));
    const neverLooked = state.registry.resolveRecipient({
      effectId: null, role: "MAYOR", sessionId: session.sessionId,
    } as unknown as CoordinationAddress);

    expect(looked).toEqual(NOT_KNOWN);
    expect(Object.isFrozen(looked)).toBe(true);
    expect(neverLooked).toBeUndefined();
    expect(neverLooked).not.toEqual(looked);
  });
});

describe("recipient durability across a real database recreation", () => {
  it("reconstructs identical facts, receipts, and revocations from the same file", () => {
    const state = harness();
    createPrincipal(state);
    const kept = openSession(state, "kept");
    const gone = openSession(state, "gone");
    const keptAddress = addressOf(kept, "CODER");
    const goneAddress = addressOf(gone, "REVIEWER");

    const registered = state.registry.register(command(keptAddress, "kept"));
    state.registry.register(command(goneAddress, "gone"));
    state.registry.revoke(command(goneAddress, "gone-revoked"));
    if (registered.outcome === "REFUSED") throw new Error("expected registration to succeed");
    const never = openSession(state, "never-registered");
    expect(state.registry.resolveRecipient(addressOf(never, "CODER"))).toEqual(NOT_KNOWN);
    const events = eventCount(state.store);
    const digests = decisionDigests(state.store);

    state.reopen();

    expect(eventCount(state.store)).toBe(events);
    expect(decisionDigests(state.store)).toBe(digests);
    expect(state.registry.resolveRecipient(keptAddress)).toEqual({ known: true, role: "CODER" });
    // Revocation survives the recreate, so it is durable rather than a runtime flag.
    expect(state.registry.resolveRecipient(goneAddress)).toEqual(NOT_KNOWN);
    // An aggregate that was never written is still a look that found nothing, not an
    // empty-but-authoritative answer and not the unreadable value.
    expect(state.registry.resolveRecipient(addressOf(never, "CODER"))).toEqual(NOT_KNOWN);

    const replayed = state.registry.register(command(keptAddress, "kept"));
    expect(replayed).toMatchObject({ outcome: "DEDUPLICATED" });
    if (replayed.outcome === "REFUSED") throw new Error("expected the replay to be accepted");
    expect(replayed.receipt).toEqual(registered.receipt);
    expect(replayed.receipt.requestSha256).toBe(registered.receipt.requestSha256);
    expect(replayed.receipt.resultSha256).toBe(registered.receipt.resultSha256);
    expect(replayed.version).toBe(registered.version);
    expect(eventCount(state.store)).toBe(events);
    expect(decisionDigests(state.store)).toBe(digests);
  });
});
