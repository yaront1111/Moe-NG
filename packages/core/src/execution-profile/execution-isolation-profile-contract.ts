import { MAX_JSON_BODY_BYTES } from "@moe/contracts";

export const EXECUTION_ISOLATION_PROFILE_VERSION =
  "moe-execution-isolation-profile-revision/1" as const;
export const EXECUTION_ISOLATION_PROFILE_DIGEST_DOMAIN =
  "moe-execution-isolation-profile-revision-digest/1" as const;

export const EXECUTION_ISOLATION_PROFILE_DEFAULT_PLANE =
  "DISPOSABLE_DOCKER_LINUX" as const;
export const EXECUTION_ISOLATION_PROFILE_PLANES = Object.freeze([
  EXECUTION_ISOLATION_PROFILE_DEFAULT_PLANE,
  "HYPER_V_ISOLATED_WINDOWS_CONTAINER",
] as const);
export const EXECUTION_ISOLATION_PROFILE_PURPOSES = Object.freeze([
  "BUILD_AGENT", "FRESH_VERIFIER",
] as const);
export const EXECUTION_ISOLATION_NETWORK_ACCESS_MODES = Object.freeze([
  "NONE", "BROKER_ONLY", "ALLOWLISTED_EGRESS",
] as const);
export const EXECUTION_ISOLATION_NETWORK_PLANE_IDENTITIES = Object.freeze([
  "CONTROL",
  "PROVIDER",
  "QUALIFICATION_BUILD",
  "RESEARCH",
  "PRODUCT_PREVIEW",
  "PRODUCT_PRODUCTION",
  "TRUSTED_GITHUB_PUBLISHER",
] as const);
export const EXECUTION_ISOLATION_BUILD_AGENT_MOUNT_SHAPE = Object.freeze([
  Object.freeze({ access: "READ_ONLY" as const, kind: "SOURCE_SNAPSHOT" as const }),
  Object.freeze({ access: "READ_WRITE" as const, kind: "RUN_SCRATCH" as const }),
  Object.freeze({ access: "READ_WRITE" as const, kind: "OUTPUT" as const }),
  Object.freeze({ access: "READ_WRITE" as const, kind: "EVIDENCE" as const }),
] as const);
export const EXECUTION_ISOLATION_FRESH_VERIFIER_MOUNT_SHAPE = Object.freeze([
  Object.freeze({ access: "READ_ONLY" as const, kind: "SOURCE_SNAPSHOT" as const }),
  Object.freeze({ access: "WRITE_ONLY" as const, kind: "EVIDENCE" as const }),
] as const);

/** Every member is mandatory. A profile cannot omit a host boundary as an exemption. */
export const EXECUTION_ISOLATION_PROFILE_FORBIDDEN_HOST_INPUTS = Object.freeze([
  "HOST_GIT_METADATA",
  "HOST_GIT_CREDENTIALS",
  "HOST_GIT_CONFIG",
  "GITHUB_CREDENTIALS",
  "SSH_KEY_MATERIAL",
  "SSH_AGENT_SOCKET",
  "PACKAGE_MANAGER_CREDENTIALS",
  "USER_HOME_DIRECTORY",
  "GLOBAL_USER_CONFIGURATION",
  "RAW_PROVIDER_SECRETS",
  "HOST_SECRETS",
  "HOST_CONFIG",
  "HOST_FILESYSTEM",
  "BROAD_HOST_MOUNTS",
  "OTHER_PROJECT_PATHS",
  "OTHER_WORKTREE_PATHS",
  "DAEMON_SOCKET",
  "STORE_SOCKET",
  "CONTROL_SOCKET",
  "DOCKER_SOCKET",
  "DOCKER_WINDOWS_NAMED_PIPE",
  "DOCKER_DAEMON",
] as const);

