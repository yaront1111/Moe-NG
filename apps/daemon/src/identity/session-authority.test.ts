import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SESSION_AUTH_LAYERS } from "@moe/core";
import { RECOVERY_BINDING_CODEC_VERSION, SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_AUTHORITY_DAEMON_LAYERS,
  SESSION_AUTHORITY_MAX_ID_BYTES,
  SESSION_AUTHORITY_MAX_TRANSPORT_SCOPES,
  SESSION_AUTHORITY_SCHEMA_VERSION,
  SESSION_CLIENT_KEY_ID_ALGORITHM,
  SESSION_CLIENT_KEY_ID_BYTES,
  SESSION_PROOF_ALGORITHM,
  SESSION_PROOF_DOMAIN,
  SESSION_PROOF_MAX_AGE_MS,
  SESSION_PROOF_MAX_FUTURE_SKEW_MS,
  SESSION_PROOF_NONCE_BYTES,
  SESSION_PROOF_NONCE_ENCODING,
  SESSION_PROOF_PROTOCOL_VERSION,
  SESSION_PROOF_SIGNATURE_BYTES,
  SESSION_PROOF_SIGNATURE_ENCODING,
  SESSION_PUBLIC_KEY_ENCODING,
  SESSION_PUBLIC_KEY_SPKI_BYTES,
  SESSION_TTL_MS,
} from "./session-authority-contracts.js";
import {
  canonicalSessionProofBytes,
  sessionAuthorityRequestDigest,
  sessionClientKeyId,
  sessionReplayDigest,
} from "./session-authority-protocol.js";
import {
  commitAuthorityDecision,
  observeReplayMarker,
  replayAggregateId,
  sessionAggregateId,
} from "./session-authority-store.js";
import { createSessionAuthority } from "./session-authority.js";

const PROJECT_ID = "project-session-authority";
const PRINCIPAL_ID = "agent-session-authority";
const PROFILE_REVISION_ID = "profile-session-authority-v1";
const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const TRANSPORT_IDS = Object.freeze(["coordination.v1", "terminal.v1"]);
const RECOVERY_ONE = Object.freeze({
  incarnation: "81".repeat(32),
  keyEpoch: "91".repeat(32),
});
const RECOVERY_TWO = Object.freeze({
  incarnation: "82".repeat(32),
  keyEpoch: "92".repeat(32),
});
const RECOVERY_PAYLOAD = new TextEncoder().encode("authority-recovery-payload");

const directories: string[] = [];
const stores: SqliteEventStore[] = [];

interface Harness {
  readonly path: string;
  store: SqliteEventStore;
  readonly reopen: () => SqliteEventStore;
}

function harness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), "moe-session-authority-"));
  directories.push(directory);
  const path = join(directory, "store.sqlite");
  const opened = SqliteEventStore.openForProject(path, PROJECT_ID);
  installRecovery(opened, RECOVERY_ONE);
  stores.push(opened);
  const state: Harness = {
    path,
    store: opened,
    reopen: (): SqliteEventStore => {
      state.store.close();
      const next = SqliteEventStore.openForProject(path, PROJECT_ID);
      stores.push(next);
      state.store = next;
      return next;
    },
  };
  return state;
}

function installRecovery(
  store: SqliteEventStore,
  binding: typeof RECOVERY_ONE | typeof RECOVERY_TWO,
): void {
  expect(store.installRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef: binding.incarnation,
    installedAt: "2026-08-12T00:00:00.000Z",
    keyEpochRef: binding.keyEpoch,
    payload: RECOVERY_PAYLOAD,
    slot: "ACTIVE",
  })).toMatchObject({ ok: true, outcome: "INSTALLED" });
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

interface OpenFacts {
  readonly commandId: string;
  readonly correlationId: string;
  readonly credentialId: string;
  readonly sessionId: string;
  readonly transportId: string;
  readonly transportIds: readonly string[];
}

function openFacts(suffix = "one"): OpenFacts {
  return Object.freeze({
    commandId: `command-open-${suffix}`,
    correlationId: `correlation-open-${suffix}`,
    credentialId: `credential-${suffix}`,
    sessionId: `session-${suffix}`,
    transportId: TRANSPORT_IDS[0]!,
    transportIds: TRANSPORT_IDS,
  });
}

function openRequest(
  facts: OpenFacts,
  key: ClientKey,
  issuedAt = NOW,
  nonce = "12".repeat(16),
) {
  const requestDigest = sessionAuthorityRequestDigest({
    kind: "OPEN_SESSION",
    projectId: PROJECT_ID,
    principalId: PRINCIPAL_ID,
    profileRevisionId: PROFILE_REVISION_ID,
    sessionId: facts.sessionId,
    credentialId: facts.credentialId,
    generation: 1,
    clientKeyId: key.clientKeyId,
    publicKeySpkiHex: key.publicKeySpkiHex,
    transportId: facts.transportId,
    transportIds: facts.transportIds,
  });
  const challenge = canonicalSessionProofBytes({
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    recoveryIncarnationRef: RECOVERY_ONE.incarnation,
    keyEpochRef: RECOVERY_ONE.keyEpoch,
    sessionId: facts.sessionId,
    credentialId: facts.credentialId,
    generation: 1,
    clientKeyId: key.clientKeyId,
    transportId: facts.transportId,
    requestId: facts.commandId,
    requestDigest,
    issuedAt,
    nonce,
  });
  return Object.freeze({
    ...facts,
    principalId: PRINCIPAL_ID,
    publicKeySpkiHex: key.publicKeySpkiHex,
    clientKeyId: key.clientKeyId,
    requestDigest,
    proof: Object.freeze({
      protocolVersion: SESSION_PROOF_PROTOCOL_VERSION,
      algorithm: SESSION_PROOF_ALGORITHM,
      issuedAt,
      nonce,
      signatureHex: sign(null, challenge, key.privateKey).toString("hex"),
    }),
  });
}

function createPrincipalRequest() {
  return Object.freeze({
    commandId: "command-create-principal",
    correlationId: "correlation-create-principal",
    principalId: PRINCIPAL_ID,
    kind: "AGENT" as const,
    profileRevisionId: PROFILE_REVISION_ID,
  });
}

function createPrincipal(authority: ReturnType<typeof createSessionAuthority>) {
  const result = authority.createPrincipal(createPrincipalRequest());
  expect(result).toMatchObject({ ok: true, disposition: "DECIDED" });
  if (!result.ok) throw new Error("expected principal creation to succeed");
  return result;
}

