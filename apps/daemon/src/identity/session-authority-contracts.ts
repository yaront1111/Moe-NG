import type {
  AuthenticatedSessionFacts,
  Credential,
  Principal,
  Session,
  SessionAuthCode,
  SessionAuthLayer,
} from "@moe/core";
import type { DurableStoreErrorCode } from "@moe/store";

export const SESSION_AUTHORITY_SCHEMA_VERSION = "moe.session-authority.v1" as const;
export const SESSION_PROOF_PROTOCOL_VERSION = 1 as const;
export const SESSION_PROOF_ALGORITHM = "Ed25519" as const;
export const SESSION_PROOF_DOMAIN = "moe.session-proof.v1" as const;
export const SESSION_PUBLIC_KEY_ENCODING = "DER_SPKI_LOWERCASE_HEX" as const;
export const SESSION_CLIENT_KEY_ID_ALGORITHM = "SHA-256" as const;
export const SESSION_PROOF_SIGNATURE_ENCODING = "LOWERCASE_HEX" as const;
export const SESSION_PROOF_NONCE_ENCODING = "LOWERCASE_HEX" as const;
export const SESSION_PROOF_MAX_AGE_MS = 60_000;
export const SESSION_PROOF_MAX_FUTURE_SKEW_MS = 30_000;
export const SESSION_TTL_MS = 15 * 60_000;
export const SESSION_ABSOLUTE_LIFETIME_MS = 8 * 60 * 60_000;
export const SESSION_AUTHORITY_MAX_ID_BYTES = 256;
export const SESSION_AUTHORITY_MAX_TRANSPORT_SCOPES = 32;
export const SESSION_CLIENT_KEY_ID_BYTES = 32;
export const SESSION_PUBLIC_KEY_SPKI_BYTES = 44;
export const SESSION_PROOF_SIGNATURE_BYTES = 64;
export const SESSION_PROOF_NONCE_BYTES = 16;

export const SESSION_AUTHORITY_EVENT_TYPES = Object.freeze([
  "SessionAuthorityPrincipalCreated",
  "SessionAuthorityOpened",
  "SessionAuthorityRenewed",
  "SessionAuthorityCredentialRotated",
  "SessionAuthorityClosed",
  "SessionAuthorityReplayObserved",
] as const);

export const SESSION_AUTHORITY_CODES = Object.freeze([
  "SESSION_AUTHORITY_COMMAND_CONFLICT",
  "SESSION_AUTHORITY_INVALID",
  "SESSION_AUTHORITY_UNREADABLE",
] as const);
export const SESSION_AUTHORITY_DAEMON_LAYERS = Object.freeze(["DURABLE_STORE"] as const);

export type SessionAuthorityCode =
  | SessionAuthCode
  | (typeof SESSION_AUTHORITY_CODES)[number]
  | DurableStoreErrorCode;
export type SessionAuthorityLayer = SessionAuthLayer | "DURABLE_STORE";
export type SessionAuthorityEventType = (typeof SESSION_AUTHORITY_EVENT_TYPES)[number];

export interface SessionProof {
  readonly protocolVersion: typeof SESSION_PROOF_PROTOCOL_VERSION;
  readonly algorithm: typeof SESSION_PROOF_ALGORITHM;
  readonly issuedAt: number;
  readonly nonce: string;
  readonly signatureHex: string;
}

export interface SessionProofChallengeFields {
  readonly principalId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly credentialId: string;
  readonly generation: number;
  readonly clientKeyId: string;
  readonly transportId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly issuedAt: number;
  readonly nonce: string;
}

export interface SessionPublicKeySnapshot {
  readonly algorithm: typeof SESSION_PROOF_ALGORITHM;
  readonly clientKeyId: string;
  readonly publicKeySpkiHex: string;
}

/**
 * Frozen advisory read model consumed by task-04e4367443214a588ed6277b92969a33
 * and task-4afcb06422ed4adb89430b7ea9758d7f. It carries no command, recipient,
 * effect, mailbox, capability-grant, or lifecycle-dispatch authority.
 */
