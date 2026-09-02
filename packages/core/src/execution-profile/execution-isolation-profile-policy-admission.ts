import { exact, validHex64 } from "../planning/planning-snapshot.js";
import {
  EXECUTION_ISOLATION_BUILD_AGENT_MOUNT_SHAPE,
  EXECUTION_ISOLATION_FRESH_VERIFIER_MOUNT_SHAPE,
  EXECUTION_ISOLATION_NETWORK_ACCESS_MODES,
  EXECUTION_ISOLATION_NETWORK_PLANE_IDENTITIES,
  EXECUTION_ISOLATION_PROFILE_FORBIDDEN_HOST_INPUTS,
  EXECUTION_ISOLATION_PROFILE_LIMITS,
  executionIsolationProfileRefusal,
  type ExecutionIsolationEndpointPolicyRef,
  type ExecutionIsolationMount,
  type ExecutionIsolationNetwork,
  type ExecutionIsolationNetworkAccessMode,
  type ExecutionIsolationNetworkPlaneIdentity,
  type ExecutionIsolationProfileRefusal,
  type ExecutionIsolationPurpose,
  type ExecutionIsolationResourceLimits,
} from "./execution-isolation-profile-contract.js";

type ReadResult<T> = Readonly<{ ok: true; value: T }> | ExecutionIsolationProfileRefusal;
const LIMIT_KEYS = Object.freeze([
  "cpuMilliCores", "memoryBytes", "outputBytes", "pids", "wallTimeMs",
] as const);
const MOUNT_KEYS = Object.freeze(["access", "kind", "maxBytes"]);
const NETWORK_KEYS = Object.freeze(["accessMode", "endpointPolicies", "plane"]);
const ENDPOINT_POLICY_KEYS = Object.freeze([
  "endpointPolicyDigest", "endpointPolicyRef", "plane", "purpose",
]);
const POLICY_REF = /^network-policy:[a-z0-9][a-z0-9._-]{0,255}$/u;

const refusal = (
  code: Parameters<typeof executionIsolationProfileRefusal>[0],
  layer: Parameters<typeof executionIsolationProfileRefusal>[1],
): ExecutionIsolationProfileRefusal => executionIsolationProfileRefusal(code, layer);
const malformed = (): ExecutionIsolationProfileRefusal => refusal(
  "EXECUTION_ISOLATION_PROFILE_MALFORMED", "EXECUTION_ISOLATION_PROFILE_ADMISSION",
);
const exceeded = (): ExecutionIsolationProfileRefusal => refusal(
  "EXECUTION_ISOLATION_PROFILE_LIMIT_EXCEEDED", "EXECUTION_ISOLATION_PROFILE_LIMITS",
);
const mountInvalid = (): ExecutionIsolationProfileRefusal => refusal(
  "EXECUTION_ISOLATION_PROFILE_MOUNT_FORBIDDEN", "EXECUTION_ISOLATION_PROFILE_MOUNTS",
);
const networkInvalid = (): ExecutionIsolationProfileRefusal => refusal(
  "EXECUTION_ISOLATION_PROFILE_NETWORK_INVALID", "EXECUTION_ISOLATION_PROFILE_NETWORK",
);
const success = <T>(value: T): Readonly<{ ok: true; value: T }> =>
  Object.freeze({ ok: true as const, value });

export function readExecutionIsolationLimits(
  value: unknown,
): ReadResult<ExecutionIsolationResourceLimits> {
  if (!exact(value, LIMIT_KEYS)) return malformed();
  const maximums = {
    cpuMilliCores: EXECUTION_ISOLATION_PROFILE_LIMITS.maxCpuMilliCores,
    memoryBytes: EXECUTION_ISOLATION_PROFILE_LIMITS.maxMemoryBytes,
    outputBytes: EXECUTION_ISOLATION_PROFILE_LIMITS.maxOutputBytes,
    pids: EXECUTION_ISOLATION_PROFILE_LIMITS.maxPids,
    wallTimeMs: EXECUTION_ISOLATION_PROFILE_LIMITS.maxWallTimeMs,
  } as const;
  for (const key of LIMIT_KEYS) {
    const candidate = value[key];
    if (!Number.isSafeInteger(candidate)) return malformed();
    if ((candidate as number) <= 0 || (candidate as number) > maximums[key]) return exceeded();
  }
  return success(Object.freeze({
    cpuMilliCores: value["cpuMilliCores"] as number,
    memoryBytes: value["memoryBytes"] as number,
    outputBytes: value["outputBytes"] as number,
    pids: value["pids"] as number,
    wallTimeMs: value["wallTimeMs"] as number,
  }));
}