interface AuthorityFacts {
  readonly projectId: string;
  readonly principal: {
    readonly principalId: string;
    readonly kind: "HUMAN" | "SYSTEM" | "AGENT";
    readonly profileRevisionId: string;
  };
  readonly session: {
    readonly sessionId: string;
    readonly principalId: string;
    readonly profileRevisionId: string;
    readonly clientKeyId: string;
    readonly transportIds: readonly string[];
    readonly status: "ACTIVE" | "CLOSED";
    readonly expiresAt: number;
    readonly generation: number;
    readonly recoveryIncarnationRef: string;
    readonly keyEpochRef: string;
  };
  readonly credential: {
    readonly credentialId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly revoked: boolean;
    readonly recoveryIncarnationRef: string;
    readonly keyEpochRef: string;
  };
  readonly publicKey: {
    readonly algorithm: "Ed25519";
    readonly clientKeyId: string;
    readonly publicKeySpkiHex: string;
  };
  readonly createdAt: number;
  readonly absoluteExpiresAt: number;
  readonly version: number;
}

interface AuthenticationOptions {
  readonly clientKeyId?: string;
  readonly credentialId?: string;
  readonly generation?: number;
  readonly issuedAt?: number;
  readonly nonce?: string;
  readonly principalId?: string;
  readonly projectId?: string;
  readonly requestDigest?: string;
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly signatureHex?: string;
  readonly transportId?: string;
}

function authenticationRequest(
  authority: AuthorityFacts,
  key: ClientKey,
  options: AuthenticationOptions = {},
) {
  const principalId = options.principalId ?? authority.principal.principalId;
  const projectId = options.projectId ?? authority.projectId;
  const sessionId = options.sessionId ?? authority.session.sessionId;
  const credentialId = options.credentialId ?? authority.credential.credentialId;
  const generation = options.generation ?? authority.session.generation;
  const clientKeyId = options.clientKeyId ?? authority.session.clientKeyId;
  const transportId = options.transportId ?? authority.session.transportIds[0]!;
  const requestId = options.requestId ?? `request-auth-${sessionId}`;
  const requestDigest =
    options.requestDigest ??
    sessionAuthorityRequestDigest({ kind: "AUTHENTICATE", resource: "active-session" });
  const issuedAt = options.issuedAt ?? NOW;
  const nonce = options.nonce ?? "34".repeat(16);
  const challenge = canonicalSessionProofBytes({
    principalId,
    projectId,
    recoveryIncarnationRef: authority.session.recoveryIncarnationRef,
    keyEpochRef: authority.session.keyEpochRef,
    sessionId,
    credentialId,
    generation,
    clientKeyId,
    transportId,
    requestId,
    requestDigest,
    issuedAt,
    nonce,
  });
  return Object.freeze({
    principalId,
    projectId,
    sessionId,
    credentialId,
    generation,
    clientKeyId,
    transportId,
    requestId,
    requestDigest,
    proof: Object.freeze({
      protocolVersion: SESSION_PROOF_PROTOCOL_VERSION,
      algorithm: SESSION_PROOF_ALGORITHM,
      issuedAt,
      nonce,
      signatureHex: options.signatureHex ?? sign(null, challenge, key.privateKey).toString("hex"),
    }),
  });
}

function mutationDigest(
  kind: "RENEW_SESSION" | "ROTATE_CREDENTIAL" | "CLOSE_SESSION",
  authority: AuthorityFacts,
  extra: Readonly<Record<string, unknown>> = {},
): string {
  return sessionAuthorityRequestDigest({
    kind,
    projectId: authority.projectId,
    principalId: authority.principal.principalId,
    sessionId: authority.session.sessionId,
    credentialId: authority.credential.credentialId,
    generation: authority.session.generation,
    clientKeyId: authority.session.clientKeyId,
    ...extra,
  });
}

function renewRequest(
  authority: AuthorityFacts,
  key: ClientKey,
  commandId: string,
  nonce: string,
  issuedAt = NOW,
) {
  return Object.freeze({
    commandId,
    correlationId: `correlation-${commandId}`,
    authentication: authenticationRequest(authority, key, {
      issuedAt,
      nonce,
      requestDigest: mutationDigest("RENEW_SESSION", authority),
      requestId: commandId,
    }),
  });
}

function closeRequest(
  authority: AuthorityFacts,
  key: ClientKey,
  commandId: string,
  nonce: string,
) {
  return Object.freeze({
    commandId,
    correlationId: `correlation-${commandId}`,
    authentication: authenticationRequest(authority, key, {
      nonce,
      requestDigest: mutationDigest("CLOSE_SESSION", authority),
      requestId: commandId,
    }),
  });
}

function rotationRequest(
  authority: AuthorityFacts,
  currentKey: ClientKey,
  nextKey: ClientKey,
  commandId: string,
  nonce: string,
) {
  const nextCredentialId = `${authority.credential.credentialId}-next`;
  const requestDigest = mutationDigest("ROTATE_CREDENTIAL", authority, {
    nextCredentialId,
    nextGeneration: authority.session.generation + 1,
    nextClientKeyId: nextKey.clientKeyId,
    nextPublicKeySpkiHex: nextKey.publicKeySpkiHex,
  });
  const authentication = authenticationRequest(authority, currentKey, {
    nonce,
    requestDigest,
    requestId: commandId,
  });
  const challenge = canonicalSessionProofBytes({
    principalId: authentication.principalId,
    projectId: authentication.projectId,
    recoveryIncarnationRef: authority.session.recoveryIncarnationRef,
    keyEpochRef: authority.session.keyEpochRef,
    sessionId: authentication.sessionId,
    credentialId: authentication.credentialId,
    generation: authentication.generation,
    clientKeyId: authentication.clientKeyId,
    transportId: authentication.transportId,
    requestId: authentication.requestId,
    requestDigest: authentication.requestDigest,
    issuedAt: authentication.proof.issuedAt,
    nonce: authentication.proof.nonce,
  });
  return Object.freeze({
    commandId,
    correlationId: `correlation-${commandId}`,
    authentication,
    nextCredentialId,
    nextClientKeyId: nextKey.clientKeyId,
    nextPublicKeySpkiHex: nextKey.publicKeySpkiHex,
    nextSignatureHex: sign(null, challenge, nextKey.privateKey).toString("hex"),
  });
}

