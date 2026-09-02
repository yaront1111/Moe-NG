import { exact, validHex64 } from "../planning/planning-snapshot.js";
import {
  VERIFICATION_RECIPE_BUILD_AGENT_SAFE_ENVIRONMENT_NAMES,
  VERIFICATION_RECIPE_FRESH_VERIFIER_SAFE_ENVIRONMENT_NAMES,
  VERIFICATION_RECIPE_LIMITS,
  VERIFICATION_RECIPE_NETWORK_ACCESS_MODES,
  VERIFICATION_RECIPE_NETWORK_PLANE_IDENTITIES,
  verificationRecipeRefusal,
  type VerificationRecipeEvidenceParserRevision,
  type VerificationRecipeNetworkPolicy,
  type VerificationRecipeRefusal,
  type VerificationRecipeResourceCaps,
} from "./verification-recipe-contract.js";

type ReadResult<T> = Readonly<{ ok: true; value: T }> | VerificationRecipeRefusal;

const encoder = new TextEncoder();
const NETWORK_POLICY_KEYS = Object.freeze([
  "accessMode", "plane", "policyRef", "revisionDigest",
]);
const RESOURCE_CAP_KEYS = Object.freeze([
  "cpuMilliCores", "memoryBytes", "outputBytes", "pids", "timeoutMs",
]);
const EVIDENCE_PARSER_KEYS = Object.freeze(["parserRef", "revisionDigest"]);
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const NETWORK_POLICY_REF = /^network-policy:[a-z0-9][a-z0-9._-]{0,255}$/u;
const EVIDENCE_PARSER_REF = /^evidence-parser:[a-z0-9][a-z0-9._-]{0,255}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const SAFE_ENVIRONMENT_NAMES = new Set<string>([
  ...VERIFICATION_RECIPE_BUILD_AGENT_SAFE_ENVIRONMENT_NAMES,
  ...VERIFICATION_RECIPE_FRESH_VERIFIER_SAFE_ENVIRONMENT_NAMES,
]);

const refusal = (
  code: Parameters<typeof verificationRecipeRefusal>[0],
  layer: Parameters<typeof verificationRecipeRefusal>[1],
): VerificationRecipeRefusal => verificationRecipeRefusal(code, layer);
const success = <T>(value: T): Readonly<{ ok: true; value: T }> =>
  Object.freeze({ ok: true as const, value });

export function readVerificationWorkingDirectory(value: unknown): ReadResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || CONTROL.test(value) || !value.isWellFormed() || value.normalize("NFC") !== value) {
    return refusal(
      "VERIFICATION_RECIPE_WORKING_DIRECTORY_INVALID",
      "VERIFICATION_RECIPE_WORKING_DIRECTORY",
    );
  }
  if (encoder.encode(value).byteLength > VERIFICATION_RECIPE_LIMITS.maxWorkingDirectoryBytes) {
    return refusal("VERIFICATION_RECIPE_LIMIT_EXCEEDED", "VERIFICATION_RECIPE_LIMITS");
  }
  if (value === ".") return success(value);
  const parts = value.split("/");
  if (value.startsWith("/") || value.includes("\\") || value.includes(":")
    || parts.some((part) => part === "" || part === "." || part === "..")) {
    return refusal(
      "VERIFICATION_RECIPE_WORKING_DIRECTORY_INVALID",
      "VERIFICATION_RECIPE_WORKING_DIRECTORY",
    );
  }
  return success(value);
}