export const EXECUTION_ISOLATION_PROFILE_LIMITS = Object.freeze({
  maxArrayLength: 256,
  maxBytes: MAX_JSON_BODY_BYTES,
  maxCpuMilliCores: 64_000,
  maxCredentialTtlMs: 900_000,
  maxMemoryBytes: 274_877_906_944,
  maxEndpointPolicies: 128,
  maxMountBytes: 274_877_906_944,
  maxNodes: 4_096,
  maxOutputBytes: 1_073_741_824,
  maxPids: 4_096,
  maxRefBytes: 512,
  maxSnapshotDepth: 8,
  maxTools: 64,
  maxWallTimeMs: 86_400_000,
  minCredentialTtlMs: 1_000,
});

export const EXECUTION_ISOLATION_PROFILE_CODES = Object.freeze([
  "EXECUTION_ISOLATION_PROFILE_MALFORMED",
  "EXECUTION_ISOLATION_PROFILE_VERSION_UNSUPPORTED",
  "EXECUTION_ISOLATION_PROFILE_LIMIT_EXCEEDED",
  "EXECUTION_ISOLATION_PROFILE_PLANE_FORBIDDEN",
  "EXECUTION_ISOLATION_PROFILE_PURPOSE_INVALID",
  "EXECUTION_ISOLATION_PROFILE_COMMAND_MODE_FORBIDDEN",
  "EXECUTION_ISOLATION_PROFILE_MOUNT_FORBIDDEN",
  "EXECUTION_ISOLATION_PROFILE_HOST_INPUT_FORBIDDEN",
  "EXECUTION_ISOLATION_PROFILE_NETWORK_INVALID",
  "EXECUTION_ISOLATION_PROFILE_CREDENTIAL_BROKER_INVALID",
  "EXECUTION_ISOLATION_PROFILE_BINDING_INVALID",
  "EXECUTION_ISOLATION_PROFILE_BYTES_INVALID",
  "EXECUTION_ISOLATION_PROFILE_DUPLICATE_KEY",
  "EXECUTION_ISOLATION_PROFILE_NONCANONICAL",
  "EXECUTION_ISOLATION_PROFILE_DIGEST_MISMATCH",
] as const);
export const EXECUTION_ISOLATION_PROFILE_LAYERS = Object.freeze([
  "EXECUTION_ISOLATION_PROFILE_ADMISSION",
  "EXECUTION_ISOLATION_PROFILE_VERSION",
  "EXECUTION_ISOLATION_PROFILE_LIMITS",
  "EXECUTION_ISOLATION_PROFILE_PLANE",
  "EXECUTION_ISOLATION_PROFILE_PURPOSE",
  "EXECUTION_ISOLATION_PROFILE_COMMAND",
  "EXECUTION_ISOLATION_PROFILE_MOUNTS",
  "EXECUTION_ISOLATION_PROFILE_HOST_BOUNDARY",
  "EXECUTION_ISOLATION_PROFILE_NETWORK",
  "EXECUTION_ISOLATION_PROFILE_CREDENTIAL_BROKER",
  "EXECUTION_ISOLATION_PROFILE_BINDING",
  "EXECUTION_ISOLATION_PROFILE_CODEC",
  "EXECUTION_ISOLATION_PROFILE_CANONICALIZATION",
  "EXECUTION_ISOLATION_PROFILE_DIGEST",
] as const);

export type ExecutionIsolationPlane = (typeof EXECUTION_ISOLATION_PROFILE_PLANES)[number];
export type ExecutionIsolationPurpose = (typeof EXECUTION_ISOLATION_PROFILE_PURPOSES)[number];
export type ExecutionIsolationNetworkAccessMode =
  (typeof EXECUTION_ISOLATION_NETWORK_ACCESS_MODES)[number];
export type ExecutionIsolationNetworkPlaneIdentity =
  (typeof EXECUTION_ISOLATION_NETWORK_PLANE_IDENTITIES)[number];
export type ExecutionIsolationForbiddenHostInput =
  (typeof EXECUTION_ISOLATION_PROFILE_FORBIDDEN_HOST_INPUTS)[number];