function openAuthority(
  authority: ReturnType<typeof createSessionAuthority>,
  suffix: string,
  key = clientKey(),
) {
  const opened = authority.openSession(openRequest(openFacts(suffix), key));
  expect(opened).toMatchObject({ ok: true });
  if (!opened.ok) throw new Error("expected session opening to succeed");
  return Object.freeze({ authority: opened.authority as AuthorityFacts, key, result: opened });
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

function persistedCorpus(store: SqliteEventStore): string {
  const values: string[] = [];
  let eventCursor = 0n;
  for (;;) {
    const page = store.readEventsAfter(eventCursor, 100);
    for (const event of page.items) {
      values.push(
        event.aggregateId,
        event.commandId,
        event.eventId,
        event.eventType,
        Buffer.from(event.metadata).toString("utf8"),
        Buffer.from(event.metadata).toString("hex"),
        Buffer.from(event.payload).toString("utf8"),
        Buffer.from(event.payload).toString("hex"),
      );
    }
    if (!page.hasMore || page.nextCursor === null) break;
    eventCursor = page.nextCursor;
  }
  let decisionCursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(decisionCursor, 100);
    for (const decision of page.items) {
      values.push(
        decision.decisionId,
        decision.key.commandId,
        decision.requestSha256,
        decision.resultSha256,
        Buffer.from(decision.resultBytes).toString("utf8"),
        Buffer.from(decision.resultBytes).toString("hex"),
      );
    }
    if (!page.hasMore || page.nextCursor === null) break;
    decisionCursor = page.nextCursor;
  }
  return values.join("\n").toLowerCase();
}

describe("session proof protocol v1", () => {
  it("pins every version, algorithm, domain, clock, and lifetime constant", () => {
    expect(SESSION_AUTHORITY_SCHEMA_VERSION).toBe("moe.session-authority.v1");
    expect(SESSION_PROOF_PROTOCOL_VERSION).toBe(1);
    expect(SESSION_PROOF_ALGORITHM).toBe("Ed25519");
    expect(SESSION_PROOF_DOMAIN).toBe("moe.session-proof.v1");
    expect(SESSION_PUBLIC_KEY_ENCODING).toBe("DER_SPKI_LOWERCASE_HEX");
    expect(SESSION_CLIENT_KEY_ID_ALGORITHM).toBe("SHA-256");
    expect(SESSION_PROOF_SIGNATURE_ENCODING).toBe("LOWERCASE_HEX");
    expect(SESSION_PROOF_NONCE_ENCODING).toBe("LOWERCASE_HEX");
    expect(SESSION_PUBLIC_KEY_SPKI_BYTES).toBe(44);
    expect(SESSION_CLIENT_KEY_ID_BYTES).toBe(32);
    expect(SESSION_PROOF_SIGNATURE_BYTES).toBe(64);
    expect(SESSION_PROOF_NONCE_BYTES).toBe(16);
    expect(SESSION_PROOF_MAX_AGE_MS).toBe(60_000);
    expect(SESSION_PROOF_MAX_FUTURE_SKEW_MS).toBe(30_000);
    expect(SESSION_TTL_MS).toBe(15 * 60_000);
    expect(SESSION_ABSOLUTE_LIFETIME_MS).toBe(8 * 60 * 60_000);
    expect(SESSION_AUTHORITY_MAX_ID_BYTES).toBe(256);
    expect(SESSION_AUTHORITY_MAX_TRANSPORT_SCOPES).toBe(32);
    expect(SESSION_AUTHORITY_DAEMON_LAYERS).toEqual(["DURABLE_STORE"]);
    expect(Object.isFrozen(SESSION_AUTHORITY_DAEMON_LAYERS)).toBe(true);
  });

  it("pins the exact domain and thirteen u32be-framed challenge fields in order", () => {
    const bytes = canonicalSessionProofBytes({
      principalId: "p",
      projectId: "q",
      recoveryIncarnationRef: RECOVERY_ONE.incarnation,
      keyEpochRef: RECOVERY_ONE.keyEpoch,
      sessionId: "s",
      credentialId: "c",
      generation: 1,
      clientKeyId: "00".repeat(32),
      transportId: "t",
      requestId: "r",
      requestDigest: "11".repeat(32),
      issuedAt: 0,
      nonce: "22".repeat(16),
    });
    expect(Buffer.from(bytes).toString("hex")).toBe(
      "6d6f652e73657373696f6e2d70726f6f662e7631" +
        "00000001700000000171" +
        `00000040${Buffer.from(RECOVERY_ONE.incarnation).toString("hex")}` +
        `00000040${Buffer.from(RECOVERY_ONE.keyEpoch).toString("hex")}` +
        "000000017300000001630000000131" +
        "0000004030303030303030303030303030303030303030303030303030303030" +
        "303030303030303030303030303030303030303030303030303030303030303030303030" +
        "00000001740000000172" +
        "0000004031313131313131313131313131313131313131313131313131313131" +
        "313131313131313131313131313131313131313131313131313131313131313131313131" +
        "0000000130000000203232323232323232323232323232323232323232323232" +
        "323232323232323232",
    );
    expect(bytes).toHaveLength(368);
  });

  it("frames both recovery refs into the signed challenge as load-bearing fields", () => {
    const challenge = (recoveryIncarnationRef: string, keyEpochRef: string): Uint8Array =>
      canonicalSessionProofBytes({
        principalId: "p",
        projectId: "q",
        recoveryIncarnationRef,
        keyEpochRef,
        sessionId: "s",
        credentialId: "c",
        generation: 1,
        clientKeyId: "00".repeat(32),
        transportId: "t",
        requestId: "r",
        requestDigest: "11".repeat(32),
        issuedAt: 0,
        nonce: "22".repeat(16),
      });

    const current = challenge(RECOVERY_ONE.incarnation, RECOVERY_ONE.keyEpoch);
    expect(challenge(RECOVERY_TWO.incarnation, RECOVERY_ONE.keyEpoch)).not.toEqual(current);
    expect(challenge(RECOVERY_ONE.incarnation, RECOVERY_TWO.keyEpoch)).not.toEqual(current);
  });
});