export function readVerificationEnvironmentAllowlist(
  value: unknown,
): ReadResult<readonly string[]> {
  if (!Array.isArray(value)) return refusal(
    "VERIFICATION_RECIPE_ENVIRONMENT_INVALID", "VERIFICATION_RECIPE_ENVIRONMENT",
  );
  if (value.length > VERIFICATION_RECIPE_LIMITS.maxEnvironmentNames) return refusal(
    "VERIFICATION_RECIPE_LIMIT_EXCEEDED", "VERIFICATION_RECIPE_LIMITS",
  );
  const names: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !ENVIRONMENT_NAME.test(candidate)) return refusal(
      "VERIFICATION_RECIPE_ENVIRONMENT_INVALID", "VERIFICATION_RECIPE_ENVIRONMENT",
    );
    if (encoder.encode(candidate).byteLength > VERIFICATION_RECIPE_LIMITS.maxEnvironmentNameBytes) {
      return refusal("VERIFICATION_RECIPE_LIMIT_EXCEEDED", "VERIFICATION_RECIPE_LIMITS");
    }
    if (!SAFE_ENVIRONMENT_NAMES.has(candidate)) return refusal(
      "VERIFICATION_RECIPE_ENVIRONMENT_FORBIDDEN", "VERIFICATION_RECIPE_ENVIRONMENT",
    );
    if (names.at(-1) !== undefined && names.at(-1)! >= candidate) return refusal(
      "VERIFICATION_RECIPE_ENVIRONMENT_INVALID", "VERIFICATION_RECIPE_ENVIRONMENT",
    );
    names.push(candidate);
  }
  return success(Object.freeze(names));
}

export function readVerificationNetworkPolicy(
  value: unknown,
): ReadResult<VerificationRecipeNetworkPolicy> {
  if (!exact(value, NETWORK_POLICY_KEYS)
    || typeof value["policyRef"] !== "string"
    || !NETWORK_POLICY_REF.test(value["policyRef"])
    || !validHex64(value["revisionDigest"])
    || !VERIFICATION_RECIPE_NETWORK_ACCESS_MODES.some(
      (mode) => mode === value["accessMode"],
    )
    || !VERIFICATION_RECIPE_NETWORK_PLANE_IDENTITIES.some(
      (plane) => plane === value["plane"],
    )) return refusal(
    "VERIFICATION_RECIPE_NETWORK_POLICY_INVALID", "VERIFICATION_RECIPE_NETWORK_POLICY",
  );
  return success(Object.freeze({
    accessMode: value["accessMode"] as VerificationRecipeNetworkPolicy["accessMode"],
    plane: value["plane"] as VerificationRecipeNetworkPolicy["plane"],
    policyRef: value["policyRef"],
    revisionDigest: value["revisionDigest"],
  }));
}

export function readVerificationResourceCaps(
  value: unknown,
): ReadResult<VerificationRecipeResourceCaps> {
  if (!exact(value, RESOURCE_CAP_KEYS)) return refusal(
    "VERIFICATION_RECIPE_RESOURCE_CAP_INVALID", "VERIFICATION_RECIPE_RESOURCE_CAPS",
  );
  const caps = {
    cpuMilliCores: VERIFICATION_RECIPE_LIMITS.maxCpuMilliCores,
    memoryBytes: VERIFICATION_RECIPE_LIMITS.maxMemoryBytes,
    outputBytes: VERIFICATION_RECIPE_LIMITS.maxOutputBytes,
    pids: VERIFICATION_RECIPE_LIMITS.maxPids,
    timeoutMs: VERIFICATION_RECIPE_LIMITS.maxTimeoutMs,
  } as const;
  for (const [key, maximum] of Object.entries(caps)) {
    const candidate = value[key];
    if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0
      || (candidate as number) > maximum) return refusal(
      "VERIFICATION_RECIPE_RESOURCE_CAP_INVALID", "VERIFICATION_RECIPE_RESOURCE_CAPS",
    );
  }
  return success(Object.freeze({
    cpuMilliCores: value["cpuMilliCores"] as number,
    memoryBytes: value["memoryBytes"] as number,
    outputBytes: value["outputBytes"] as number,
    pids: value["pids"] as number,
    timeoutMs: value["timeoutMs"] as number,
  }));
}

export function readVerificationEvidenceParser(
  value: unknown,
): ReadResult<VerificationRecipeEvidenceParserRevision> {
  if (!exact(value, EVIDENCE_PARSER_KEYS) || typeof value["parserRef"] !== "string"
    || !EVIDENCE_PARSER_REF.test(value["parserRef"])
    || !validHex64(value["revisionDigest"])) return refusal(
    "VERIFICATION_RECIPE_EVIDENCE_PARSER_INVALID", "VERIFICATION_RECIPE_EVIDENCE_PARSER",
  );
  return success(Object.freeze({
    parserRef: value["parserRef"], revisionDigest: value["revisionDigest"],
  }));
}