export type ExecutionIsolationProfileCode =
  (typeof EXECUTION_ISOLATION_PROFILE_CODES)[number];
export type ExecutionIsolationProfileLayer =
  (typeof EXECUTION_ISOLATION_PROFILE_LAYERS)[number];

export interface ExecutionIsolationMount {
  readonly access: "READ_ONLY" | "READ_WRITE" | "WRITE_ONLY";
  readonly kind: "SOURCE_SNAPSHOT" | "RUN_SCRATCH" | "OUTPUT" | "EVIDENCE";
  readonly maxBytes: number;
}

export interface ExecutionIsolationCredentialBrokerRef {
  readonly brokerRef: string;
  readonly maximumCredentialTtlMs: number;
}

export interface ExecutionIsolationImageRef {
  readonly imageDigest: string;
  readonly imageRef: string;
}

export interface ExecutionIsolationToolRef {
  readonly toolDigest: string;
  readonly toolRef: string;
}

export interface ExecutionIsolationResourceLimits {
  readonly cpuMilliCores: number;
  readonly memoryBytes: number;
  readonly outputBytes: number;
  readonly pids: number;
  readonly wallTimeMs: number;
}

export interface ExecutionIsolationNetwork {
  readonly accessMode: ExecutionIsolationNetworkAccessMode;
  readonly endpointPolicies: readonly ExecutionIsolationEndpointPolicyRef[];
  readonly plane: ExecutionIsolationNetworkPlaneIdentity;
}

export interface ExecutionIsolationEndpointPolicyRef {
  readonly endpointPolicyDigest: string;
  readonly endpointPolicyRef: string;
  readonly plane: ExecutionIsolationNetworkPlaneIdentity;
  readonly purpose: ExecutionIsolationPurpose;
}

export interface ExecutionIsolationProfileRevisionDraft {
  readonly commandMode: "DIRECT_ARGV";
  readonly credentialBroker: ExecutionIsolationCredentialBrokerRef | null;
  readonly deliveryProfileRevisionDigest: string;
  readonly executionPlane: ExecutionIsolationPlane;
  readonly forbiddenHostInputs: readonly ExecutionIsolationForbiddenHostInput[];
  readonly image: ExecutionIsolationImageRef;
  readonly limits: ExecutionIsolationResourceLimits;
  readonly mounts: readonly ExecutionIsolationMount[];
  readonly network: ExecutionIsolationNetwork;
  readonly profileId: string;
  readonly purpose: ExecutionIsolationPurpose;
  readonly revisionId: string;
  readonly sourceSnapshotDigest: string;
  readonly tools: readonly ExecutionIsolationToolRef[];
}

export interface ExecutionIsolationProfileRevision extends ExecutionIsolationProfileRevisionDraft {
  readonly revisionDigest: string;
  readonly version: typeof EXECUTION_ISOLATION_PROFILE_VERSION;
}

export interface ExecutionIsolationProfileRefusal {
  readonly code: ExecutionIsolationProfileCode;
  readonly layer: ExecutionIsolationProfileLayer;
  readonly ok: false;
}

export type ExecutionIsolationProfileCreateResult =
  | Readonly<{ ok: true; revision: ExecutionIsolationProfileRevision }>
  | ExecutionIsolationProfileRefusal;
export type ExecutionIsolationProfileEncodeResult =
  | Readonly<{ bytes: Uint8Array; ok: true }>
  | ExecutionIsolationProfileRefusal;
export type ExecutionIsolationProfileDecodeResult =
  | Readonly<{ ok: true; revision: ExecutionIsolationProfileRevision }>
  | ExecutionIsolationProfileRefusal;

export function executionIsolationProfileRefusal(
  code: ExecutionIsolationProfileCode,
  layer: ExecutionIsolationProfileLayer,
): ExecutionIsolationProfileRefusal {
  return Object.freeze({ code, layer, ok: false as const });
}
