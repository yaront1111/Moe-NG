/**
 * The durable daemon session authority for non-command transports.
 *
 * It composes the pure `@moe/core` session seam rather than restating its
 * refusal precedence: the daemon owns concrete Ed25519 verification and durable
 * replay evidence, and core owns the seven-layer decision. No caller can inject
 * a positive verifier, replay, session, or capability answer, and this module
 * carries no command, recipient, effect, mailbox, or lifecycle authority.
 */

import {
  authenticateSession, createCredential, createPrincipal as coreCreatePrincipal,
  createSession, isSessionUsableAt, rotateCredential as rotateCoreCredential,
} from "@moe/core";
import type { ProofChallenge, ReplayOutcome } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import {
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_TTL_MS,
} from "./session-authority-contracts.js";
import type {
  PrincipalMutationResult, ReplayReceipt, RotationResult, SessionAuthenticationOutcome,
  SessionAuthorityCode, SessionAuthorityEventType, SessionAuthorityLayer, SessionAuthorityOptions,
  SessionAuthorityRead, SessionAuthorityRefusal, SessionAuthorityService, SessionMutationResult,
  SessionProof,
} from "./session-authority-contracts.js";
import {
  isBoundedId, isSessionDigest, isUnsignedSafeInteger, presentedChallenge, readExactRecord,
  readPresentedAuthentication, readSessionProof, readTransportScopes,
  sessionAuthorityRequestDigest, sessionClientKeyId, sessionReplayDigest,
  verifySessionProofOverChallenge,
} from "./session-authority-protocol.js";
import type { PresentedAuthentication } from "./session-authority-protocol.js";
import {
  commitAuthorityDecision, observeReplayMarker, principalAggregateId, readPrincipalRecord,
  readSessionFold, receiptOf, sessionAggregateId,
} from "./session-authority-store.js";
import type { AuthorityCommit, SessionFold } from "./session-authority-store.js";

type MutationKind = "RENEW_SESSION" | "ROTATE_CREDENTIAL" | "CLOSE_SESSION";
type Facts = Readonly<Record<string, unknown>>;

interface AuthorizedMutation {
  readonly at: number;
  readonly commandId: string;
  readonly correlationId: string;
  readonly fold: SessionFold;
  readonly proof: SessionProof;
  readonly request: PresentedAuthentication;
}

const OPEN_KEYS = [
  "commandId", "correlationId", "principalId", "sessionId", "credentialId", "clientKeyId",
  "publicKeySpkiHex", "transportId", "transportIds", "requestDigest", "proof",
] as const;
const PRINCIPAL_KEYS = ["commandId", "correlationId", "principalId", "kind", "profileRevisionId"] as const;
const MUTATION_KEYS = ["commandId", "correlationId", "authentication"] as const;
const ROTATE_KEYS = [
  ...MUTATION_KEYS, "nextCredentialId", "nextClientKeyId", "nextPublicKeySpkiHex", "nextSignatureHex",
] as const;

function refuse(code: SessionAuthorityCode, layer: SessionAuthorityLayer): SessionAuthorityRefusal {
  return Object.freeze({ ok: false as const, code, layer });
}

const BINDING = refuse("AUTHENTICATION_FAILED", "BINDING");
const PROOF = refuse("AUTHENTICATION_FAILED", "PROOF");
const INVALID = refuse("SESSION_AUTHORITY_INVALID", "BINDING");
const UNREADABLE_REFUSAL = refuse("SESSION_AUTHORITY_UNREADABLE", "DURABLE_STORE");
const UNREADABLE = Object.freeze({
  status: "UNKNOWN" as const,
  code: "SESSION_AUTHORITY_UNREADABLE" as const,
});
const ABSENT = Object.freeze({ status: "ABSENT" as const });

function refused(
  value: AuthorizedMutation | SessionAuthorityRefusal,
): value is SessionAuthorityRefusal {
  return "ok" in value;
}

