/**
 * Session proof protocol v1: canonical challenge framing, request/replay
 * digests, and concrete Ed25519 proof-of-possession verification.
 *
 * Deterministic, synchronous, and IO-free. Every crypto or parser throw is
 * contained as `null`/`false` so a hostile input can never become a positive
 * answer, and nothing here reads or writes durable state.
 */

import { createHash, createPublicKey, verify } from "node:crypto";

import {
  SESSION_AUTHORITY_MAX_ID_BYTES,
  SESSION_AUTHORITY_MAX_TRANSPORT_SCOPES,
  SESSION_AUTHORITY_SCHEMA_VERSION,
  SESSION_PROOF_ALGORITHM,
  SESSION_PROOF_DOMAIN,
  SESSION_PROOF_MAX_AGE_MS,
  SESSION_PROOF_MAX_FUTURE_SKEW_MS,
  SESSION_PROOF_NONCE_BYTES,
  SESSION_PROOF_PROTOCOL_VERSION,
  SESSION_PROOF_SIGNATURE_BYTES,
  SESSION_PUBLIC_KEY_SPKI_BYTES,
} from "./session-authority-contracts.js";
import type { SessionProof, SessionProofChallengeFields } from "./session-authority-contracts.js";

/** SHA-256 output width, which every digest and client key id in v1 uses. */
export const SESSION_DIGEST_BYTES = 32;

const encoder = new TextEncoder();
const LOWERCASE_HEX = /^[0-9a-f]*$/u;
const MAX_CANONICAL_DEPTH = 8;

/** The exact, ordered v1 challenge fields. Reordering them changes every signature. */
const CHALLENGE_ORDER = [
  "principalId", "projectId", "sessionId", "credentialId", "generation",
  "clientKeyId", "transportId", "requestId", "requestDigest", "issuedAt", "nonce",
] as const;

const PROOF_KEYS = ["protocolVersion", "algorithm", "issuedAt", "nonce", "signatureHex"] as const;
const AUTH_KEYS = [
  "principalId", "projectId", "sessionId", "credentialId", "generation",
  "clientKeyId", "transportId", "requestId", "requestDigest", "proof",
] as const;

const REPLAY_ORDER = ["sessionId", "generation", "clientKeyId", "nonce"] as const;
const REPLAY_DOMAIN = `${SESSION_AUTHORITY_SCHEMA_VERSION}/replay`;

/** Framed as unsigned decimal ASCII without leading zeros; everything else is UTF-8. */
const NUMERIC_FIELDS: ReadonlySet<string> = new Set(["generation", "issuedAt"]);

export interface SessionReplayIdentity {
  readonly sessionId: string;
  readonly generation: number;
  readonly clientKeyId: string;
  readonly nonce: string;
}

/** A presented authentication request, canonical in shape but still unverified. */
export interface PresentedAuthentication {
  readonly principalId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly credentialId: string;
  readonly generation: number;
  readonly clientKeyId: string;
  readonly transportId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly proof: unknown;
}

export function isLowercaseHex(value: unknown, bytes: number): value is string {
  return typeof value === "string" && value.length === bytes * 2 && LOWERCASE_HEX.test(value);
}

export function isSessionDigest(value: unknown): value is string {
  return isLowercaseHex(value, SESSION_DIGEST_BYTES);
}

export function isBoundedId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  return encoder.encode(value).length <= SESSION_AUTHORITY_MAX_ID_BYTES;
}

export function isUnsignedSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reads an untrusted record exactly once into a plain own-property map, so a
 * revoked proxy, a throwing getter, or an extra key is contained as `null`
 * instead of propagating into the protocol.
 */
export function readExactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const actual = Object.keys(value);
    if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
      return null;
    }
    const copy: Record<string, unknown> = {};
    for (const key of keys) copy[key] = (value as Record<string, unknown>)[key];
    return copy;
  } catch {
    return null;
  }
}

function frame(value: string): Buffer {
  const bytes = Buffer.from(encoder.encode(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([header, bytes]);
}

function scalar(field: string, value: unknown): string {
  if (NUMERIC_FIELDS.has(field)) {
    if (!isUnsignedSafeInteger(value)) throw new TypeError(`invalid ${field}`);
    return String(value);
  }
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`invalid ${field}`);
  return value;
}

function framed(domain: string, order: readonly string[], raw: Record<string, unknown>): Buffer {
  const frames = order.map((field) => frame(scalar(field, raw[field])));
  return Buffer.concat([Buffer.from(encoder.encode(domain)), ...frames]);
}

/**
 * The one canonical signed-byte surface. Production and tests both sign these
 * exact bytes; nothing may reimplement the framing.
 */
export function canonicalSessionProofBytes(fields: SessionProofChallengeFields): Uint8Array {
  const raw = readExactRecord(fields, CHALLENGE_ORDER);
  if (raw === null) throw new TypeError("invalid session proof challenge fields");
  return new Uint8Array(framed(SESSION_PROOF_DOMAIN, CHALLENGE_ORDER, raw));
}

function canonicalJson(value: unknown, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) throw new TypeError("canonical value nested too deeply");
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonical numbers are safe integers");
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("unsupported canonical value");
}

/**
 * Binds a request to its proof. Key order is irrelevant, so a caller and this
 * module cannot disagree about a digest merely by constructing a record
 * differently.
 */
export function sessionAuthorityRequestDigest(value: unknown): string {
  const canonical = `${SESSION_AUTHORITY_SCHEMA_VERSION}:${canonicalJson(value, 0)}`;
  return createHash("sha256").update(encoder.encode(canonical)).digest("hex");
}