describe("durable session authority lifecycle", () => {
  it("creates exact frozen principal and generation-one session facts durably", () => {
    const state = harness();
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    const principalResult = createPrincipal(authority);
    const key = clientKey();
    const opened = authority.openSession(openRequest(openFacts(), key));

    expect(principalResult.principal).toEqual({
      principalId: PRINCIPAL_ID,
      kind: "AGENT",
      profileRevisionId: PROFILE_REVISION_ID,
    });
    expect(opened).toMatchObject({ ok: true, disposition: "DECIDED" });
    if (!opened.ok) throw new Error("expected session opening to succeed");
    expect(opened.authority).toEqual({
      projectId: PROJECT_ID,
      principal: principalResult.principal,
      session: {
        sessionId: "session-one",
        principalId: PRINCIPAL_ID,
        profileRevisionId: PROFILE_REVISION_ID,
        clientKeyId: key.clientKeyId,
        transportIds: TRANSPORT_IDS,
        status: "ACTIVE",
        expiresAt: NOW + SESSION_TTL_MS,
        generation: 1,
        recoveryIncarnationRef: RECOVERY_ONE.incarnation,
        keyEpochRef: RECOVERY_ONE.keyEpoch,
      },
      credential: {
        credentialId: "credential-one",
        sessionId: "session-one",
        generation: 1,
        revoked: false,
        recoveryIncarnationRef: RECOVERY_ONE.incarnation,
        keyEpochRef: RECOVERY_ONE.keyEpoch,
      },
      publicKey: {
        algorithm: "Ed25519",
        clientKeyId: key.clientKeyId,
        publicKeySpkiHex: key.publicKeySpkiHex,
      },
      createdAt: NOW,
      absoluteExpiresAt: NOW + SESSION_ABSOLUTE_LIFETIME_MS,
      version: 1,
    });
    expect(Object.isFrozen(opened)).toBe(true);
    expect(Object.isFrozen(opened.authority)).toBe(true);
    expect(Object.isFrozen(opened.authority.principal)).toBe(true);
    expect(Object.isFrozen(opened.authority.session)).toBe(true);
    expect(Object.isFrozen(opened.authority.session.transportIds)).toBe(true);
    expect(Object.isFrozen(opened.authority.credential)).toBe(true);
    expect(Object.isFrozen(opened.authority.publicKey)).toBe(true);

    const principalDecision = state.store.getCommandDecision({
      commandId: principalResult.receipt.commandId,
      principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
    });
    const openDecision = state.store.getCommandDecision({
      commandId: opened.receipt.commandId,
      principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
    });
    expect(principalDecision).not.toBeNull();
    expect(openDecision).not.toBeNull();
    expect(principalResult.receipt).toMatchObject({
      requestSha256: principalDecision?.requestSha256,
      resultSha256: principalDecision?.resultSha256,
      previousVersion: 0,
      currentVersion: 1,
    });
    expect(opened.receipt).toMatchObject({
      requestSha256: openDecision?.requestSha256,
      resultSha256: openDecision?.resultSha256,
      previousVersion: 0,
      currentVersion: 1,
    });
    expect(state.store.readEvents(principalResult.receipt.aggregateId)).toHaveLength(1);
    expect(state.store.readEvents(opened.receipt.aggregateId)).toHaveLength(1);
  });

  it("replays identical commands, refuses conflicting bytes, and appends no event", () => {
    const state = harness();
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    const request = createPrincipalRequest();
    const first = authority.createPrincipal(request);
    const replay = authority.createPrincipal(request);
    const conflict = authority.createPrincipal({ ...request, profileRevisionId: "profile-conflict" });

    expect(first).toMatchObject({ ok: true, disposition: "DECIDED" });
    expect(replay).toMatchObject({ ok: true, disposition: "REPLAYED" });
    if (!first.ok || !replay.ok) throw new Error("expected create principal replay to succeed");
    expect(replay.principal).toEqual(first.principal);
    expect(replay.receipt).toEqual(first.receipt);
    expect(conflict).toEqual({
      ok: false,
      code: "SESSION_AUTHORITY_COMMAND_CONFLICT",
      layer: "DURABLE_STORE",
    });
    expect(state.store.readEvents(first.receipt.aggregateId)).toHaveLength(1);
  });

  it("reconstructs byte-identical authority and result bytes after database recreation", () => {
    const state = harness();
    let authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    createPrincipal(authority);
    const key = clientKey();
    const opened = authority.openSession(openRequest(openFacts("recreated"), key));
    expect(opened).toMatchObject({ ok: true });
    if (!opened.ok) throw new Error("expected session opening to succeed");
    const before = state.store.getCommandDecision({
      commandId: opened.receipt.commandId,
      principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
    });
    expect(before).not.toBeNull();

    authority = createSessionAuthority(state.reopen(), { projectId: PROJECT_ID, clock: () => NOW });
    const read = authority.readSessionAuthority("session-recreated");
    const after = state.store.getCommandDecision({
      commandId: opened.receipt.commandId,
      principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
    });
    expect(read).toEqual({ status: "FOUND", authority: opened.authority });
    expect(Buffer.from(after?.resultBytes ?? []).toString("hex")).toBe(
      Buffer.from(before?.resultBytes ?? []).toString("hex"),
    );
  });
});

describe("proof canonicalization and clock boundaries", () => {
  it("accepts inclusive proof-age/future-skew boundaries and refuses one millisecond beyond", () => {
    const state = harness();
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    createPrincipal(authority);
    const key = clientKey();
    const cases = [
      { suffix: "old-edge", issuedAt: NOW - SESSION_PROOF_MAX_AGE_MS, ok: true },
      { suffix: "old-over", issuedAt: NOW - SESSION_PROOF_MAX_AGE_MS - 1, ok: false },
      { suffix: "future-edge", issuedAt: NOW + SESSION_PROOF_MAX_FUTURE_SKEW_MS, ok: true },
      { suffix: "future-over", issuedAt: NOW + SESSION_PROOF_MAX_FUTURE_SKEW_MS + 1, ok: false },
    ] as const;
    expect(cases).toHaveLength(4);

    for (const entry of cases) {
      const result = authority.openSession(openRequest(openFacts(entry.suffix), key, entry.issuedAt));
      if (entry.ok) {
        expect(result).toMatchObject({ ok: true });
      } else {
        expect(result).toEqual({ ok: false, code: "AUTHENTICATION_FAILED", layer: "PROOF" });
      }
    }
  });

  it("rejects noncanonical SPKI, client id, signature, and nonce at the proof layer", () => {
    const state = harness();
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    createPrincipal(authority);
    const key = clientKey();
    const base = openRequest(openFacts("canonical"), key);
    const cases = [
      { name: "SPKI", request: { ...base, publicKeySpkiHex: base.publicKeySpkiHex.toUpperCase() } },
      { name: "client id", request: { ...base, clientKeyId: `AB${base.clientKeyId.slice(2)}` } },
      {
        name: "signature",
        request: { ...base, proof: { ...base.proof, signatureHex: `AB${base.proof.signatureHex.slice(2)}` } },
      },
      { name: "nonce", request: { ...base, proof: { ...base.proof, nonce: `AB${base.proof.nonce.slice(2)}` } } },
    ] as const;
    expect(cases).toHaveLength(4);

    for (const entry of cases) {
      expect(authority.openSession(entry.request), entry.name).toEqual({
        ok: false,
        code: "AUTHENTICATION_FAILED",
        layer: "PROOF",
      });
    }
  });
});

