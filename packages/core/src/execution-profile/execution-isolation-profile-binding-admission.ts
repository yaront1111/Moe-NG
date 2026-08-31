import { exact, validHex64 } from "../planning/planning-snapshot.js";
import {
  EXECUTION_ISOLATION_PROFILE_LIMITS,
  executionIsolationProfileRefusal,
  type ExecutionIsolationCredentialBrokerRef,
  type ExecutionIsolationImageRef,
  type ExecutionIsolationProfileRefusal,
  type ExecutionIsolationToolRef,
} from "./execution-isolation-profile-contract.js";

export type ExecutionIsolationReadResult<T> =
  | Readonly<{ ok: true; value: T }>
  | ExecutionIsolationProfileRefusal;

const encoder = new TextEncoder();
const BROKER_KEYS = Object.freeze(["brokerRef", "maximumCredentialTtlMs"]);
const IMAGE_KEYS = Object.freeze(["imageDigest", "imageRef"]);
const TOOL_KEYS = Object.freeze(["toolDigest", "toolRef"]);
const BROKER_REF = /^broker:[a-z0-9][a-z0-9._-]{0,255}$/u;
const IMAGE_REF = /^image:[a-z0-9][a-z0-9._-]{0,255}$/u;
const TOOL_REF = /^tool:[a-z0-9][a-z0-9._-]{0,255}$/u;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

const malformed = (): ExecutionIsolationProfileRefusal => executionIsolationProfileRefusal(
  "EXECUTION_ISOLATION_PROFILE_MALFORMED", "EXECUTION_ISOLATION_PROFILE_ADMISSION",
);
const exceeded = (): ExecutionIsolationProfileRefusal => executionIsolationProfileRefusal(
  "EXECUTION_ISOLATION_PROFILE_LIMIT_EXCEEDED", "EXECUTION_ISOLATION_PROFILE_LIMITS",
);
const bindingInvalid = (): ExecutionIsolationProfileRefusal => executionIsolationProfileRefusal(
  "EXECUTION_ISOLATION_PROFILE_BINDING_INVALID", "EXECUTION_ISOLATION_PROFILE_BINDING",
);
const success = <T>(value: T): Readonly<{ ok: true; value: T }> =>
  Object.freeze({ ok: true as const, value });

export function readExecutionIsolationRef(value: unknown): ExecutionIsolationReadResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || CONTROL.test(value) || !value.isWellFormed() || value.normalize("NFC") !== value) {
    return malformed();
  }
  return encoder.encode(value).byteLength <= EXECUTION_ISOLATION_PROFILE_LIMITS.maxRefBytes
    ? success(value) : exceeded();
}

export function readExecutionIsolationCredentialBroker(
  value: unknown,
): ExecutionIsolationReadResult<ExecutionIsolationCredentialBrokerRef> {
  const invalid = (): ExecutionIsolationProfileRefusal => executionIsolationProfileRefusal(
    "EXECUTION_ISOLATION_PROFILE_CREDENTIAL_BROKER_INVALID",
    "EXECUTION_ISOLATION_PROFILE_CREDENTIAL_BROKER",
  );
  if (!exact(value, BROKER_KEYS)) return invalid();
  const brokerRef = value["brokerRef"];
  const ttl = value["maximumCredentialTtlMs"];
  if (typeof brokerRef !== "string" || !BROKER_REF.test(brokerRef)
    || !Number.isSafeInteger(ttl)
    || (ttl as number) < EXECUTION_ISOLATION_PROFILE_LIMITS.minCredentialTtlMs
    || (ttl as number) > EXECUTION_ISOLATION_PROFILE_LIMITS.maxCredentialTtlMs) return invalid();
  return success(Object.freeze({ brokerRef, maximumCredentialTtlMs: ttl as number }));
}

export function readExecutionIsolationImage(
  value: unknown,
): ExecutionIsolationReadResult<ExecutionIsolationImageRef> {
  if (!exact(value, IMAGE_KEYS) || typeof value["imageRef"] !== "string"
    || !IMAGE_REF.test(value["imageRef"]) || typeof value["imageDigest"] !== "string"
    || !OCI_DIGEST.test(value["imageDigest"])) return bindingInvalid();
  return success(Object.freeze({
    imageDigest: value["imageDigest"], imageRef: value["imageRef"],
  }));
}

export function readExecutionIsolationTools(
  value: unknown,
): ExecutionIsolationReadResult<readonly ExecutionIsolationToolRef[]> {
  if (!Array.isArray(value) || value.length === 0) return bindingInvalid();
  if (value.length > EXECUTION_ISOLATION_PROFILE_LIMITS.maxTools) return exceeded();
  const tools: ExecutionIsolationToolRef[] = [];
  for (const candidate of value) {
    if (!exact(candidate, TOOL_KEYS) || typeof candidate["toolRef"] !== "string"
      || !TOOL_REF.test(candidate["toolRef"]) || !validHex64(candidate["toolDigest"])) {
      return bindingInvalid();
    }
    const previous = tools.at(-1);
    if (previous !== undefined && previous.toolRef >= candidate["toolRef"]) return bindingInvalid();
    tools.push(Object.freeze({
      toolDigest: candidate["toolDigest"], toolRef: candidate["toolRef"],
    }));
  }
  return success(Object.freeze(tools));
}