/**
 * Durable replay identity. Only this digest is ever persisted, so the raw nonce
 * never reaches an event, a result, or an aggregate id.
 */
export function sessionReplayDigest(identity: SessionReplayIdentity): string {
  const raw = readExactRecord(identity, REPLAY_ORDER);
  if (raw === null) throw new TypeError("invalid session replay identity");
  return createHash("sha256").update(framed(REPLAY_DOMAIN, REPLAY_ORDER, raw)).digest("hex");
}

function canonicalSpki(value: unknown): Buffer | null {
  try {
    if (!isLowercaseHex(value, SESSION_PUBLIC_KEY_SPKI_BYTES)) return null;
    const der = Buffer.from(value, "hex");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return null;
    const exported = key.export({ format: "der", type: "spki" });
    return Buffer.isBuffer(exported) && exported.equals(der) ? der : null;
  } catch {
    return null;
  }
}

export function isCanonicalSessionPublicKey(value: unknown): value is string {
  return canonicalSpki(value) !== null;
}

/** SHA-256 of the complete canonical SPKI bytes, or null for anything else. */
export function sessionClientKeyId(publicKeySpkiHex: unknown): string | null {
  const der = canonicalSpki(publicKeySpkiHex);
  return der === null ? null : createHash("sha256").update(der).digest("hex");
}

/** Shape and freshness only. A readable proof is still an unverified proof. */
export function readSessionProof(value: unknown, now: number): SessionProof | null {
  const raw = readExactRecord(value, PROOF_KEYS);
  if (raw === null || !isUnsignedSafeInteger(now)) return null;
  const { algorithm, issuedAt, nonce, protocolVersion, signatureHex } = raw;
  if (protocolVersion !== SESSION_PROOF_PROTOCOL_VERSION) return null;
  if (algorithm !== SESSION_PROOF_ALGORITHM) return null;
  if (!isUnsignedSafeInteger(issuedAt)) return null;
  if (!isLowercaseHex(nonce, SESSION_PROOF_NONCE_BYTES)) return null;
  if (!isLowercaseHex(signatureHex, SESSION_PROOF_SIGNATURE_BYTES)) return null;
  if (now - issuedAt > SESSION_PROOF_MAX_AGE_MS) return null;
  if (issuedAt - now > SESSION_PROOF_MAX_FUTURE_SKEW_MS) return null;
  return Object.freeze({
    protocolVersion: SESSION_PROOF_PROTOCOL_VERSION,
    algorithm: SESSION_PROOF_ALGORITHM,
    issuedAt,
    nonce,
    signatureHex,
  });
}

export function verifySessionProofSignature(
  publicKeySpkiHex: unknown,
  challenge: Uint8Array,
  signatureHex: unknown,
): boolean {
  try {
    const der = canonicalSpki(publicKeySpkiHex);
    if (der === null) return false;
    if (!isLowercaseHex(signatureHex, SESSION_PROOF_SIGNATURE_BYTES)) return false;
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return verify(null, challenge, key, Buffer.from(signatureHex, "hex")) === true;
  } catch {
    return false;
  }
}

/**
 * The only verification seam the authority uses: it frames the challenge and
 * checks the signature under one contained failure path, so a framing throw can
 * never be mistaken for a verified proof.
 */
export function verifySessionProofOverChallenge(
  publicKeySpkiHex: unknown,
  fields: SessionProofChallengeFields,
  signatureHex: unknown,
): boolean {
  try {
    const challenge = canonicalSessionProofBytes(fields);
    return verifySessionProofSignature(publicKeySpkiHex, challenge, signatureHex);
  } catch {
    return false;
  }
}

/** Reads the exact presented authentication vocabulary; anything else is null. */
export function readPresentedAuthentication(
  value: unknown,
  projectId: string,
): PresentedAuthentication | null {
  const raw = readExactRecord(value, AUTH_KEYS);
  if (raw === null || raw.projectId !== projectId) return null;
  const { clientKeyId, credentialId, generation, principalId, requestDigest } = raw;
  const { requestId, sessionId, transportId } = raw;
  if (!isBoundedId(principalId) || !isBoundedId(sessionId) || !isBoundedId(credentialId)) {
    return null;
  }
  if (!isBoundedId(transportId) || !isBoundedId(requestId)) return null;
  if (!isSessionDigest(requestDigest) || !isSessionDigest(clientKeyId)) return null;
  if (!isUnsignedSafeInteger(generation) || generation < 1) return null;
  return Object.freeze({
    principalId, projectId, sessionId, credentialId, generation,
    clientKeyId, transportId, requestId, requestDigest, proof: raw.proof,
  });
}

/** The presented request minus its proof, plus the two proof scalars it signs. */
export function presentedChallenge(
  request: PresentedAuthentication,
  proof: SessionProof,
): SessionProofChallengeFields {
  const { proof: presented, ...fields } = request;
  return { ...fields, issuedAt: proof.issuedAt, nonce: proof.nonce };
}

/** Scopes are accepted exactly as presented: already sorted, unique, and bounded. */
export function readTransportScopes(value: unknown, transportId: string): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > SESSION_AUTHORITY_MAX_TRANSPORT_SCOPES) return null;
  if (!value.every((scope: unknown) => isBoundedId(scope))) return null;
  const scopes = value as readonly string[];
  let previous: string | null = null;
  for (const scope of scopes) {
    if (previous !== null && previous >= scope) return null;
    previous = scope;
  }
  return scopes.includes(transportId) ? Object.freeze([...scopes]) : null;
}
