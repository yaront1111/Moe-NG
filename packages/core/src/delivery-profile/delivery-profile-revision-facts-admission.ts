import {
  DELIVERY_PROFILE_LIMITS,
  type DeliveryProfileImmutableArtifactRef,
  type DeliveryProfileModelProviderCapability,
  type DeliveryProfilePolicyKind,
  type DeliveryProfilePolicyRefs,
  type DeliveryProfileResourceClass,
  type DeliveryProfileSupportedBackendFacts,
  type DeliveryProfileSupportedHostFacts,
  type DeliveryProfileTypedPolicyRef,
} from "./delivery-profile-contract.js";
import {
  DELIVERY_PROFILE_MODEL_PROVIDER_CAPABILITIES,
  DELIVERY_PROFILE_RESOURCE_CLASSES,
} from "./delivery-profile-revision-contract.js";
import {
  exact, malformed, readArtifact, readSortedRefs, readText, success, validHex64,
  type ReadResult,
} from "./delivery-profile-admission-primitives.js";

const HOST_KEYS = Object.freeze([
  "architecture", "browserEngine", "composeImplementation", "containerEngine",
  "operatingSystem",
]);
const BACKEND_KEYS = Object.freeze([
  "databaseEngine", "healthProtocol", "migrationMode", "stateModel",
]);
const POLICY_REFS_KEYS = Object.freeze(["budget", "operations", "resource", "security"]);
const POLICY_REF_KEYS = Object.freeze(["artifactDigest", "artifactRef", "policyKind"]);

function readClosedRoster<T extends string>(
  value: unknown,
  roster: readonly T[],
): ReadResult<readonly T[]> {
  const refs = readSortedRefs(value, DELIVERY_PROFILE_LIMITS.maxRefsPerKind, false);
  if (!refs.ok) return refs;
  return refs.value.every((item) => roster.some((candidate) => candidate === item))
    ? success(refs.value as readonly T[]) : malformed();
}

export const readAllowedCapabilityIds = (value: unknown): ReadResult<readonly string[]> =>
  readSortedRefs(value, DELIVERY_PROFILE_LIMITS.maxRefsPerKind, false);

export const readScopeRoster = (value: unknown): ReadResult<readonly string[]> =>
  readSortedRefs(value, DELIVERY_PROFILE_LIMITS.maxScopesPerKind, false);

export const readResourceClasses = (
  value: unknown,
): ReadResult<readonly DeliveryProfileResourceClass[]> =>
  readClosedRoster(value, DELIVERY_PROFILE_RESOURCE_CLASSES);

export const readModelProviderCapabilities = (
  value: unknown,
): ReadResult<readonly DeliveryProfileModelProviderCapability[]> =>
  readClosedRoster(value, DELIVERY_PROFILE_MODEL_PROVIDER_CAPABILITIES);

export function readSupportedHostFacts(
  value: unknown,
): ReadResult<DeliveryProfileSupportedHostFacts> {
  if (!exact(value, HOST_KEYS)
    || !["x86_64", "arm64"].includes(value["architecture"] as string)
    || !["Chromium", "Firefox", "WebKit"].includes(value["browserEngine"] as string)
    || !["Docker Compose", "Podman Compose"].includes(value["composeImplementation"] as string)
    || !["Docker", "Podman"].includes(value["containerEngine"] as string)
    || !["Linux", "Windows", "macOS"].includes(value["operatingSystem"] as string)) {
    return malformed();
  }
  return success(Object.freeze({
    architecture: value["architecture"], browserEngine: value["browserEngine"],
    composeImplementation: value["composeImplementation"],
    containerEngine: value["containerEngine"], operatingSystem: value["operatingSystem"],
  }) as DeliveryProfileSupportedHostFacts);
}

export function readSupportedBackendFacts(
  value: unknown,
): ReadResult<DeliveryProfileSupportedBackendFacts> {
  if (!exact(value, BACKEND_KEYS) || value["databaseEngine"] !== "PostgreSQL"
    || value["healthProtocol"] !== "HTTP" || value["migrationMode"] !== "TRANSACTIONAL"
    || value["stateModel"] !== "PERSISTENT") return malformed();
  return success(Object.freeze({
    databaseEngine: "PostgreSQL" as const, healthProtocol: "HTTP" as const,
    migrationMode: "TRANSACTIONAL" as const, stateModel: "PERSISTENT" as const,
  }));
}

function readPolicyRef<K extends DeliveryProfilePolicyKind>(
  value: unknown,
  policyKind: K,
): ReadResult<DeliveryProfileTypedPolicyRef<K>> {
  if (!exact(value, POLICY_REF_KEYS) || value["policyKind"] !== policyKind
    || !validHex64(value["artifactDigest"])) return malformed();
  const artifactRef = readText(value["artifactRef"]); if (!artifactRef.ok) return artifactRef;
  return success(Object.freeze({
    artifactDigest: value["artifactDigest"], artifactRef: artifactRef.value, policyKind,
  }));
}

export function readPolicyRefs(value: unknown): ReadResult<DeliveryProfilePolicyRefs> {
  if (!exact(value, POLICY_REFS_KEYS)) return malformed();
  const budget = readPolicyRef(value["budget"], "BUDGET");
  const operations = readPolicyRef(value["operations"], "OPERATIONS");
  const resource = readPolicyRef(value["resource"], "RESOURCE");
  const security = readPolicyRef(value["security"], "SECURITY");
  if (!budget.ok) return budget; if (!operations.ok) return operations;
  if (!resource.ok) return resource; if (!security.ok) return security;
  return success(Object.freeze({
    budget: budget.value, operations: operations.value,
    resource: resource.value, security: security.value,
  }));
}

export const readBenchmarkCorpus = (
  value: unknown,
): ReadResult<DeliveryProfileImmutableArtifactRef> => readArtifact(value);
