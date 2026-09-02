import { MAX_JSON_BODY_BYTES } from "@moe/contracts";

import {
  EXECUTION_ISOLATION_NETWORK_ACCESS_MODES,
  EXECUTION_ISOLATION_NETWORK_PLANE_IDENTITIES,
  type ExecutionIsolationNetworkAccessMode,
  type ExecutionIsolationNetworkPlaneIdentity,
  type ExecutionIsolationProfileRevision,
} from "./execution-isolation-profile-contract.js";

export const VERIFICATION_RECIPE_VERSION = "moe-verification-recipe-revision/1" as const;
export const VERIFICATION_RECIPE_DIGEST_DOMAIN =
  "moe-verification-recipe-revision-digest/1" as const;
export const VERIFICATION_RECIPE_OUTPUT_MOUNTS = Object.freeze([
  "OUTPUT", "EVIDENCE",
] as const);
export const VERIFICATION_RECIPE_NETWORK_ACCESS_MODES = Object.freeze([
  ...EXECUTION_ISOLATION_NETWORK_ACCESS_MODES,
] as const);
export const VERIFICATION_RECIPE_NETWORK_PLANE_IDENTITIES = Object.freeze([
  ...EXECUTION_ISOLATION_NETWORK_PLANE_IDENTITIES,
] as const);
export const VERIFICATION_RECIPE_FORBIDDEN_SHELL_TOOLS = Object.freeze([
  "sh", "bash", "dash", "zsh", "fish", "cmd", "cmd.exe",
  "powershell", "powershell.exe", "pwsh", "wsl", "wsl.exe",
] as const);
export const VERIFICATION_RECIPE_BUILD_AGENT_SAFE_ENVIRONMENT_NAMES = Object.freeze([
  "CI", "MOE_EVIDENCE_DIR", "MOE_OUTPUT_DIR", "MOE_SCRATCH_DIR", "NO_COLOR",
] as const);
export const VERIFICATION_RECIPE_FRESH_VERIFIER_SAFE_ENVIRONMENT_NAMES = Object.freeze([
  "CI", "MOE_EVIDENCE_DIR", "NO_COLOR",
] as const);
export const VERIFICATION_RECIPE_LIMITS = Object.freeze({
  maxArgBytes: 8_192,
  maxArgs: 128,
  maxArrayLength: 256,
  maxBytes: MAX_JSON_BODY_BYTES,
  maxCpuMilliCores: 64_000,
  maxEnvironmentNameBytes: 128,
  maxEnvironmentNames: 128,
  maxMemoryBytes: 274_877_906_944,
  maxNodes: 4_096,
  maxOutputBytes: 1_073_741_824,
  maxOutputPathBytes: 1_024,
  maxOutputs: 128,
  maxPids: 4_096,
  maxRefBytes: 512,
  maxSnapshotDepth: 8,
  maxTimeoutMs: 86_400_000,
  maxWorkingDirectoryBytes: 1_024,
});
export const VERIFICATION_RECIPE_CODES = Object.freeze([
  "VERIFICATION_RECIPE_MALFORMED",
  "VERIFICATION_RECIPE_VERSION_UNSUPPORTED",
  "VERIFICATION_RECIPE_LIMIT_EXCEEDED",
  "VERIFICATION_RECIPE_SHELL_FORBIDDEN",
  "VERIFICATION_RECIPE_BINDING_INVALID",
  "VERIFICATION_RECIPE_WORKING_DIRECTORY_INVALID",
  "VERIFICATION_RECIPE_ENVIRONMENT_INVALID",
  "VERIFICATION_RECIPE_ENVIRONMENT_FORBIDDEN",
  "VERIFICATION_RECIPE_NETWORK_POLICY_INVALID",
  "VERIFICATION_RECIPE_RESOURCE_CAP_INVALID",
  "VERIFICATION_RECIPE_EVIDENCE_PARSER_INVALID",
  "VERIFICATION_RECIPE_EXECUTION_PROFILE_MISMATCH",
  "VERIFICATION_RECIPE_OUTPUT_MOUNT_UNAVAILABLE",
  "VERIFICATION_RECIPE_OUTPUT_INVALID",
  "VERIFICATION_RECIPE_OUTCOME_INVALID",
  "VERIFICATION_RECIPE_BYTES_INVALID",
  "VERIFICATION_RECIPE_DUPLICATE_KEY",
  "VERIFICATION_RECIPE_NONCANONICAL",
  "VERIFICATION_RECIPE_DIGEST_MISMATCH",
] as const);
export const VERIFICATION_RECIPE_LAYERS = Object.freeze([
  "VERIFICATION_RECIPE_ADMISSION",
  "VERIFICATION_RECIPE_VERSION",
  "VERIFICATION_RECIPE_LIMITS",
  "VERIFICATION_RECIPE_COMMAND",
  "VERIFICATION_RECIPE_BINDING",
  "VERIFICATION_RECIPE_WORKING_DIRECTORY",
  "VERIFICATION_RECIPE_ENVIRONMENT",
  "VERIFICATION_RECIPE_NETWORK_POLICY",
  "VERIFICATION_RECIPE_RESOURCE_CAPS",
  "VERIFICATION_RECIPE_EVIDENCE_PARSER",
  "VERIFICATION_RECIPE_EXECUTION_PROFILE",
  "VERIFICATION_RECIPE_OUTPUT",
  "VERIFICATION_RECIPE_OUTCOME",
  "VERIFICATION_RECIPE_CODEC",
  "VERIFICATION_RECIPE_CANONICALIZATION",
  "VERIFICATION_RECIPE_DIGEST",
] as const);