describe("recovery-bound proof authority", () => {
  it("issues against the selected row and rejects a prior proof at RECOVERY_BINDING", () => {
    const state = harness();
    installRecovery(state.store, RECOVERY_ONE);
    const authority = createSessionAuthority(state.store, {
      projectId: PROJECT_ID,
      clock: () => NOW,
    });
    createPrincipal(authority);
    const key = clientKey();
    const opened = authority.openSession(openRequest(openFacts("recovery-current"), key));
    expect(opened).toMatchObject({
      authority: {
        credential: {
          keyEpochRef: RECOVERY_ONE.keyEpoch,
          recoveryIncarnationRef: RECOVERY_ONE.incarnation,
        },
        session: {
          keyEpochRef: RECOVERY_ONE.keyEpoch,
          recoveryIncarnationRef: RECOVERY_ONE.incarnation,
        },
      },
      ok: true,
    });
    if (!opened.ok) throw new Error("expected recovery-bound opening to succeed");

    const priorProof = authenticationRequest(opened.authority as AuthorityFacts, key, {
      nonce: "7a".repeat(16),
      requestId: "request-recovery-prior",
    });
    installRecovery(state.store, RECOVERY_TWO);
    expect(authority.authenticate(priorProof)).toEqual({
      code: "SESSION_REPLAYED",
      layer: "RECOVERY_BINDING",
      ok: false,
    });
  });

  it("keeps a legacy SessionAuthorityOpened event without recovery refs unreadable", () => {
    const state = harness();
    installRecovery(state.store, RECOVERY_ONE);
    const key = clientKey();
    const sessionId = "session-legacy-unbound";
    const committed = commitAuthorityDecision(state.store, {
      aggregateId: sessionAggregateId(sessionId),
      commandId: "command-legacy-unbound",
      commandKind: "OPEN_SESSION",
      correlationId: "correlation-legacy-unbound",
      decidedAt: new Date(NOW).toISOString(),
      eventPayload: {
        projectId: PROJECT_ID,
        principalId: PRINCIPAL_ID,
        principalKind: "AGENT",
        profileRevisionId: PROFILE_REVISION_ID,
        sessionId,
        credentialId: "credential-legacy-unbound",
        clientKeyId: key.clientKeyId,
        publicKeySpkiHex: key.publicKeySpkiHex,
        transportIds: TRANSPORT_IDS,
        createdAt: NOW,
        expiresAt: NOW + SESSION_TTL_MS,
        absoluteExpiresAt: NOW + SESSION_ABSOLUTE_LIFETIME_MS,
      },
      eventType: "SessionAuthorityOpened",
      expectedVersion: 0,
      principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
      requestFacts: { legacy: true },
      resultFacts: { legacy: true },
    });
    expect(committed).toMatchObject({ ok: true });

    const authority = createSessionAuthority(state.store, {
      projectId: PROJECT_ID,
      clock: () => NOW,
    });
    expect(authority.readSessionAuthority(sessionId)).toEqual({
      code: "SESSION_AUTHORITY_UNREADABLE",
      status: "UNKNOWN",
    });
  });
});

