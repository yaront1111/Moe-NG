import {
  SESSION_PROOF_ALGORITHM,
  SESSION_PROOF_PROTOCOL_VERSION,
  canonicalSessionProofBytes,
} from "@moe/contracts";
import {
  generateSessionKey,
  openSessionRequestDigest,
  signSessionChallenge,
} from "@moe/control-room-client";
import type { SessionKeyGenerated } from "@moe/control-room-client";

export type LiveKeyedPostPath = "/session/pair/claim" | "/session/pair/open";
export interface LiveKeyedPostResult {
  readonly body: unknown;
  /** Already-sanitized transport detail from the bounded caller, when available. */
  readonly detail?: string;
  readonly ok: boolean;
  readonly status: number;
}
export type LiveKeyedPost = (
  path: LiveKeyedPostPath,
  body: Readonly<Record<string, unknown>>,
) => Promise<LiveKeyedPostResult>;

export interface LiveKeyedSessionInput {
  readonly post: LiveKeyedPost;
  readonly projectId: string;
  readonly protocolVersion: string;
  readonly requestId: string;
}
export interface LiveKeyedOpened {
  readonly ok: true;
  readonly sessionCredential: string;
}
export interface LiveKeyedRetry {
  readonly status: "RETRY_CLAIM";
}
export interface LiveKeyedRefused {
  readonly code: "LIVE_PAIRING_REFUSED";
  readonly detail: string;
  readonly ok: false;
}
export type LiveKeyedSessionResult = LiveKeyedOpened | LiveKeyedRetry | LiveKeyedRefused;
export interface LiveKeyedSession {
  claimAndOpen(): Promise<LiveKeyedSessionResult>;
}

interface AdmittedClaim {
  readonly challenge: {
    readonly keyEpochRef: string;
    readonly profileRevisionId: string;
    readonly recoveryIncarnationRef: string;
  };
  readonly principalId: string;
  readonly sessionCredential: string;
}

const CLAIM_BASE_KEYS = [
  "capabilities", "expiresAt", "ok", "principalId", "projectId", "protocolVersion",
  "sessionCredential",
] as const;
const CLAIM_KEYS = [...CLAIM_BASE_KEYS, "challenge"] as const;
const CHALLENGE_KEYS = ["keyEpochRef", "profileRevisionId", "recoveryIncarnationRef"] as const;
const OPEN_RESULT_KEYS = ["ok", "protocolVersion", "sessionId"] as const;
const TRANSPORT_ID = "control-room.v1";
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RETRY: LiveKeyedRetry = Object.freeze({ status: "RETRY_CLAIM" as const });

function refuse(detail: string): LiveKeyedRefused {
  return Object.freeze({ code: "LIVE_PAIRING_REFUSED" as const, detail, ok: false as const });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_INSTANT.test(value)
    && Number.isFinite(Date.parse(value));
}

function retryable(result: LiveKeyedPostResult): boolean {
  if (result.status !== 409 || !isRecord(result.body)) return false;
  return exactKeys(result.body, ["code", "layer"])
    && result.body["layer"] === "CONTROL_ROOM_PAIRING_APPROVAL"
    && (result.body["code"] === "PAIRING_APPROVAL_REQUIRED"
      || result.body["code"] === "PAIRING_REQUEST_BUSY");
}

function admitClaim(
  body: unknown,
  input: LiveKeyedSessionInput,
): AdmittedClaim | "CHALLENGE" | "PROJECT" | null {
  if (!isRecord(body)) return null;
  if (exactKeys(body, CLAIM_BASE_KEYS)) return "CHALLENGE";
  if (!exactKeys(body, CLAIM_KEYS)
    || body["ok"] !== true
    || !Array.isArray(body["capabilities"]) || body["capabilities"].length === 0
    || !body["capabilities"].every(nonBlank)
    || !isIsoInstant(body["expiresAt"])
    || !nonBlank(body["principalId"]) || !nonBlank(body["sessionCredential"])
    || body["protocolVersion"] !== input.protocolVersion) return null;
  if (!nonBlank(body["projectId"]) || body["projectId"] !== input.projectId) return "PROJECT";
  const challenge = body["challenge"];
  if (!isRecord(challenge) || !exactKeys(challenge, CHALLENGE_KEYS)
    || !CHALLENGE_KEYS.every((key) => nonBlank(challenge[key]))) return "CHALLENGE";
  return Object.freeze({
    challenge: Object.freeze({
      keyEpochRef: challenge["keyEpochRef"] as string,
      profileRevisionId: challenge["profileRevisionId"] as string,
      recoveryIncarnationRef: challenge["recoveryIncarnationRef"] as string,
    }),
    principalId: body["principalId"],
    sessionCredential: body["sessionCredential"],
  });
}

function randomHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function openIds(): Readonly<Record<"commandId" | "correlationId" | "credentialId" | "sessionId", string>> {
  return Object.freeze({
    commandId: `command-${randomHex()}`,
    correlationId: `correlation-${randomHex()}`,
    credentialId: `credential-${randomHex()}`,
    sessionId: `session-${randomHex()}`,
  });
}

async function buildOpen(
  claim: AdmittedClaim,
  input: LiveKeyedSessionInput,
  key: SessionKeyGenerated,
): Promise<Readonly<Record<string, unknown>>> {
  const ids = openIds();
  const transportIds = Object.freeze([TRANSPORT_ID]);
  const requestDigest = await openSessionRequestDigest({
    clientKeyId: key.clientKeyId, credentialId: ids.credentialId, generation: 1,
    kind: "OPEN_SESSION", principalId: claim.principalId,
    profileRevisionId: claim.challenge.profileRevisionId, projectId: input.projectId,
    publicKeySpkiHex: key.publicKeySpkiHex, sessionId: ids.sessionId,
    transportId: TRANSPORT_ID, transportIds,
  });
  const issuedAt = Date.now();
  const nonce = randomHex();
  const proofBytes = canonicalSessionProofBytes({
    clientKeyId: key.clientKeyId, credentialId: ids.credentialId, generation: 1, issuedAt,
    keyEpochRef: claim.challenge.keyEpochRef, nonce, principalId: claim.principalId,
    projectId: input.projectId, recoveryIncarnationRef: claim.challenge.recoveryIncarnationRef,
    requestDigest, requestId: ids.commandId, sessionId: ids.sessionId,
    transportId: TRANSPORT_ID,
  });
  // The shared canonicalizer is lib-agnostic and returns ArrayBufferLike-backed bytes;
  // copying makes the browser DOM BufferSource guarantee explicit at this edge.
  const signatureHex = await signSessionChallenge(key.privateKey, Uint8Array.from(proofBytes));
  return Object.freeze({
    clientKeyId: key.clientKeyId, commandId: ids.commandId, correlationId: ids.correlationId,
    credentialId: ids.credentialId, principalId: claim.principalId,
    proof: Object.freeze({ algorithm: SESSION_PROOF_ALGORITHM, issuedAt, nonce,
      protocolVersion: SESSION_PROOF_PROTOCOL_VERSION, signatureHex }),
    publicKeySpkiHex: key.publicKeySpkiHex, requestDigest, sessionId: ids.sessionId,
    transportId: TRANSPORT_ID, transportIds,
  });
}

export function createLiveKeyedSession(input: LiveKeyedSessionInput): LiveKeyedSession {
  let keyPromise: Promise<SessionKeyGenerated> | null = null;
  const sessionKey = (): Promise<SessionKeyGenerated> => {
    keyPromise ??= generateSessionKey().then((result) => {
      if (!result.ok) throw new Error("session key unavailable");
      return result;
    });
    return keyPromise;
  };
  return Object.freeze({
    claimAndOpen: async (): Promise<LiveKeyedSessionResult> => {
      let key: SessionKeyGenerated;
      try { key = await sessionKey(); }
      catch { return refuse("session key generation refused"); }
      let claimed: LiveKeyedPostResult;
      try {
        claimed = await input.post("/session/pair/claim", {
          publicKeySpkiHex: key.publicKeySpkiHex, requestId: input.requestId,
        });
      } catch { return refuse("session pairing claim refused"); }
      if (!claimed.ok) {
        return retryable(claimed) ? RETRY
          : refuse(claimed.detail ?? "session pairing claim refused");
      }
      const claim = admitClaim(claimed.body, input);
      if (claim === "CHALLENGE") return refuse("session pairing challenge refused");
      if (claim === "PROJECT") return refuse("session pairing project mismatch");
      if (claim === null) return refuse("session pairing claim refused");
      let openBody: Readonly<Record<string, unknown>>;
      try { openBody = await buildOpen(claim, input, key); }
      catch { return refuse("session pairing proof refused"); }
      let opened: LiveKeyedPostResult;
      try { opened = await input.post("/session/pair/open", openBody); }
      catch { return refuse("session pairing open refused"); }
      if (!opened.ok) return refuse(opened.detail ?? "session pairing open refused");
      if (!isRecord(opened.body) || !exactKeys(opened.body, OPEN_RESULT_KEYS)
        || opened.body["ok"] !== true || opened.body["protocolVersion"] !== input.protocolVersion
        || opened.body["sessionId"] !== openBody["sessionId"]) {
        return refuse("session pairing open refused");
      }
      return Object.freeze({ ok: true as const, sessionCredential: claim.sessionCredential });
    },
  });
}