export type VerificationRecipeOutputMount = (typeof VERIFICATION_RECIPE_OUTPUT_MOUNTS)[number];
export type VerificationRecipeCode = (typeof VERIFICATION_RECIPE_CODES)[number];
export type VerificationRecipeLayer = (typeof VERIFICATION_RECIPE_LAYERS)[number];

export interface VerificationRecipeImageRef {
  readonly imageDigest: string;
  readonly imageRef: string;
}

export interface VerificationRecipeToolRef {
  readonly toolDigest: string;
  readonly toolRef: string;
}

export interface VerificationRecipeExpectedOutput {
  readonly mount: VerificationRecipeOutputMount;
  readonly relativePath: string;
  readonly sha256: string;
}

export interface VerificationRecipeExpectedRefusal {
  readonly code: string;
  readonly layer: string;
}

export interface VerificationRecipeNetworkPolicy {
  readonly accessMode: ExecutionIsolationNetworkAccessMode;
  readonly plane: ExecutionIsolationNetworkPlaneIdentity;
  readonly policyRef: string;
  readonly revisionDigest: string;
}

export interface VerificationRecipeResourceCaps {
  readonly cpuMilliCores: number;
  readonly memoryBytes: number;
  readonly outputBytes: number;
  readonly pids: number;
  readonly timeoutMs: number;
}

export interface VerificationRecipeEvidenceParserRevision {
  readonly parserRef: string;
  readonly revisionDigest: string;
}

export interface VerificationRecipeRevisionDraft {
  readonly argv: readonly string[];
  readonly environmentNameAllowlist: readonly string[];
  readonly evidenceParser: VerificationRecipeEvidenceParserRevision;
  readonly executionProfileRevisionDigest: string;
  readonly expectedExitCode: number | null;
  readonly expectedOutputs: readonly VerificationRecipeExpectedOutput[];
  readonly expectedRefusal: VerificationRecipeExpectedRefusal | null;
  readonly image: VerificationRecipeImageRef;
  readonly networkPolicy: VerificationRecipeNetworkPolicy;
  readonly recipeId: string;
  readonly resourceCaps: VerificationRecipeResourceCaps;
  readonly revisionId: string;
  readonly sourceSnapshotDigest: string;
  readonly tool: VerificationRecipeToolRef;
  readonly workingDirectory: string;
}

export interface VerificationRecipeRevision extends VerificationRecipeRevisionDraft {
  readonly revisionDigest: string;
  readonly version: typeof VERIFICATION_RECIPE_VERSION;
}

export interface VerificationRecipeRefusal {
  readonly code: VerificationRecipeCode;
  readonly layer: VerificationRecipeLayer;
  readonly ok: false;
}

export type VerificationRecipeCreateResult =
  | Readonly<{ ok: true; revision: VerificationRecipeRevision }>
  | VerificationRecipeRefusal;
export type VerificationRecipeEncodeResult =
  | Readonly<{ bytes: Uint8Array; ok: true }>
  | VerificationRecipeRefusal;
export type VerificationRecipeDecodeResult =
  | Readonly<{ ok: true; revision: VerificationRecipeRevision }>
  | VerificationRecipeRefusal;
export type VerificationRecipeProfileAdmission =
  | Readonly<{
    executionProfile: ExecutionIsolationProfileRevision;
    ok: true;
    recipe: VerificationRecipeRevision;
  }>
  | VerificationRecipeRefusal;

export function verificationRecipeRefusal(
  code: VerificationRecipeCode,
  layer: VerificationRecipeLayer,
): VerificationRecipeRefusal {
  return Object.freeze({ code, layer, ok: false as const });
}
