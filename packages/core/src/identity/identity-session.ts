/**
 * Daemon-owned identity records.
 *
 * Every factory here is a hostile-safe snapshot: it reads an untrusted value
 * once, copies what it needs, and returns `null` rather than throwing. No raw
 * bearer token or private-key material is ever stored on these records.
 */

export const PRINCIPAL_KINDS = Object.freeze(["HUMAN", "SYSTEM", "AGENT"] as const);
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const SESSION_STATUSES = Object.freeze(["ACTIVE", "CLOSED"] as const);
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface Principal {
  readonly principalId: string;
  readonly kind: PrincipalKind;
  readonly profileRevisionId: string;
}

export interface Session {
  readonly sessionId: string;
  readonly principalId: string;
  readonly profileRevisionId: string;
  readonly clientKeyId: string;
  readonly transportIds: readonly string[];
  readonly status: SessionStatus;
  readonly expiresAt: number;
  readonly generation: number;
}

export interface Credential {
  readonly credentialId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly revoked: boolean;
}

export interface CredentialRotation {
  readonly session: Session;
  readonly previous: Credential;
  readonly current: Credential;
}

const PRINCIPAL_KEYS = ["principalId", "kind", "profileRevisionId"] as const;
const SESSION_KEYS = [
  "sessionId", "principalId", "profileRevisionId", "clientKeyId",
  "transportIds", "status", "expiresAt", "generation",
] as const;
const CREDENTIAL_KEYS = ["credentialId", "sessionId", "generation", "revoked"] as const;

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Reads an untrusted record exactly once into a plain own-property map.
 *
 * Returns null for anything that is not a plain object, has an unexpected key
 * set, or throws while being read — which is how revoked proxies and hostile
 * getters are contained rather than propagated.
 */
function readExact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const actual = Object.keys(value);
    if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
      return null;
    }
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      copy[key] = (value as Record<string, unknown>)[key];
    }
    return copy;
  } catch {
    return null;
  }
}

export function createPrincipal(value: unknown): Principal | null {
  const raw = readExact(value, PRINCIPAL_KEYS);
  if (raw === null) return null;
  const { principalId, kind, profileRevisionId } = raw;
  if (!isId(principalId) || !isId(profileRevisionId)) return null;
  if (!(PRINCIPAL_KINDS as readonly unknown[]).includes(kind)) return null;
  return Object.freeze({
    principalId,
    kind: kind as PrincipalKind,
    profileRevisionId,
  });
}

/** Sorted and deduplicated so two equivalent sessions compare identically. */
function readTransports(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every(isId)) return null;
  return Object.freeze([...new Set(value as string[])].sort());
}

export function createSession(value: unknown): Session | null {
  const raw = readExact(value, SESSION_KEYS);
  if (raw === null) return null;
  const transportIds = readTransports(raw.transportIds);
  if (transportIds === null) return null;
  if (!isId(raw.sessionId) || !isId(raw.principalId)) return null;
  if (!isId(raw.profileRevisionId) || !isId(raw.clientKeyId)) return null;
  if (!(SESSION_STATUSES as readonly unknown[]).includes(raw.status)) return null;
  if (typeof raw.expiresAt !== "number" || !Number.isSafeInteger(raw.expiresAt)) return null;
  if (raw.expiresAt < 0 || !isPositiveInteger(raw.generation)) return null;
  return Object.freeze({
    sessionId: raw.sessionId,
    principalId: raw.principalId,
    profileRevisionId: raw.profileRevisionId,
    clientKeyId: raw.clientKeyId,
    transportIds,
    status: raw.status as SessionStatus,
    expiresAt: raw.expiresAt,
    generation: raw.generation,
  });
}

export function createCredential(value: unknown): Credential | null {
  const raw = readExact(value, CREDENTIAL_KEYS);
  if (raw === null) return null;
  if (!isId(raw.credentialId) || !isId(raw.sessionId)) return null;
  if (!isPositiveInteger(raw.generation) || typeof raw.revoked !== "boolean") return null;
  return Object.freeze({
    credentialId: raw.credentialId,
    sessionId: raw.sessionId,
    generation: raw.generation,
    revoked: raw.revoked,
  });
}

/** Expiry is exclusive: a session is unusable at exactly `expiresAt`. */
export function isSessionUsableAt(session: Session, now: number): boolean {
  if (!Number.isSafeInteger(now)) return false;
  return session.status === "ACTIVE" && now < session.expiresAt;
}

export function isCurrentGeneration(session: Session, credential: Credential): boolean {
  return (
    credential.sessionId === session.sessionId &&
    credential.generation === session.generation &&
    !credential.revoked
  );
}

/**
 * Advances the session by exactly one generation, revoking the prior
 * credential and preserving every binding and scope.
 *
 * Renewal policy is deliberately not invented here: expiry is carried across
 * unchanged, and extending it is a separate authority.
 */
export function rotateCredential(
  session: Session,
  credential: Credential,
  nextCredentialId: string,
): CredentialRotation | null {
  if (!isId(nextCredentialId) || nextCredentialId === credential.credentialId) return null;
  if (!isCurrentGeneration(session, credential)) return null;
  const generation = session.generation + 1;
  return Object.freeze({
    session: Object.freeze({ ...session, generation }),
    previous: Object.freeze({ ...credential, revoked: true }),
    current: Object.freeze({
      credentialId: nextCredentialId,
      sessionId: session.sessionId,
      generation,
      revoked: false,
    }),
  });
}
