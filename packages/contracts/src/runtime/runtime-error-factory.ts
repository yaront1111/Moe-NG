import { EMPTY_NEXT_ALLOWED_COMMANDS } from "./runtime-affordance.js";
import type { NextAllowedCommand } from "./runtime-affordance.js";
import { hasExactKeys, isPlainRecord } from "./runtime-guards.js";
import {
  UNKNOWN_ERROR_DESCRIPTOR,
  lookupRuntimeError,
} from "./runtime-error-registry.js";
import type {
  RuntimeErrorCode,
  RuntimeErrorDescriptor,
  RuntimeRecoveryCategory,
  RuntimeRetryability,
  RuntimeTransportBinding,
} from "./runtime-error-registry.js";
import { RUNTIME_ERROR_REGISTRY_VERSION, isKnownLifecycleSource } from "./runtime-vocabulary.js";
import type { RuntimeCommandKind, RuntimeTruthClass } from "./runtime-vocabulary.js";

export type RuntimeErrorDetails = Readonly<Record<string, boolean | number | string>>;

export interface RuntimeError {
  readonly code: RuntimeErrorCode;
  readonly correlationId: string | null;
  readonly details: RuntimeErrorDetails;
  readonly nextAllowedCommands: readonly NextAllowedCommand[];
  readonly recoveryCategory: RuntimeRecoveryCategory;
  readonly recoveryCommands: readonly RuntimeCommandKind[];
  readonly registryVersion: typeof RUNTIME_ERROR_REGISTRY_VERSION;
  readonly retryability: RuntimeRetryability;
  readonly transport: RuntimeTransportBinding;
  readonly truthClass: RuntimeTruthClass;
}

const CODE_KEY = Object.freeze(["code"] as const);
const OPTIONAL_KEYS = Object.freeze(["correlationId", "details", "source"] as const);
const SAFE_SCALAR = /^[A-Za-z0-9._:/-]{1,64}$/;
const EMPTY_DETAILS: RuntimeErrorDetails = Object.freeze(
  Object.create(null) as Record<string, boolean | number | string>,
);

function safeScalar(value: unknown): boolean | number | string | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value === "string" && SAFE_SCALAR.test(value)) return value;
  return undefined;
}

/** Copies only this code's allowlisted keys, and only bounded safe scalar values. */
function sanitizeDetails(descriptor: RuntimeErrorDescriptor, details: unknown): RuntimeErrorDetails {
  if (!isPlainRecord(details) || descriptor.requiredDetailKeys.length === 0) return EMPTY_DETAILS;
  const record = Object.create(null) as Record<string, boolean | number | string>;
  for (const key of descriptor.requiredDetailKeys) {
    if (!Object.hasOwn(details, key)) continue;
    const value = safeScalar(details[key]);
    if (value !== undefined) record[key] = value;
  }
  return Object.freeze(record);
}

function build(
  descriptor: RuntimeErrorDescriptor,
  correlationId: string | null,
  details: RuntimeErrorDetails,
): RuntimeError {
  return Object.freeze({
    code: descriptor.code,
    correlationId,
    details,
    nextAllowedCommands: EMPTY_NEXT_ALLOWED_COMMANDS,
    recoveryCategory: descriptor.recoveryCategory,
    recoveryCommands: descriptor.recoveryCommands,
    registryVersion: RUNTIME_ERROR_REGISTRY_VERSION,
    retryability: descriptor.retryability,
    transport: descriptor.transport,
    truthClass: descriptor.truthClass,
  });
}

/** Boundary codes declare no valid lifecycle source and must be raised without one. */
function sourceAccepted(
  descriptor: RuntimeErrorDescriptor,
  input: Readonly<Record<string, unknown>>,
): boolean {
  if (!Object.hasOwn(input, "source")) return descriptor.validSources.length === 0;
  const source = input["source"];
  return isKnownLifecycleSource(source) && descriptor.validSources.includes(source.aggregate);
}

/**
 * Builds a stable error. Unknown code, unknown or mismatched lifecycle source, and
 * malformed input all fail closed to `UNKNOWN_ERROR` with truth `UNKNOWN`, no details,
 * and no recovery or mutation affordance. Attacker bytes are never reflected.
 */
export function createRuntimeError(input: unknown): RuntimeError {
  if (!isPlainRecord(input) || !hasExactKeys(input, CODE_KEY, OPTIONAL_KEYS)) {
    return build(UNKNOWN_ERROR_DESCRIPTOR, null, EMPTY_DETAILS);
  }
  const raw = input["correlationId"];
  const correlationId = typeof raw === "string" && SAFE_SCALAR.test(raw) ? raw : null;
  const descriptor = lookupRuntimeError(input["code"]);
  if (descriptor === UNKNOWN_ERROR_DESCRIPTOR || !sourceAccepted(descriptor, input)) {
    return build(UNKNOWN_ERROR_DESCRIPTOR, correlationId, EMPTY_DETAILS);
  }
  return build(descriptor, correlationId, sanitizeDetails(descriptor, input["details"]));
}
