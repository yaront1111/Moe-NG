import { decodeBoundedJsonBytes } from "../bounded-json.js";
import type { JsonObject } from "../bounded-json-model.js";
import { MAX_JSON_BODY_BYTES, MAX_JSON_DEPTH, MAX_JSON_STRING_UTF8_BYTES } from "../input-limits.js";
import { createRuntimeError } from "./runtime-error-factory.js";
import type { RuntimeError } from "./runtime-error-factory.js";
import {
  hasExactKeys,
  isHex64,
  isNonEmptyString,
  isPlainRecord,
  isSafeCount,
  parseLeaseAuthority,
} from "./runtime-guards.js";
import type { RuntimeLeaseAuthority } from "./runtime-guards.js";
import {
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION,
  isCommandKind,
  isQueryKind,
} from "./runtime-vocabulary.js";
import type { RuntimeCommandKind, RuntimeQueryKind } from "./runtime-vocabulary.js";

export interface RuntimeCommandEnvelope {
  readonly commandId: string;
  readonly commandKind: RuntimeCommandKind;
  readonly correlationId: string;
  readonly expectedVersion: number;
  readonly graphRevisionHash?: string;
  readonly leaseAuthority?: RuntimeLeaseAuthority;
  readonly payload: JsonObject;
  readonly policyRevisionHash?: string;
  readonly requestDigest: string;
  readonly schemaVersion: typeof RUNTIME_COMMAND_ENVELOPE_VERSION;
  readonly sessionCredential: string;
  readonly targetAggregateId: string;
}

export interface RuntimeQueryEnvelope {
  readonly correlationId: string;
  readonly cursor?: string;
  readonly payload: JsonObject;
  readonly queryKind: RuntimeQueryKind;
  readonly schemaVersion: typeof RUNTIME_QUERY_ENVELOPE_VERSION;
  readonly sessionCredential: string;
  readonly targetAggregateId?: string;
}

export type RuntimeCommandEnvelopeResult =
  | { readonly ok: true; readonly envelope: RuntimeCommandEnvelope }
  | { readonly error: RuntimeError; readonly ok: false };

export type RuntimeQueryEnvelopeResult =
  | { readonly ok: true; readonly envelope: RuntimeQueryEnvelope }
  | { readonly error: RuntimeError; readonly ok: false };

const COMMAND_REQUIRED = Object.freeze([
  "commandId", "commandKind", "correlationId", "expectedVersion", "payload", "requestDigest",
  "schemaVersion", "sessionCredential", "targetAggregateId",
] as const);
const COMMAND_OPTIONAL = Object.freeze([
  "graphRevisionHash", "leaseAuthority", "policyRevisionHash",
] as const);
const QUERY_REQUIRED = Object.freeze([
  "correlationId", "payload", "queryKind", "schemaVersion", "sessionCredential",
] as const);
const QUERY_OPTIONAL = Object.freeze(["cursor", "targetAggregateId"] as const);
const REVISION_KEYS = Object.freeze(["graphRevisionHash", "policyRevisionHash"] as const);

const LIMIT_DETAILS: Readonly<Record<string, { limitBytes: number; limitName: string }>> =
  Object.freeze({
    JSON_BODY_LIMIT_EXCEEDED: Object.freeze({
      limitBytes: MAX_JSON_BODY_BYTES, limitName: "JSON_BODY_BYTES",
    }),
    JSON_DEPTH_LIMIT_EXCEEDED: Object.freeze({
      limitBytes: MAX_JSON_DEPTH, limitName: "JSON_DEPTH",
    }),
    JSON_STRING_LIMIT_EXCEEDED: Object.freeze({
      limitBytes: MAX_JSON_STRING_UTF8_BYTES, limitName: "JSON_STRING_UTF8_BYTES",
    }),
  });

function invalidInput(): RuntimeError {
  return createRuntimeError({ code: "INPUT_INVALID" });
}

function unsupportedVersion(supported: string): RuntimeError {
  return createRuntimeError({
    code: "SCHEMA_VERSION_UNSUPPORTED",
    details: { supportedSchemaVersion: supported },
  });
}

/** Bounded resource refusals stay `INPUT_LIMIT_EXCEEDED`; everything else is shape-invalid. */
function fromBoundedJsonCode(code: string): RuntimeError {
  const details = LIMIT_DETAILS[code];
  if (details === undefined) return invalidInput();
  return createRuntimeError({ code: "INPUT_LIMIT_EXCEEDED", details });
}

type BodyResult =
  | { readonly ok: true; readonly record: Readonly<Record<string, unknown>> }
  | { readonly error: RuntimeError; readonly ok: false };