describe("concrete authentication and durable replay", () => {
  it("refuses a valid current-generation proof whose replay digest was preburned", () => {
    const state = harness();
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    createPrincipal(authority);
    const opened = openAuthority(authority, "preburned-replay");
    const request = authenticationRequest(opened.authority, opened.key, {
      nonce: "3a".repeat(16),
      requestId: "request-preburned-replay",
    });
    expect(request.generation).toBe(opened.authority.credential.generation);
    expect({
      keyEpochRef: opened.authority.credential.keyEpochRef,
      recoveryIncarnationRef: opened.authority.credential.recoveryIncarnationRef,
    }).toEqual({
      keyEpochRef: RECOVERY_ONE.keyEpoch,
      recoveryIncarnationRef: RECOVERY_ONE.incarnation,
    });
    const replayDigest = sessionReplayDigest({
      sessionId: request.sessionId,
      generation: request.generation,
      clientKeyId: request.clientKeyId,
      nonce: request.proof.nonce,
    });
    expect(observeReplayMarker(state.store, {
      decidedAt: new Date(NOW).toISOString(),
      principalId: request.principalId,
      projectId: PROJECT_ID,
      replayDigest,
    }).outcome).toBe("FRESH");

    // The exact layer distinguishes this fence from GENERATION and IDENTITY replay refusals.
    expect(authority.authenticate(request)).toEqual({
      ok: false,
      code: "SESSION_REPLAYED",
      layer: "REPLAY",
    });
    expect(state.store.readEvents(replayAggregateId(replayDigest)).map((event) => ({
      eventId: event.eventId,
      eventType: event.eventType,
    }))).toEqual([{
      eventId:
        `${SESSION_AUTHORITY_SCHEMA_VERSION}/replay/${replayDigest}` +
        "/SessionAuthorityReplayObserved",
      eventType: "SessionAuthorityReplayObserved",
    }]);
  });

  it("refuses unreadable replay evidence at the measured replay layer", () => {
    const state = harness();
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    createPrincipal(authority);
    const opened = openAuthority(authority, "unreadable-replay");
    const request = authenticationRequest(opened.authority, opened.key, {
      nonce: "3b".repeat(16),
      requestId: "request-unreadable-replay",
    });
    expect(authority.authenticate(request)).toMatchObject({ ok: true });
    const database = new DatabaseSync(state.path);
    try {
      const row = database.prepare(
        "SELECT decision_id FROM command_decisions WHERE command_kind = ?",
      ).get("OBSERVE_REPLAY");
      const decisionId = row?.["decision_id"];
      if (typeof decisionId !== "string") throw new Error("replay decision was not persisted");
      database.prepare("UPDATE command_decisions SET result_bytes = ? WHERE decision_id = ?")
        .run(new TextEncoder().encode("forged-result"), decisionId);
    } finally {
      database.close();
    }

    const result = authority.authenticate(request);
    expect(result).toEqual({
      ok: false,
      code: "AUTHENTICATION_FAILED",
      layer: "REPLAY",
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("still authenticates a fresh proof and carries its replay receipt", () => {
    const state = harness();
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    createPrincipal(authority);
    const opened = openAuthority(authority, "fresh-replay-receipt");
    const request = authenticationRequest(opened.authority, opened.key, {
      nonce: "3c".repeat(16),
      requestId: "request-fresh-replay-receipt",
    });
    const result = authority.authenticate(request);
    const replayDigest = sessionReplayDigest({
      sessionId: request.sessionId,
      generation: request.generation,
      clientKeyId: request.clientKeyId,
      nonce: request.proof.nonce,
    });
    expect(result).toMatchObject({
      ok: true,
      replayReceipt: {
        previousVersion: 0,
        currentVersion: 1,
        replayDigest,
      },
    });
    expect(state.store.readEvents(replayAggregateId(replayDigest)).map((event) => ({
      eventId: event.eventId,
      eventType: event.eventType,
    }))).toEqual([{
      eventId:
        `${SESSION_AUTHORITY_SCHEMA_VERSION}/replay/${replayDigest}` +
        "/SessionAuthorityReplayObserved",
      eventType: "SessionAuthorityReplayObserved",
    }]);
  });

  it("returns frozen core facts and allows the same request only with a fresh nonce", () => {
    const state = harness();
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    createPrincipal(authority);
    const opened = openAuthority(authority, "authentication");
    const requestDigest = sessionAuthorityRequestDigest({ kind: "READ", resource: "foundation" });
    const firstRequest = authenticationRequest(opened.authority, opened.key, {
      nonce: "41".repeat(16),
      requestDigest,
      requestId: "request-same-payload",
    });
    const secondRequest = authenticationRequest(opened.authority, opened.key, {
      nonce: "42".repeat(16),
      requestDigest,
      requestId: "request-same-payload",
    });

    const first = authority.authenticate(firstRequest);
    const second = authority.authenticate(secondRequest);
    const replay = authority.authenticate(firstRequest);
    expect(first).toMatchObject({
      ok: true,
      facts: {
        principalId: PRINCIPAL_ID,
        principalKind: "AGENT",
        profileRevisionId: PROFILE_REVISION_ID,
        projectId: PROJECT_ID,
        sessionId: opened.authority.session.sessionId,
        clientKeyId: opened.key.clientKeyId,
        transportId: TRANSPORT_IDS[0],
        recoveryIncarnationRef: RECOVERY_ONE.incarnation,
        keyEpochRef: RECOVERY_ONE.keyEpoch,
      },
      sessionVersion: 1,
      authorityDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      replayReceipt: {
        replayDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        previousVersion: 0,
        currentVersion: 1,
      },
    });
    expect(second).toMatchObject({ ok: true });
    expect(replay).toEqual({ ok: false, code: "SESSION_REPLAYED", layer: "REPLAY" });
    if (!first.ok || !second.ok) throw new Error("expected fresh proofs to authenticate");
    expect(first.authorityDigest).toBe(second.authorityDigest);
    expect(first.replayReceipt.replayDigest).not.toBe(second.replayReceipt.replayDigest);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.facts)).toBe(true);
    expect(Object.isFrozen(first.replayReceipt)).toBe(true);
  });

  it("preserves a replay marker across a real database recreation", () => {
    const state = harness();
    let authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    createPrincipal(authority);
    const opened = openAuthority(authority, "replay-recreation");
    const request = authenticationRequest(opened.authority, opened.key, {
      nonce: "43".repeat(16),
      requestId: "request-replay-recreation",
    });
    expect(authority.authenticate(request)).toMatchObject({ ok: true });

    authority = createSessionAuthority(state.reopen(), { projectId: PROJECT_ID, clock: () => NOW });
    expect(authority.authenticate(request)).toEqual({
      ok: false,
      code: "SESSION_REPLAYED",
      layer: "REPLAY",
    });
  });

  it("pins every binding and proof refusal subcase before replay persistence", () => {
    const state = harness();
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    createPrincipal(authority);
    const opened = openAuthority(authority, "refusal-subcases");
    const valid = authenticationRequest(opened.authority, opened.key, {
      nonce: "45".repeat(16),
      requestId: "request-refusal-subcases",
    });
    const bindingCases: readonly unknown[] = [
      { ...valid, sessionId: "session-unknown" },
      { ...valid, projectId: "project-cross-boundary" },
      {},
    ];
    const stale = authenticationRequest(opened.authority, opened.key, {
      issuedAt: NOW - SESSION_PROOF_MAX_AGE_MS - 1,
      nonce: "46".repeat(16),
      requestId: "request-stale-proof",
    });
    const future = authenticationRequest(opened.authority, opened.key, {
      issuedAt: NOW + SESSION_PROOF_MAX_FUTURE_SKEW_MS + 1,
      nonce: "47".repeat(16),
      requestId: "request-future-proof",
    });
    const proofCases = [
      { ...valid, proof: { ...valid.proof, signatureHex: "00".repeat(64) } },
      { ...valid, proof: { ...valid.proof, protocolVersion: 2 } },
      stale,
      future,
    ] as const;
    const before = eventCount(state.store);
    expect(bindingCases).toHaveLength(3);
    expect(proofCases).toHaveLength(4);
    for (const entry of bindingCases) {
      expect(authority.authenticate(entry)).toEqual({
        ok: false,
        code: "AUTHENTICATION_FAILED",
        layer: "BINDING",
      });
    }
    for (const entry of proofCases) {
      expect(authority.authenticate(entry)).toEqual({
        ok: false,
        code: "AUTHENTICATION_FAILED",
        layer: "PROOF",
      });
    }
    expect(eventCount(state.store)).toBe(before);
  });

  it("persists no private key, plaintext credential, signature, nonce, proof, or challenge bytes", () => {
    const state = harness();
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    createPrincipal(authority);
    const opened = openAuthority(authority, "redaction");
    const nonce = "44".repeat(16);
    const request = authenticationRequest(opened.authority, opened.key, {
      nonce,
      requestId: "request-redaction",
    });
    expect(authority.authenticate(request)).toMatchObject({ ok: true });
    const injectedSecret = "credential-secret-never-persist";
    expect(authority.authenticate({ ...request, plaintextCredential: injectedSecret })).toEqual({
      ok: false,
      code: "AUTHENTICATION_FAILED",
      layer: "BINDING",
    });
    const challenge = canonicalSessionProofBytes({
      principalId: request.principalId,
      projectId: request.projectId,
      recoveryIncarnationRef: opened.authority.session.recoveryIncarnationRef,
      keyEpochRef: opened.authority.session.keyEpochRef,
      sessionId: request.sessionId,
      credentialId: request.credentialId,
      generation: request.generation,
      clientKeyId: request.clientKeyId,
      transportId: request.transportId,
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      issuedAt: request.proof.issuedAt,
      nonce: request.proof.nonce,
    });
    const privateDer = opened.key.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("hex")
      .toLowerCase();
    const corpus = persistedCorpus(state.store);
    const forbidden = [
      privateDer,
      injectedSecret,
      request.proof.signatureHex,
      request.proof.nonce,
      Buffer.from(challenge).toString("hex"),
    ];
    expect(forbidden).toHaveLength(5);
    for (const value of forbidden) {
      expect(corpus, value.slice(0, 24)).not.toContain(value.toLowerCase());
      expect(corpus, `ascii hex of ${value.slice(0, 12)}`).not.toContain(
        Buffer.from(value, "utf8").toString("hex"),
      );
    }
  });
});

describe("eight-layer authentication refusal matrix", () => {
  it("covers every core layer exactly with its stable code and no session-authority mutation", () => {
    const state = harness();
    let now = NOW;
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => now });
    createPrincipal(authority);

    const binding = openAuthority(authority, "matrix-binding");
    const bindingRequest = authenticationRequest(binding.authority, binding.key, {
      nonce: "51".repeat(16),
    });
    const proof = openAuthority(authority, "matrix-proof");
    const proofRequest = authenticationRequest(proof.authority, proof.key, {
      nonce: "52".repeat(16),
    });
    const replay = openAuthority(authority, "matrix-replay");
    const replayRequest = authenticationRequest(replay.authority, replay.key, {
      nonce: "53".repeat(16),
    });
    expect(authority.authenticate(replayRequest)).toMatchObject({ ok: true });

    const generation = openAuthority(authority, "matrix-generation");
    const nextGenerationKey = clientKey();
    const rotation = authority.rotateCredential(
      rotationRequest(
        generation.authority,
        generation.key,
        nextGenerationKey,
        "command-matrix-rotate",
        "54".repeat(16),
      ),
    );
    expect(rotation).toMatchObject({ ok: true });

    const closed = openAuthority(authority, "matrix-closed");
    const close = authority.closeSession(
      closeRequest(closed.authority, closed.key, "command-matrix-close", "55".repeat(16)),
    );
    expect(close).toMatchObject({ ok: true });

    const transport = openAuthority(authority, "matrix-transport");
    const expired = openAuthority(authority, "matrix-expired");
    const recovery = openAuthority(authority, "matrix-recovery");
    const rows = [
      {
        code: "AUTHENTICATION_FAILED",
        layer: "BINDING",
        result: authority.authenticate({ ...bindingRequest, sessionId: "session-unknown" }),
      },
      {
        code: "AUTHENTICATION_FAILED",
        layer: "PROOF",
        result: authority.authenticate({
          ...proofRequest,
          proof: { ...proofRequest.proof, signatureHex: "00".repeat(64) },
        }),
      },
      {
        code: "SESSION_REPLAYED",
        layer: "REPLAY",
        result: authority.authenticate(replayRequest),
      },
      {
        code: "SESSION_REPLAYED",
        layer: "GENERATION",
        result: authority.authenticate(
          authenticationRequest(generation.authority, generation.key, {
            nonce: "56".repeat(16),
            requestId: "request-old-generation",
          }),
        ),
      },
      {
        code: "SESSION_REPLAYED",
        layer: "SESSION_STATE",
        result: authority.authenticate(
          authenticationRequest(closed.authority, closed.key, {
            nonce: "57".repeat(16),
            requestId: "request-closed-session",
          }),
        ),
      },
      {
        code: "CAPABILITY_DENIED",
        layer: "TRANSPORT",
        result: authority.authenticate(
          authenticationRequest(transport.authority, transport.key, {
            nonce: "58".repeat(16),
            requestId: "request-unlisted-transport",
            transportId: "unlisted.v1",
          }),
        ),
      },
    ];
    now = expired.authority.session.expiresAt;
    rows.push({
      code: "SESSION_EXPIRED",
      layer: "EXPIRY",
      result: authority.authenticate(
        authenticationRequest(expired.authority, expired.key, {
          issuedAt: now,
          nonce: "59".repeat(16),
          requestId: "request-expired-session",
        }),
      ),
    });
    installRecovery(state.store, RECOVERY_TWO);
    rows.push({
      code: "SESSION_REPLAYED",
      layer: "RECOVERY_BINDING",
      result: authority.authenticate(
        authenticationRequest(recovery.authority, recovery.key, {
          issuedAt: now,
          nonce: "5a".repeat(16),
          requestId: "request-prior-recovery",
        }),
      ),
    });

    expect(rows).toHaveLength(SESSION_AUTH_LAYERS.length);
    expect(rows.map((row) => row.layer).sort()).toEqual([...SESSION_AUTH_LAYERS].sort());
    for (const row of rows) {
      expect(row.result, row.layer).toEqual({ ok: false, code: row.code, layer: row.layer });
    }
    expect(state.store.readEvents(binding.result.receipt.aggregateId)).toHaveLength(1);
    expect(state.store.readEvents(proof.result.receipt.aggregateId)).toHaveLength(1);
    expect(state.store.readEvents(replay.result.receipt.aggregateId)).toHaveLength(1);
    expect(state.store.readEvents(generation.result.receipt.aggregateId)).toHaveLength(2);
    expect(state.store.readEvents(closed.result.receipt.aggregateId)).toHaveLength(2);
    expect(state.store.readEvents(transport.result.receipt.aggregateId)).toHaveLength(1);
    expect(state.store.readEvents(expired.result.receipt.aggregateId)).toHaveLength(1);
    expect(state.store.readEvents(recovery.result.receipt.aggregateId)).toHaveLength(1);
  });
});