export function createSessionAuthority(
  store: SqliteEventStore,
  options: SessionAuthorityOptions,
): SessionAuthorityService {
  const { clock, projectId } = options;
  if (!isBoundedId(projectId) || typeof clock !== "function") {
    throw new TypeError("a session authority requires a bounded project id and a clock");
  }

  function now(): number | null {
    try {
      const value: unknown = clock();
      return isUnsignedSafeInteger(value) ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Commits one lifecycle decision and answers from the durable fold, so a
   * caller never receives a record this module merely intended to write.
   */
  function commitSession(plan: AuthorityCommit, sessionId: string): SessionMutationResult {
    const outcome = commitAuthorityDecision(store, plan);
    if (!outcome.ok) return outcome;
    const fold = readSessionFold(store, sessionId);
    if (fold.status !== "FOUND") return UNREADABLE_REFUSAL;
    return Object.freeze({
      ok: true as const,
      disposition: outcome.disposition,
      authority: fold.fold.snapshot,
      receipt: receiptOf(outcome.decision),
    });
  }

  function createPrincipal(input: unknown): PrincipalMutationResult {
    const raw = readExactRecord(input, PRINCIPAL_KEYS);
    const at = now();
    if (raw === null || at === null) return INVALID;
    const { commandId, correlationId, kind, principalId, profileRevisionId } = raw;
    if (!isBoundedId(commandId) || !isBoundedId(correlationId)) return INVALID;
    const principal = coreCreatePrincipal({ principalId, kind, profileRevisionId });
    if (principal === null) return INVALID;
    const facts: Facts = { ...principal };
    const outcome = commitAuthorityDecision(store, {
      aggregateId: principalAggregateId(principal.principalId),
      commandId, commandKind: "CREATE_PRINCIPAL", correlationId,
      decidedAt: new Date(at).toISOString(),
      eventPayload: facts,
      eventType: "SessionAuthorityPrincipalCreated",
      expectedVersion: 0,
      principalId: principal.principalId,
      projectId,
      requestFacts: { command: "CREATE_PRINCIPAL", ...facts },
      resultFacts: { principal: facts },
    });
    if (!outcome.ok) return outcome;
    return Object.freeze({
      ok: true as const, disposition: outcome.disposition,
      principal, receipt: receiptOf(outcome.decision),
    });
  }

  function openSession(input: unknown): SessionMutationResult {
    const raw = readExactRecord(input, OPEN_KEYS);
    const at = now();
    if (raw === null || at === null) return INVALID;
    const { clientKeyId, commandId, correlationId, credentialId } = raw;
    const { principalId, publicKeySpkiHex, requestDigest, sessionId, transportId } = raw;
    if (!isBoundedId(commandId) || !isBoundedId(correlationId)) return INVALID;
    if (!isBoundedId(principalId) || !isBoundedId(sessionId)) return INVALID;
    if (!isBoundedId(credentialId) || !isBoundedId(transportId)) return INVALID;
    if (!isSessionDigest(requestDigest)) return INVALID;
    const scopes = readTransportScopes(raw.transportIds, transportId);
    if (scopes === null) return INVALID;
    const owner = readPrincipalRecord(store, principalId);
    if (owner.status !== "FOUND") return BINDING;
    if (typeof publicKeySpkiHex !== "string" || !isSessionDigest(clientKeyId)) return PROOF;
    if (sessionClientKeyId(publicKeySpkiHex) !== clientKeyId) return PROOF;
    const proof = readSessionProof(raw.proof, at);
    if (proof === null) return PROOF;
    const { kind, profileRevisionId } = owner.principal;
    const expected = sessionAuthorityRequestDigest({
      kind: "OPEN_SESSION", projectId, principalId, profileRevisionId, sessionId, credentialId,
      generation: 1, clientKeyId, publicKeySpkiHex, transportId, transportIds: scopes,
    });
    if (expected !== requestDigest) return BINDING;
    const selfProof: PresentedAuthentication = Object.freeze({
      principalId, projectId, sessionId, credentialId, generation: 1,
      clientKeyId, transportId, requestId: commandId, requestDigest, proof: raw.proof,
    });
    const challenge = presentedChallenge(selfProof, proof);
    if (!verifySessionProofOverChallenge(publicKeySpkiHex, challenge, proof.signatureHex)) {
      return PROOF;
    }
    return commitSession({
      aggregateId: sessionAggregateId(sessionId),
      commandId, commandKind: "OPEN_SESSION", correlationId,
      decidedAt: new Date(at).toISOString(),
      eventPayload: {
        projectId, principalId, principalKind: kind, profileRevisionId, sessionId, credentialId,
        clientKeyId, publicKeySpkiHex, transportIds: scopes, createdAt: at,
        expiresAt: at + SESSION_TTL_MS, absoluteExpiresAt: at + SESSION_ABSOLUTE_LIFETIME_MS,
      },
      eventType: "SessionAuthorityOpened",
      expectedVersion: 0,
      principalId, projectId,
      requestFacts: { command: "OPEN_SESSION", sessionId, credentialId, clientKeyId, requestDigest },
      resultFacts: { command: "OPEN_SESSION", sessionId, credentialId, clientKeyId, version: 1 },
    }, sessionId);
  }

  /**
   * The only authentication path. The verifier and replay closures are built
   * here from durable material, so an input may present evidence but never an
   * answer.
   */
  function authenticate(input: unknown): SessionAuthenticationOutcome {
    const request = readPresentedAuthentication(input, projectId);
    const at = now();
    if (request === null || at === null) return BINDING;
    const read = readSessionFold(store, request.sessionId);
    if (read.status !== "FOUND") return BINDING;
    const { credentials, snapshot } = read.fold;
    const held = credentials.find((entry) => entry.credentialId === request.credentialId);
    if (held === undefined || held.generation !== request.generation) return BINDING;
    if (held.clientKeyId !== request.clientKeyId) return BINDING;
    if (snapshot.principal.principalId !== request.principalId) return BINDING;
    const proof = readSessionProof(request.proof, at);
    if (proof === null) return PROOF;
    // The session is durable, but its bound key is the one this credential was
    // issued against: a superseded generation must reach core's GENERATION
    // layer instead of being turned away as an unbound key.
    const session = createSession({ ...snapshot.session, clientKeyId: held.clientKeyId });
    const credential = createCredential({
      credentialId: held.credentialId, sessionId: snapshot.session.sessionId,
      generation: held.generation, revoked: held.revoked,
    });
    if (session === null || credential === null) return BINDING;
    const burned: { receipt: ReplayReceipt | null } = { receipt: null };
    const result = authenticateSession({
      principal: snapshot.principal, session, credential,
      projectId: request.projectId, transportId: request.transportId, now: at,
      requestId: request.requestId, requestDigest: request.requestDigest,
      presentedCredentialId: request.credentialId,
      proof: {
        credentialId: request.credentialId, commandId: request.requestId,
        requestDigest: request.requestDigest, clientKeyId: request.clientKeyId,
      },
      verifyProof: (challenge: ProofChallenge): boolean =>
        challenge.credentialId === held.credentialId &&
        challenge.clientKeyId === held.clientKeyId &&
        verifySessionProofOverChallenge(
          held.publicKeySpkiHex,
          presentedChallenge(request, proof),
          proof.signatureHex,
        ),
      checkReplay: (): ReplayOutcome => {
        const observation = observeReplayMarker(store, {
          decidedAt: new Date(at).toISOString(),
          principalId: request.principalId,
          projectId,
          replayDigest: sessionReplayDigest({
            sessionId: request.sessionId, generation: request.generation,
            clientKeyId: request.clientKeyId, nonce: proof.nonce,
          }),
        });
        if (observation.outcome === "UNKNOWN") throw new Error("replay evidence is unavailable");
        if (observation.outcome === "REPLAYED") return "REPLAYED";
        burned.receipt = observation.receipt;
        return "FRESH";
      },
    });
    if (!result.ok) return refuse(result.code, result.layer);
    if (burned.receipt === null) return refuse("AUTHENTICATION_FAILED", "REPLAY");
    return Object.freeze({
      ok: true as const,
      facts: result.facts,
      sessionVersion: snapshot.version,
      authorityDigest: sessionAuthorityRequestDigest(snapshot),
      replayReceipt: burned.receipt,
    });
  }

  /** Every mutation is authorised by a fresh current-generation authentication. */
  function authorize(
    raw: Record<string, unknown>,
    kind: MutationKind,
    extra: (request: PresentedAuthentication) => Facts,
  ): AuthorizedMutation | SessionAuthorityRefusal {
    const at = now();
    const { commandId, correlationId } = raw;
    if (at === null || !isBoundedId(commandId) || !isBoundedId(correlationId)) return INVALID;
    const request = readPresentedAuthentication(raw.authentication, projectId);
    if (request === null || request.requestId !== commandId) return BINDING;
    const expected = sessionAuthorityRequestDigest({
      kind, projectId, principalId: request.principalId, sessionId: request.sessionId,
      credentialId: request.credentialId, generation: request.generation,
      clientKeyId: request.clientKeyId, ...extra(request),
    });
    if (expected !== request.requestDigest) return BINDING;
    const proof = readSessionProof(request.proof, at);
    if (proof === null) return PROOF;
    const authenticated = authenticate(raw.authentication);
    if (!authenticated.ok) return refuse(authenticated.code, authenticated.layer);
    const read = readSessionFold(store, request.sessionId);
    if (read.status !== "FOUND") return UNREADABLE_REFUSAL;
    return { at, commandId, correlationId, fold: read.fold, proof, request };
  }

  function commitMutation(
    authorized: AuthorizedMutation,
    kind: MutationKind,
    eventType: SessionAuthorityEventType,
    eventPayload: Facts,
    resultFacts: Facts,
  ): SessionMutationResult {
    const snapshot = authorized.fold.snapshot;
    const sessionId = snapshot.session.sessionId;
    return commitSession({
      aggregateId: sessionAggregateId(sessionId),
      commandId: authorized.commandId, commandKind: kind,
      correlationId: authorized.correlationId,
      decidedAt: new Date(authorized.at).toISOString(),
      eventPayload, eventType, expectedVersion: snapshot.version,
      principalId: snapshot.principal.principalId, projectId,
      requestFacts: { command: kind, sessionId, requestDigest: authorized.request.requestDigest },
      resultFacts: { command: kind, sessionId, version: snapshot.version + 1, ...resultFacts },
    }, sessionId);
  }

  function mutate(input: unknown, kind: "RENEW_SESSION" | "CLOSE_SESSION"): SessionMutationResult {
    const raw = readExactRecord(input, MUTATION_KEYS);
    if (raw === null) return INVALID;
    const authorized = authorize(raw, kind, () => ({}));
    if (refused(authorized)) return authorized;
    if (kind === "CLOSE_SESSION") {
      const closedAt = authorized.at;
      return commitMutation(authorized, kind, "SessionAuthorityClosed", { closedAt }, {
        status: "CLOSED",
      });
    }
    const cap = authorized.fold.snapshot.absoluteExpiresAt;
    const expiresAt = Math.min(authorized.at + SESSION_TTL_MS, cap);
    return commitMutation(authorized, kind, "SessionAuthorityRenewed", { expiresAt }, { expiresAt });
  }

  function rotateCredential(input: unknown): RotationResult {
    const raw = readExactRecord(input, ROTATE_KEYS);
    if (raw === null) return INVALID;
    const { nextClientKeyId, nextCredentialId, nextPublicKeySpkiHex, nextSignatureHex } = raw;
    if (!isBoundedId(nextCredentialId)) return INVALID;
    if (typeof nextPublicKeySpkiHex !== "string" || !isSessionDigest(nextClientKeyId)) return PROOF;
    if (sessionClientKeyId(nextPublicKeySpkiHex) !== nextClientKeyId) return PROOF;
    const authorized = authorize(raw, "ROTATE_CREDENTIAL", (request) => ({
      nextCredentialId, nextGeneration: request.generation + 1,
      nextClientKeyId, nextPublicKeySpkiHex,
    }));
    if (refused(authorized)) return authorized;
    const challenge = presentedChallenge(authorized.request, authorized.proof);
    if (!verifySessionProofOverChallenge(nextPublicKeySpkiHex, challenge, nextSignatureHex)) {
      return PROOF;
    }
    const { credential, session } = authorized.fold.snapshot;
    const rotation = rotateCoreCredential(session, credential, nextCredentialId);
    if (rotation === null) return refuse("SESSION_REPLAYED", "GENERATION");
    const generation = rotation.session.generation;
    const committed = commitMutation(
      authorized,
      "ROTATE_CREDENTIAL",
      "SessionAuthorityCredentialRotated",
      {
        credentialId: nextCredentialId, generation,
        clientKeyId: nextClientKeyId, publicKeySpkiHex: nextPublicKeySpkiHex,
      },
      { credentialId: nextCredentialId, generation, clientKeyId: nextClientKeyId },
    );
    if (!committed.ok) return committed;
    return Object.freeze({ ...committed, revokedCredential: rotation.previous });
  }

  function readSessionAuthority(sessionId: unknown): SessionAuthorityRead {
    const read = readSessionFold(store, sessionId);
    if (read.status === "UNKNOWN") return UNREADABLE;
    if (read.status === "ABSENT") return ABSENT;
    return Object.freeze({ status: "FOUND" as const, authority: read.fold.snapshot });
  }

  function readActiveSession(sessionId: unknown): SessionAuthorityRead {
    const read = readSessionAuthority(sessionId);
    const at = now();
    if (read.status !== "FOUND") return read;
    if (at === null) return UNREADABLE;
    const { credential, projectId: owner, session } = read.authority;
    if (!isSessionUsableAt(session, at) || credential.revoked) return ABSENT;
    if (owner !== projectId || credential.generation !== session.generation) return ABSENT;
    return read;
  }

  return Object.freeze({
    createPrincipal,
    openSession,
    renewSession: (input: unknown): SessionMutationResult => mutate(input, "RENEW_SESSION"),
    rotateCredential,
    closeSession: (input: unknown): SessionMutationResult => mutate(input, "CLOSE_SESSION"),
    authenticate,
    readSessionAuthority,
    readActiveSession,
  });
}
