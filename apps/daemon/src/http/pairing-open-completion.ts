import type {
  SessionMutationResult,
} from "../identity/session-authority-contracts.js";

/**
 * THE OPEN COMPLETION, step 4 of ruling `comment-d3a24ac8`.
 *
 * The approved claim disclosed the challenge operands; the browser signed them; this
 * route carries the finished proof to `openSession` and NOTHING ELSE. It is deliberately
 * not a second verifier:
 *
 *  - it validates SHAPE — an exact key roster, bounded ids, a body cap — so a malformed
 *    payload is refused here rather than deep inside the authority;
 *  - it verifies NOTHING — no signature, no digest, no challenge derivation. The sole
 *    verifier stays `verifySessionProofOverChallenge` at `session-authority.ts:171`;
 *  - it RESTAMPS nothing — every `openSession` refusal travels out with the authority's
 *    own code and layer, so a caller learns which fence refused rather than a
 *    route-local synonym for "no".
 *
 * A second verification here would be worse than redundant: two implementations of one
 * security check drift, and the weaker one becomes the real bound.
 */
export const PAIRING_OPEN_PATH = "/session/pair/open" as const;

/**
 * The completion body's own bound, again SEPARATE from the claim's 1024 rather than a
 * reuse of it. A completion carries the whole signed open request — three 64-hex ids,
 * an 88-hex key, a transport roster and a proof whose signature alone is 128 hex — so
 * it is measurably larger than a claim, and sharing one constant would mean a change to
 * either route silently moved the other's bound.
 */
export const PAIRING_OPEN_MAX_BODY_BYTES = 2048;

export const PAIRING_OPEN_LAYER = "CONTROL_ROOM_PAIRING_OPEN" as const;

/**
 * ROUTE-LOCAL codes, and there are only two. Both are facts about the BODY this route
 * was handed. Everything about the session — the key, the digest, the signature, replay
 * — is the authority's question and answers with the authority's own code.
 */
export const PAIRING_OPEN_REFUSAL_CODES = Object.freeze([
  "PAIRING_OPEN_BODY_TOO_LARGE",
  "PAIRING_OPEN_REQUEST_INVALID",
] as const);

export type PairingOpenRefusalCode = (typeof PAIRING_OPEN_REFUSAL_CODES)[number];

/**
 * Exactly what `openSession` reads (`session-authority.ts:48-51`, `OPEN_KEYS`), so a
 * body that passes here is one the authority can read without a second normalisation
 * step. `readExactRecord` there is exact-arity too: keeping the two rosters identical is
 * what stops this route from silently accepting a field the authority would reject.
 */
export const PAIRING_OPEN_KEYS: readonly string[] = Object.freeze([
  "clientKeyId", "commandId", "correlationId", "credentialId", "principalId", "proof",
  "publicKeySpkiHex", "requestDigest", "sessionId", "transportId", "transportIds",
]);

export interface PairingOpenRefused {
  readonly code: PairingOpenRefusalCode;
  readonly layer: typeof PAIRING_OPEN_LAYER;
  readonly ok: false;
}

/** Only what `openSession` itself answered; this route adds no field of its own. */
export interface PairingOpenCompleted {
  readonly ok: true;
  readonly sessionId: string;
}

export type PairingOpenResult =
  | PairingOpenCompleted
  | PairingOpenRefused
  | SessionMutationResult;

/** The one authority capability this route composes. */
export interface PairingOpenSessionPort {
  openSession(input: unknown): SessionMutationResult;
}

export interface PairingOpenCompletionPort {
  complete(body: Uint8Array): PairingOpenResult;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const BOUNDED_ID = /^[\w.:-]{1,128}$/u;

function refuse(code: PairingOpenRefusalCode): PairingOpenRefused {
  return Object.freeze({ code, layer: PAIRING_OPEN_LAYER, ok: false as const });
}

function exactRoster(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === PAIRING_OPEN_KEYS.length
    && PAIRING_OPEN_KEYS.every((key, index) => keys[index] === key);
}

/**
 * SHAPE ONLY. Every id is bounded and every hex-shaped field is left to the authority,
 * which owns the formats it will verify against. Widening a check here would create a
 * second, weaker definition of a session identifier.
 */
function shapeOk(record: Record<string, unknown>): boolean {
  const bounded = ["commandId", "correlationId", "credentialId", "principalId", "sessionId",
    "transportId"];
  if (!bounded.every((key) => typeof record[key] === "string"
    && BOUNDED_ID.test(record[key] as string))) return false;
  const transportIds = record["transportIds"];
  if (!Array.isArray(transportIds) || transportIds.length === 0) return false;
  if (!transportIds.every((id) => typeof id === "string" && BOUNDED_ID.test(id))) return false;
  const proof = record["proof"];
  return typeof record["clientKeyId"] === "string"
    && typeof record["publicKeySpkiHex"] === "string"
    && typeof record["requestDigest"] === "string"
    && typeof proof === "object" && proof !== null && !Array.isArray(proof);
}

/**
 * Status is transport metadata; the stable code and layer travel unchanged beneath it.
 *
 * Only three codes are named. The rest of the space belongs to `openSession`, whose
 * refusal roster this route deliberately does not mirror — a second enumeration here
 * would drift from the authority's and start answering a status for a code the
 * authority no longer emits. The default is 400 because every unnamed refusal is the
 * authority declining THIS request; it is never 5xx, which would report daemon health
 * this route has not measured.
 */
export function pairingOpenStatusFor(code: string): number {
  if (code === "PAIRING_OPEN_BODY_TOO_LARGE") return 413;
  if (code === "AUTHENTICATION_FAILED") return 401;
  return 400;
}

export function createPairingOpenCompletion(
  sessions: PairingOpenSessionPort,
): PairingOpenCompletionPort {
  return Object.freeze({
    complete: (body: Uint8Array): PairingOpenResult => {
      if (body.byteLength > PAIRING_OPEN_MAX_BODY_BYTES) {
        return refuse("PAIRING_OPEN_BODY_TOO_LARGE");
      }
      let record: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(decoder.decode(body));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return refuse("PAIRING_OPEN_REQUEST_INVALID");
        }
        record = parsed as Record<string, unknown>;
      } catch {
        return refuse("PAIRING_OPEN_REQUEST_INVALID");
      }
      if (!exactRoster(record) || !shapeOk(record)) {
        return refuse("PAIRING_OPEN_REQUEST_INVALID");
      }
      // COMPOSED VERBATIM. The vetted record goes in unchanged and whatever comes back
      // goes out unchanged: no restamping, no re-verification, no field of ours added
      // to a refusal. A caller that is refused learns the authority's own code+layer.
      const opened = sessions.openSession(record);
      return opened.ok
        ? Object.freeze({ ok: true as const, sessionId: opened.authority.session.sessionId })
        : opened;
    },
  });
}