describe("renew, rotate, close, and active reads", () => {
  it("renews expiry only and clamps repeated renewals to the absolute eight-hour cap", () => {
    const state = harness();
    let now = NOW;
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => now });
    createPrincipal(authority);
    const opened = openAuthority(authority, "renew-cap");
    let current = opened.authority;

    for (let index = 1; index <= 34; index += 1) {
      now += 14 * 60_000;
      const before = current;
      const nonce = index.toString(16).padStart(32, "0");
      const renewed = authority.renewSession(
        renewRequest(current, opened.key, `command-renew-${index}`, nonce, now),
      );
      expect(renewed, `renewal ${index}`).toMatchObject({ ok: true });
      if (!renewed.ok) throw new Error(`expected renewal ${index} to succeed`);
      current = renewed.authority;
      expect(current).toEqual({
        ...before,
        session: {
          ...before.session,
          expiresAt: Math.min(now + SESSION_TTL_MS, before.absoluteExpiresAt),
        },
        version: before.version + 1,
      });
    }
    expect(current.absoluteExpiresAt).toBe(NOW + SESSION_ABSOLUTE_LIFETIME_MS);
    expect(current.session.expiresAt).toBe(current.absoluteExpiresAt);
  });

  it("requires both keys, rotates atomically, and keeps both race orderings honest", () => {
    const state = harness();
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    createPrincipal(authority);
    const authFirst = openAuthority(authority, "auth-first");
    expect(
      authority.authenticate(
        authenticationRequest(authFirst.authority, authFirst.key, {
          nonce: "61".repeat(16),
          requestId: "request-before-rotation",
        }),
      ),
    ).toMatchObject({ ok: true });
    const authFirstNextKey = clientKey();
    const authFirstRotation = authority.rotateCredential(
      rotationRequest(
        authFirst.authority,
        authFirst.key,
        authFirstNextKey,
        "command-auth-first-rotate",
        "62".repeat(16),
      ),
    );
    expect(authFirstRotation).toMatchObject({
      ok: true,
      revokedCredential: { ...authFirst.authority.credential, revoked: true },
      authority: {
        session: {
          generation: 2,
          clientKeyId: authFirstNextKey.clientKeyId,
          recoveryIncarnationRef: RECOVERY_ONE.incarnation,
          keyEpochRef: RECOVERY_ONE.keyEpoch,
        },
        credential: {
          credentialId: `${authFirst.authority.credential.credentialId}-next`,
          generation: 2,
          revoked: false,
          recoveryIncarnationRef: RECOVERY_ONE.incarnation,
          keyEpochRef: RECOVERY_ONE.keyEpoch,
        },
        publicKey: {
          algorithm: "Ed25519",
          clientKeyId: authFirstNextKey.clientKeyId,
          publicKeySpkiHex: authFirstNextKey.publicKeySpkiHex,
        },
        version: 2,
      },
    });
    if (!authFirstRotation.ok) throw new Error("expected auth-first rotation to succeed");
    expect(
      authority.authenticate(
        authenticationRequest(authFirst.authority, authFirst.key, {
          nonce: "63".repeat(16),
          requestId: "request-old-after-rotation",
        }),
      ),
    ).toEqual({ ok: false, code: "SESSION_REPLAYED", layer: "GENERATION" });

    const rotateFirst = openAuthority(authority, "rotate-first");
    const rotateFirstNextKey = clientKey();
    const rotateFirstRotation = authority.rotateCredential(
      rotationRequest(
        rotateFirst.authority,
        rotateFirst.key,
        rotateFirstNextKey,
        "command-rotate-first",
        "64".repeat(16),
      ),
    );
    expect(rotateFirstRotation).toMatchObject({ ok: true });
    if (!rotateFirstRotation.ok) throw new Error("expected rotate-first rotation to succeed");
    expect(
      authority.authenticate(
        authenticationRequest(rotateFirst.authority, rotateFirst.key, {
          nonce: "65".repeat(16),
          requestId: "request-old-after-rotate-first",
        }),
      ),
    ).toEqual({ ok: false, code: "SESSION_REPLAYED", layer: "GENERATION" });
    expect(
      authority.authenticate(
        authenticationRequest(rotateFirstRotation.authority, rotateFirstNextKey, {
          nonce: "66".repeat(16),
          requestId: "request-new-after-rotate-first",
        }),
      ),
    ).toMatchObject({ ok: true, sessionVersion: 2 });

    const invalid = openAuthority(authority, "rotate-invalid-new-key");
    const invalidNextKey = clientKey();
    const invalidRequest = rotationRequest(
      invalid.authority,
      invalid.key,
      invalidNextKey,
      "command-rotate-invalid-new-key",
      "67".repeat(16),
    );
    const beforeEvents = state.store.readEvents(invalid.result.receipt.aggregateId).length;
    expect(
      authority.rotateCredential({ ...invalidRequest, nextSignatureHex: "00".repeat(64) }),
    ).toEqual({ ok: false, code: "AUTHENTICATION_FAILED", layer: "PROOF" });
    expect(state.store.readEvents(invalid.result.receipt.aggregateId)).toHaveLength(beforeEvents);
  });

  it("closes terminally and never presents a closed session as active", () => {
    const state = harness();
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    createPrincipal(authority);
    const opened = openAuthority(authority, "close-terminal");
    const active = authority.readActiveSession(opened.authority.session.sessionId);
    expect(active).toMatchObject({
      status: "FOUND",
      authority: { session: { status: "ACTIVE" } },
    });
    expect(Object.isFrozen(active)).toBe(true);

    const closed = authority.closeSession(
      closeRequest(opened.authority, opened.key, "command-close-terminal", "68".repeat(16)),
    );
    expect(closed).toMatchObject({
      ok: true,
      authority: { session: { status: "CLOSED" }, version: 2 },
    });
    if (!closed.ok) throw new Error("expected close to succeed");
    expect(
      authority.closeSession(
        closeRequest(closed.authority, opened.key, "command-close-again", "69".repeat(16)),
      ),
    ).toEqual({ ok: false, code: "SESSION_REPLAYED", layer: "SESSION_STATE" });
    expect(authority.readActiveSession(opened.authority.session.sessionId)).toEqual({
      status: "ABSENT",
    });
    expect(authority.readSessionAuthority(opened.authority.session.sessionId)).toEqual({
      status: "FOUND",
      authority: closed.authority,
    });
  });
});

