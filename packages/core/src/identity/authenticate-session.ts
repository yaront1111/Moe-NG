import { isCurrentGeneration, isSessionUsableAt } from "./identity-session.js";
import type { Credential, Principal, Session } from "./identity-session.js";

export const SESSION_AUTH_LAYERS = Object.freeze([
  "BINDING",
  "PROOF",
  "REPLAY",
  "GENERATION",
  "SESSION_STATE",
  "EXPIRY",
  "TRANSPORT",
] as const);

export type SessionAuthLayer = (typeof SESSION_AUTH_LAYERS)[number];
export type SessionAuthCode =
  | "AUTHENTICATION_FAILED"
  | "SESSION_REPLAYED"
  | "SESSION_EXPIRED"
  | "CAPABILITY_DENIED";

/** Proof of possession presented alongside an authenticated request. */
export interface PresentedProof {
  readonly credentialId: string;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly clientKeyId: string;
}

/** What the injected verifier is asked to attest. Never self-asserted. */
export interface ProofChallenge {
  readonly commandId: string;
  readonly requestDigest: string;
  readonly credentialId: string;
  readonly clientKeyId: string;
}

export type ReplayOutcome = "FRESH" | "REPLAYED";

export interface SessionAuthenticationInput {
  readonly principal: Principal | null;
  readonly session: Session | null;
  readonly credential: Credential | null;
  readonly projectId: string;
  readonly transportId: string;
  readonly now: number;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly presentedCredentialId: string;
  readonly proof: PresentedProof | null;
  readonly verifyProof: (challenge: ProofChallenge) => boolean;
  readonly checkReplay: (challenge: ProofChallenge) => ReplayOutcome;
}

export interface AuthenticatedSessionFacts {
  readonly principalId: string;
  readonly principalKind: string;
  readonly profileRevisionId: string;
  readonly sessionId: string;
  readonly clientKeyId: string;
  readonly projectId: string;
  readonly transportId: string;
}

export type SessionAuthenticationResult =
  | { readonly ok: true; readonly facts: AuthenticatedSessionFacts }
  | { readonly ok: false; readonly code: SessionAuthCode; readonly layer: SessionAuthLayer };

interface BoundSession {
  readonly principal: Principal;
  readonly session: Session;
  readonly credential: Credential;
  readonly projectId: string;
  readonly transportId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly verifyProof: SessionAuthenticationInput["verifyProof"];
  readonly checkReplay: SessionAuthenticationInput["checkReplay"];
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function snapshotBindings(input: SessionAuthenticationInput): BoundSession | null {
  const { principal, session, credential, proof } = input;
  if (principal === null || session === null || credential === null) return null;
  if (proof === null || typeof proof !== "object") return null;
  if (!Number.isSafeInteger(input.now)) return null;
  if (!isNonEmpty(input.projectId) || !isNonEmpty(input.transportId)) return null;
  if (!isNonEmpty(input.requestId) || !isNonEmpty(input.requestDigest)) return null;
  if (!isNonEmpty(input.presentedCredentialId)) return null;
  if (credential.sessionId !== session.sessionId) return null;
  if (principal.principalId !== session.principalId) return null;
  if (principal.profileRevisionId !== session.profileRevisionId) return null;
  if (input.presentedCredentialId !== credential.credentialId) return null;
  if (proof.credentialId !== credential.credentialId) return null;
  if (proof.commandId !== input.requestId) return null;
  if (proof.requestDigest !== input.requestDigest) return null;
  if (proof.clientKeyId !== session.clientKeyId) return null;
  return snapshotBoundSession(input, principal, session, credential);
}

function snapshotBoundSession(
  input: SessionAuthenticationInput,
  principal: Principal,
  session: Session,
  credential: Credential,
): BoundSession {
  return Object.freeze({
    principal: Object.freeze({ ...principal }),
    session: Object.freeze({ ...session }),
    credential: Object.freeze({ ...credential }),
    projectId: input.projectId,
    transportId: input.transportId,
    requestId: input.requestId,
    requestDigest: input.requestDigest,
    verifyProof: input.verifyProof,
    checkReplay: input.checkReplay,
  });
}

function refuse(code: SessionAuthCode, layer: SessionAuthLayer): SessionAuthenticationResult {
  return Object.freeze({ ok: false as const, code, layer });
}

function observeProof(bound: BoundSession, challenge: ProofChallenge): boolean {
  try {
    return bound.verifyProof(challenge) === true;
  } catch {
    return false;
  }
}

function observeReplay(bound: BoundSession, challenge: ProofChallenge): ReplayOutcome | null {
  try {
    const replay: unknown = bound.checkReplay(challenge);
    return replay === "FRESH" || replay === "REPLAYED" ? replay : null;
  } catch {
    return null;
  }
}

function accept(bound: BoundSession): SessionAuthenticationResult {
  return Object.freeze({
    ok: true as const,
    facts: Object.freeze({
      principalId: bound.principal.principalId,
      principalKind: bound.principal.kind,
      profileRevisionId: bound.principal.profileRevisionId,
      sessionId: bound.session.sessionId,
      clientKeyId: bound.session.clientKeyId,
      projectId: bound.projectId,
      transportId: bound.transportId,
    }),
  });
}

function authenticateBoundSession(
  bound: BoundSession,
  now: number,
): SessionAuthenticationResult {
  const challenge: ProofChallenge = Object.freeze({
    commandId: bound.requestId,
    requestDigest: bound.requestDigest,
    credentialId: bound.credential.credentialId,
    clientKeyId: bound.session.clientKeyId,
  });
  if (!observeProof(bound, challenge)) return refuse("AUTHENTICATION_FAILED", "PROOF");
  const replay = observeReplay(bound, challenge);
  if (replay === null) return refuse("AUTHENTICATION_FAILED", "REPLAY");
  if (replay === "REPLAYED") return refuse("SESSION_REPLAYED", "REPLAY");
  if (!isCurrentGeneration(bound.session, bound.credential)) {
    return refuse("SESSION_REPLAYED", "GENERATION");
  }
  if (bound.session.status !== "ACTIVE") return refuse("SESSION_REPLAYED", "SESSION_STATE");
  if (!isSessionUsableAt(bound.session, now)) return refuse("SESSION_EXPIRED", "EXPIRY");
  if (!bound.session.transportIds.includes(bound.transportId)) {
    return refuse("CAPABILITY_DENIED", "TRANSPORT");
  }
  return accept(bound);
}

/** Authenticates session facts without granting command or business authority. */
export function authenticateSession(
  input: SessionAuthenticationInput,
): SessionAuthenticationResult {
  try {
    const bound = snapshotBindings(input);
    if (bound === null) return refuse("AUTHENTICATION_FAILED", "BINDING");
    return authenticateBoundSession(bound, input.now);
  } catch {
    return refuse("AUTHENTICATION_FAILED", "BINDING");
  }
}
