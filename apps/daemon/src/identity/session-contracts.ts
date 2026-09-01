import { decodeBoundedJsonBytes } from "@moe/contracts";
import type {
  BoundedJsonDecodeError,
  JsonObject,
  JsonValue,
  RuntimeCommandKind,
} from "@moe/contracts";

/**
 * Byte ingress for the session-lifecycle command surface.
 *
 * This module is a trust boundary and nothing more: it decides only whether an input is a
 * well-formed envelope naming a command this surface owns. Session state questions — does the
 * session exist, is it closed, does the expected version match — belong to the durable gate in
 * `session-services.ts`, so refusals raised here carry `refusedBy: "DAEMON_INGRESS"`.
 *
 * SECRETS NEVER CROSS THIS BOUNDARY. `session.open` carries `credentialSha256` — the lowercase
 * 64-hex sha256 of a bearer credential the CLIENT generated and kept — never the credential
 * itself. The ledger therefore stores only the hash, and a full read of the durable log yields
 * nothing replayable as a credential. The one place the plaintext credential ever appears is the
 * transport header that `createSessionAuthenticator` hashes and discards.
 *
 * WHY THIS SURFACE OWNS ITS OWN KIND LIST RATHER THAN EXTENDING `BOOTSTRAP_COMMAND_KINDS`:
 * `bootstrap-sequence.ts`'s `COMMAND_PREREQUISITES` is a TOTAL record over the bootstrap kinds
 * and two bootstrap suites assert that list's exact length, so appending there reddens files this
 * task does not own. A domain-scoped vocabulary is the house shape — `review/review-contracts.ts`
 * carries the same structure — and the envelope, refusal taxonomy and decode order are copied
 * from it exactly so the two READ the same.
 */

export const SESSION_SCHEMA_VERSION = "moe-session-command/1" as const;

/**
 * The three kinds this surface owns. `satisfies readonly RuntimeCommandKind[]` makes a typo a
 * build failure and proves every member already exists in the runtime vocabulary. `session.rotate`
 * is deliberately absent: credential rotation is `@moe/core`'s `rotateCredential` authority and
 * has no durable handler yet.
 */
export const SESSION_COMMAND_KINDS = Object.freeze([
  "session.close",
  "session.open",
  "session.renew",
] as const satisfies readonly RuntimeCommandKind[]);

export type SessionCommandKind = (typeof SESSION_COMMAND_KINDS)[number];

export const SESSION_REQUEST_KEYS = Object.freeze([
  "commandId",
  "correlationId",
  "decidedAt",
  "expectedVersion",
  "kind",
  "payload",
  "principalId",
  "projectId",
  "schemaVersion",
] as const);

/**
 * Codes the ingress layer may emit. The two payload-fact codes are here rather than in the
 * prerequisite vocabulary because they judge the SHAPE of a payload field, not durable state:
 * a malformed hash or an unparseable expiry is refusable before any ledger read.
 */
export const SESSION_INGRESS_REFUSAL_CODES = Object.freeze([
  "SESSION_INPUT_REJECTED",
  "SESSION_REQUEST_INVALID",
  "SESSION_COMMAND_UNKNOWN",
  "SESSION_PAYLOAD_INVALID",
  "SESSION_ID_RESERVED",
  "SESSION_CREDENTIAL_HASH_INVALID",
  "SESSION_EXPIRED_AT_INVALID",
] as const);

export type SessionIngressRefusalCode = (typeof SESSION_INGRESS_REFUSAL_CODES)[number];

/**
 * Refusals owned by the daemon's durable gate. `SESSION_LEDGER_UNREADABLE` is the fail-closed
 * arm for stored bytes that do not parse as session facts: falling back to "no such session"
 * would let a corrupted open-record be silently re-opened under the same id.
 */
export const SESSION_PREREQUISITE_REFUSAL_CODES = Object.freeze([
  "SESSION_COMMAND_ID_REUSED",
  "SESSION_EXPECTED_VERSION_STALE",
  "SESSION_LEDGER_UNREADABLE",
  "SESSION_RECOVERY_BINDING_UNAVAILABLE",
  "SESSION_NOT_FOUND",
  "SESSION_ALREADY_CLOSED",
  "SESSION_ALREADY_OPEN",
  // One deliberately undifferentiated code for absent / foreign-project / CLOSED on the
  // credential-digest read: distinct codes would make that reader a cross-project
  // session-existence oracle. Widening this union is compile-safe — `refuse` in
  // session-ledger.ts types daemon-layer emissions FROM it, so no existing site narrows on it.
  "SESSION_CREDENTIAL_DIGEST_UNAVAILABLE",
] as const);

export type SessionPrerequisiteRefusalCode = (typeof SESSION_PREREQUISITE_REFUSAL_CODES)[number];

/** The layer that answered. Three can refuse, so evidence must name which one did. */
export const SESSION_REFUSED_BY = Object.freeze([
  "DAEMON_INGRESS",
  "DAEMON_PREREQUISITE",
  "DURABLE_STORE",
] as const);

export type SessionRefusedBy = (typeof SESSION_REFUSED_BY)[number];