function decodeBody(input: unknown): BodyResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) return { error: fromBoundedJsonCode(decoded.code), ok: false };
  if (!isPlainRecord(decoded.value)) return { error: invalidInput(), ok: false };
  return { ok: true, record: decoded.value };
}

function commandFailure(error: RuntimeError): RuntimeCommandEnvelopeResult {
  return Object.freeze({ error, ok: false as const });
}

function queryFailure(error: RuntimeError): RuntimeQueryEnvelopeResult {
  return Object.freeze({ error, ok: false as const });
}

function identifiersValid(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => isNonEmptyString(record[key]));
}

/**
 * Decodes hostile bytes into one immutable authoritative command envelope. Composes
 * `decodeBoundedJsonBytes`, so its 1 MiB body, depth 64, 256 KiB string, duplicate-key,
 * and interoperable-number rules apply unchanged before any schema inspection.
 */
export function decodeRuntimeCommandEnvelopeBytes(input: unknown): RuntimeCommandEnvelopeResult {
  const body = decodeBody(input);
  if (!body.ok) return commandFailure(body.error);

  const record = body.record;
  if (record["schemaVersion"] !== RUNTIME_COMMAND_ENVELOPE_VERSION) {
    return commandFailure(unsupportedVersion(RUNTIME_COMMAND_ENVELOPE_VERSION));
  }
  if (!hasExactKeys(record, COMMAND_REQUIRED, COMMAND_OPTIONAL)) {
    return commandFailure(invalidInput());
  }
  if (!isCommandKind(record["commandKind"])) return commandFailure(invalidInput());
  if (!identifiersValid(record, ["commandId", "correlationId", "sessionCredential",
    "targetAggregateId"])) {
    return commandFailure(invalidInput());
  }
  if (!isHex64(record["requestDigest"])) return commandFailure(invalidInput());

  const draft: Record<string, unknown> = {
    commandId: record["commandId"],
    commandKind: record["commandKind"],
    correlationId: record["correlationId"],
    requestDigest: record["requestDigest"],
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: record["sessionCredential"],
    targetAggregateId: record["targetAggregateId"],
  };
  for (const key of REVISION_KEYS) {
    if (!Object.hasOwn(record, key)) continue;
    if (!isHex64(record[key])) return commandFailure(invalidInput());
    draft[key] = record[key];
  }
  if (!isSafeCount(record["expectedVersion"])) return commandFailure(invalidInput());
  draft["expectedVersion"] = record["expectedVersion"];
  if (Object.hasOwn(record, "leaseAuthority")) {
    const lease = parseLeaseAuthority(record["leaseAuthority"]);
    if (lease === undefined) return commandFailure(invalidInput());
    draft["leaseAuthority"] = lease;
  }
  if (!isPlainRecord(record["payload"])) return commandFailure(invalidInput());
  draft["payload"] = record["payload"];

  const envelope = Object.freeze(draft) as unknown as RuntimeCommandEnvelope;
  return Object.freeze({ envelope, ok: true as const });
}

/**
 * Decodes hostile bytes into one read-only query envelope. Mutation-only version,
 * lease, revision, and command fields are refused outright, so a query can never
 * smuggle authority through the read surface.
 */
export function decodeRuntimeQueryEnvelopeBytes(input: unknown): RuntimeQueryEnvelopeResult {
  const body = decodeBody(input);
  if (!body.ok) return queryFailure(body.error);

  const record = body.record;
  if (record["schemaVersion"] !== RUNTIME_QUERY_ENVELOPE_VERSION) {
    return queryFailure(unsupportedVersion(RUNTIME_QUERY_ENVELOPE_VERSION));
  }
  if (!hasExactKeys(record, QUERY_REQUIRED, QUERY_OPTIONAL)) return queryFailure(invalidInput());
  if (!isQueryKind(record["queryKind"])) return queryFailure(invalidInput());
  if (!identifiersValid(record, ["correlationId", "sessionCredential"])) {
    return queryFailure(invalidInput());
  }

  const draft: Record<string, unknown> = {
    correlationId: record["correlationId"],
    queryKind: record["queryKind"],
    schemaVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
    sessionCredential: record["sessionCredential"],
  };
  for (const key of ["cursor", "targetAggregateId"] as const) {
    if (!Object.hasOwn(record, key)) continue;
    if (!isNonEmptyString(record[key])) return queryFailure(invalidInput());
    draft[key] = record[key];
  }
  if (!isPlainRecord(record["payload"])) return queryFailure(invalidInput());
  draft["payload"] = record["payload"];

  const envelope = Object.freeze(draft) as unknown as RuntimeQueryEnvelope;
  return Object.freeze({ envelope, ok: true as const });
}