describe("hostile authentication inputs", () => {
  it("contains accessors, proxies, cycles, extra keys, and injected positive verdicts at BINDING", () => {
    const state = harness();
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    createPrincipal(authority);
    const opened = openAuthority(authority, "hostile");
    const valid = authenticationRequest(opened.authority, opened.key, {
      nonce: "71".repeat(16),
      requestId: "request-hostile",
    });
    const cyclic: Record<string, unknown> = { ...valid };
    cyclic.self = cyclic;
    const throwing = new Proxy(valid, {
      ownKeys: () => {
        throw new Error("hostile ownKeys");
      },
    });
    const accessor = Object.defineProperty({ ...valid }, "requestId", {
      enumerable: true,
      get: () => {
        throw new Error("hostile getter");
      },
    });
    const symbolExtra = Object.defineProperty({ ...valid }, Symbol("extra"), { value: true });
    const hiddenExtra = Object.defineProperty({ ...valid }, "extra", { value: true });
    const cases: readonly unknown[] = [
      { ...valid, extra: true },
      { ...valid, verifyProof: () => true, checkReplay: () => "FRESH" },
      cyclic,
      throwing,
      accessor,
      symbolExtra,
      hiddenExtra,
    ];
    const before = eventCount(state.store);
    expect(cases).toHaveLength(7);
    for (const entry of cases) {
      expect(authority.authenticate(entry)).toEqual({
        ok: false,
        code: "AUTHENTICATION_FAILED",
        layer: "BINDING",
      });
    }
    expect(eventCount(state.store)).toBe(before);
  });

  it("rejects a nonthrowing request accessor without durable replay evidence", () => {
    const state = harness();
    const authority = createSessionAuthority(state.store, { projectId: PROJECT_ID, clock: () => NOW });
    createPrincipal(authority);
    const opened = openAuthority(authority, "returning-accessor");
    const valid = authenticationRequest(opened.authority, opened.key, {
      nonce: "72".repeat(16),
      requestId: "request-returning-accessor",
    });
    let reads = 0;
    const accessor = Object.defineProperty({ ...valid }, "requestId", {
      enumerable: true,
      get: () => {
        reads += 1;
        return valid.requestId;
      },
    });
    const before = eventCount(state.store);

    expect(authority.authenticate(accessor)).toEqual({
      ok: false,
      code: "AUTHENTICATION_FAILED",
      layer: "BINDING",
    });
    expect(reads).toBe(0);
    expect(eventCount(state.store)).toBe(before);
  });
});