/** Lowercase 64-hex sha256 — the only credential fact the wire or the ledger ever sees. */
export const CREDENTIAL_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function isCredentialSha256(value: JsonValue | undefined): value is string {
  return typeof value === "string" && CREDENTIAL_SHA256_PATTERN.test(value);
}

/**
 * The canonical zoned ISO-8601 instant, and only that. `Date.parse` alone also
 * accepts zone-less and plain-English dates whose epoch millisecond depends on
 * the HOST timezone — a session must not expire at a different moment because
 * the daemon moved machines. Same rule as work-claim-contracts.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function isIsoInstant(value: JsonValue | undefined): value is string {
  return typeof value === "string" && ISO_INSTANT.test(value)
    && Number.isFinite(Date.parse(value));
}

export interface SessionRequest {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly expectedVersion: number;
  readonly kind: SessionCommandKind;
  readonly payload: JsonObject;
  readonly principalId: string;
  readonly projectId: string;
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
}

export interface SessionInputRejected {
  readonly code: "SESSION_INPUT_REJECTED";
  readonly decodeError: BoundedJsonDecodeError;
  readonly ok: false;
  readonly refusedBy: "DAEMON_INGRESS";
}

export interface SessionRequestRefused {
  readonly code: "SESSION_REQUEST_INVALID" | "SESSION_COMMAND_UNKNOWN";
  readonly ok: false;
  readonly refusedBy: "DAEMON_INGRESS";
}

export interface SessionRequestAccepted {
  readonly ok: true;
  readonly request: SessionRequest;
}

export type SessionDecodeRefusal = SessionInputRejected | SessionRequestRefused;

export type SessionDecodeResult = SessionRequestAccepted | SessionDecodeRefusal;

const REQUEST_INVALID: SessionRequestRefused = Object.freeze({
  code: "SESSION_REQUEST_INVALID",
  ok: false,
  refusedBy: "DAEMON_INGRESS",
});

const COMMAND_UNKNOWN: SessionRequestRefused = Object.freeze({
  code: "SESSION_COMMAND_UNKNOWN",
  ok: false,
  refusedBy: "DAEMON_INGRESS",
});

const KIND_SET: ReadonlySet<string> = new Set<string>(SESSION_COMMAND_KINDS);
const KEY_SET: ReadonlySet<string> = new Set<string>(SESSION_REQUEST_KEYS);

/**
 * `decodeBoundedJsonBytes` yields null-prototype objects, so any other prototype means the value
 * did not come from the bounded decoder and is not trusted here.
 */
export function isPlainJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== null
    && value !== undefined
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === null
  );
}

function isRef(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasExactKeys(request: JsonObject): boolean {
  const keys = Object.keys(request);
  if (keys.length !== SESSION_REQUEST_KEYS.length) return false;
  return keys.every((key) => KEY_SET.has(key));
}

function isSessionKind(value: JsonValue | undefined): value is SessionCommandKind {
  return typeof value === "string" && KIND_SET.has(value);
}

/** Envelope-shape agreement, excluding the kind, which refuses under its own code. */
function isExactEnvelope(request: JsonObject): boolean {
  return (
    hasExactKeys(request)
    && request["schemaVersion"] === SESSION_SCHEMA_VERSION
    && isRef(request["commandId"])
    && isRef(request["correlationId"])
    && isRef(request["decidedAt"])
    && isRef(request["principalId"])
    && isRef(request["projectId"])
    && typeof request["expectedVersion"] === "number"
    && Number.isSafeInteger(request["expectedVersion"])
    && request["expectedVersion"] >= 0
    && isPlainJsonObject(request["payload"])
  );
}

function accepted(request: JsonObject, kind: SessionCommandKind): SessionRequestAccepted {
  return Object.freeze({
    ok: true as const,
    request: Object.freeze({
      commandId: request["commandId"] as string,
      correlationId: request["correlationId"] as string,
      decidedAt: request["decidedAt"] as string,
      expectedVersion: request["expectedVersion"] as number,
      kind,
      payload: request["payload"] as JsonObject,
      principalId: request["principalId"] as string,
      projectId: request["projectId"] as string,
      schemaVersion: SESSION_SCHEMA_VERSION,
    }),
  });
}

/**
 * Decodes request bytes into an owned session command envelope. Decode failures surface the
 * bounded decoder's own error unchanged; translating it would erase which resource bound was
 * exceeded and which layer refused.
 */
export function decodeSessionRequestBytes(input: unknown): SessionDecodeResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) {
    return Object.freeze({
      code: "SESSION_INPUT_REJECTED" as const,
      decodeError: decoded,
      ok: false as const,
      refusedBy: "DAEMON_INGRESS" as const,
    });
  }
  if (!isPlainJsonObject(decoded.value)) return REQUEST_INVALID;

  const request = decoded.value;
  if (!isExactEnvelope(request)) return REQUEST_INVALID;

  const kind = request["kind"];
  if (typeof kind !== "string") return REQUEST_INVALID;
  if (!isSessionKind(kind)) return COMMAND_UNKNOWN;

  return accepted(request, kind);
}