export function readExecutionIsolationMounts(
  value: unknown,
  purpose: ExecutionIsolationPurpose,
): ReadResult<readonly ExecutionIsolationMount[]> {
  const shape = purpose === "FRESH_VERIFIER"
    ? EXECUTION_ISOLATION_FRESH_VERIFIER_MOUNT_SHAPE
    : EXECUTION_ISOLATION_BUILD_AGENT_MOUNT_SHAPE;
  if (!Array.isArray(value) || value.length !== shape.length) return mountInvalid();
  const mounts: ExecutionIsolationMount[] = [];
  for (let index = 0; index < shape.length; index += 1) {
    const candidate = value[index]; const required = shape[index];
    if (required === undefined || !exact(candidate, MOUNT_KEYS)
      || candidate["access"] !== required.access || candidate["kind"] !== required.kind) {
      return mountInvalid();
    }
    const maxBytes = candidate["maxBytes"];
    if (!Number.isSafeInteger(maxBytes)) return malformed();
    if ((maxBytes as number) <= 0
      || (maxBytes as number) > EXECUTION_ISOLATION_PROFILE_LIMITS.maxMountBytes) {
      return exceeded();
    }
    mounts.push(Object.freeze({
      access: required.access, kind: required.kind, maxBytes: maxBytes as number,
    }));
  }
  return success(Object.freeze(mounts));
}

export function readExecutionIsolationForbiddenHostInputs(
  value: unknown,
): ReadResult<readonly string[]> {
  if (!Array.isArray(value)
    || value.length !== EXECUTION_ISOLATION_PROFILE_FORBIDDEN_HOST_INPUTS.length
    || value.some((candidate, index) => (
      candidate !== EXECUTION_ISOLATION_PROFILE_FORBIDDEN_HOST_INPUTS[index]
    ))) return refusal(
    "EXECUTION_ISOLATION_PROFILE_HOST_INPUT_FORBIDDEN",
    "EXECUTION_ISOLATION_PROFILE_HOST_BOUNDARY",
  );
  return success(Object.freeze([...EXECUTION_ISOLATION_PROFILE_FORBIDDEN_HOST_INPUTS]));
}

function isAccessMode(value: unknown): value is ExecutionIsolationNetworkAccessMode {
  return EXECUTION_ISOLATION_NETWORK_ACCESS_MODES.some((candidate) => candidate === value);
}

function isPlane(value: unknown): value is ExecutionIsolationNetworkPlaneIdentity {
  return EXECUTION_ISOLATION_NETWORK_PLANE_IDENTITIES.some((candidate) => candidate === value);
}

function readEndpointPolicies(
  value: unknown,
  purpose: ExecutionIsolationPurpose,
  plane: ExecutionIsolationNetworkPlaneIdentity,
): ReadResult<readonly ExecutionIsolationEndpointPolicyRef[]> {
  if (!Array.isArray(value) || value.length === 0) return networkInvalid();
  if (value.length > EXECUTION_ISOLATION_PROFILE_LIMITS.maxEndpointPolicies) return exceeded();
  const policies: ExecutionIsolationEndpointPolicyRef[] = [];
  for (const candidate of value) {
    if (!exact(candidate, ENDPOINT_POLICY_KEYS)
      || !validHex64(candidate["endpointPolicyDigest"])
      || typeof candidate["endpointPolicyRef"] !== "string"
      || !POLICY_REF.test(candidate["endpointPolicyRef"])
      || candidate["purpose"] !== purpose || candidate["plane"] !== plane) {
      return networkInvalid();
    }
    const previous = policies.at(-1);
    if (previous !== undefined && previous.endpointPolicyRef >= candidate["endpointPolicyRef"]) {
      return networkInvalid();
    }
    policies.push(Object.freeze({
      endpointPolicyDigest: candidate["endpointPolicyDigest"],
      endpointPolicyRef: candidate["endpointPolicyRef"],
      plane,
      purpose,
    }));
  }
  return success(Object.freeze(policies));
}

export function readExecutionIsolationNetwork(
  value: unknown,
  purpose: ExecutionIsolationPurpose,
): ReadResult<ExecutionIsolationNetwork> {
  if (!exact(value, NETWORK_KEYS)) return networkInvalid();
  const accessMode = value["accessMode"]; const plane = value["plane"];
  if (!isAccessMode(accessMode) || !isPlane(plane)) return networkInvalid();
  if (purpose === "FRESH_VERIFIER"
    && (accessMode !== "NONE" || plane !== "QUALIFICATION_BUILD")) return networkInvalid();
  const endpointPolicies = readEndpointPolicies(value["endpointPolicies"], purpose, plane);
  if (!endpointPolicies.ok) return endpointPolicies;
  return success(Object.freeze({ accessMode, endpointPolicies: endpointPolicies.value, plane }));
}