export interface SessionAuthoritySnapshot {
  readonly projectId: string;
  readonly principal: Principal;
  readonly session: Session;
  readonly credential: Credential;
  readonly publicKey: SessionPublicKeySnapshot;
  readonly createdAt: number;
  readonly absoluteExpiresAt: number;
  readonly version: number;
}

export interface MutationReceipt {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly committedAt: string;
  readonly eventIds: readonly string[];
  readonly previousVersion: number;
  readonly currentVersion: number;
  readonly requestSha256: string;
  readonly resultSha256: string;
}

export interface ReplayReceipt {
  readonly aggregateId: string;
  readonly eventId: string;
  readonly committedAt: string;
  readonly previousVersion: 0;
  readonly currentVersion: 1;
  readonly replayDigest: string;
}

export interface CreatePrincipalInput {
  readonly commandId: string;
  readonly correlationId: string;
  readonly principalId: string;
  readonly kind: Principal["kind"];
  readonly profileRevisionId: string;
}

export interface OpenSessionInput {
  readonly commandId: string;
  readonly correlationId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly credentialId: string;
  readonly clientKeyId: string;
  readonly publicKeySpkiHex: string;
  readonly transportId: string;
  readonly transportIds: readonly string[];
  readonly requestDigest: string;
  readonly proof: SessionProof;
}

export interface AuthenticateSessionInput {
  readonly principalId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly credentialId: string;
  readonly generation: number;
  readonly clientKeyId: string;
  readonly transportId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly proof: SessionProof;
}

export interface AuthenticatedMutationInput {
  readonly commandId: string;
  readonly correlationId: string;
  readonly authentication: AuthenticateSessionInput;
}

export interface RotateCredentialInput extends AuthenticatedMutationInput {
  readonly nextCredentialId: string;
  readonly nextClientKeyId: string;
  readonly nextPublicKeySpkiHex: string;
  readonly nextSignatureHex: string;
}

export interface SessionAuthorityRefusal {
  readonly ok: false;
  readonly code: SessionAuthorityCode;
  readonly layer: SessionAuthorityLayer;
}

export interface PrincipalMutationSuccess {
  readonly ok: true;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly principal: Principal;
  readonly receipt: MutationReceipt;
}

export interface SessionMutationSuccess {
  readonly ok: true;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly authority: SessionAuthoritySnapshot;
  readonly receipt: MutationReceipt;
}

export interface RotationSuccess extends SessionMutationSuccess {
  readonly revokedCredential: Credential;
}

export interface SessionAuthenticationSuccess {
  readonly ok: true;
  readonly facts: AuthenticatedSessionFacts;
  readonly sessionVersion: number;
  readonly authorityDigest: string;
  readonly replayReceipt: ReplayReceipt;
}

export type PrincipalMutationResult = PrincipalMutationSuccess | SessionAuthorityRefusal;
export type SessionMutationResult = SessionMutationSuccess | SessionAuthorityRefusal;
export type RotationResult = RotationSuccess | SessionAuthorityRefusal;
export type SessionAuthenticationOutcome = SessionAuthenticationSuccess | SessionAuthorityRefusal;
export type SessionAuthorityRead =
  | Readonly<{ status: "FOUND"; authority: SessionAuthoritySnapshot }>
  | Readonly<{ status: "ABSENT" }>
  | Readonly<{ status: "UNKNOWN"; code: "SESSION_AUTHORITY_UNREADABLE" }>;

export interface SessionAuthorityService {
  readonly createPrincipal: (input: unknown) => PrincipalMutationResult;
  readonly openSession: (input: unknown) => SessionMutationResult;
  readonly renewSession: (input: unknown) => SessionMutationResult;
  readonly rotateCredential: (input: unknown) => RotationResult;
  readonly closeSession: (input: unknown) => SessionMutationResult;
  readonly authenticate: (input: unknown) => SessionAuthenticationOutcome;
  readonly readSessionAuthority: (sessionId: unknown) => SessionAuthorityRead;
  readonly readActiveSession: (sessionId: unknown) => SessionAuthorityRead;
}

export interface SessionAuthorityOptions {
  readonly projectId: string;
  readonly clock: () => number;
}
