import { admitExecutionIsolationProfileRevision } from
  "./execution-isolation-profile-admission.js";
import { encodeExecutionIsolationProfileRevision } from
  "./execution-isolation-profile-codec.js";
import type { ExecutionIsolationProfileRevision } from
  "./execution-isolation-profile-contract.js";
import {
  VERIFICATION_RECIPE_BUILD_AGENT_SAFE_ENVIRONMENT_NAMES,
  VERIFICATION_RECIPE_FRESH_VERIFIER_SAFE_ENVIRONMENT_NAMES,
  verificationRecipeRefusal,
  type VerificationRecipeProfileAdmission,
  type VerificationRecipeRefusal,
  type VerificationRecipeRevision,
} from "./verification-recipe-contract.js";

const refusal = (
  code: Parameters<typeof verificationRecipeRefusal>[0],
  layer: Parameters<typeof verificationRecipeRefusal>[1],
): VerificationRecipeRefusal => verificationRecipeRefusal(code, layer);
const profileMismatch = (): VerificationRecipeRefusal => refusal(
  "VERIFICATION_RECIPE_EXECUTION_PROFILE_MISMATCH",
  "VERIFICATION_RECIPE_EXECUTION_PROFILE",
);
const environmentForbidden = (): VerificationRecipeRefusal => refusal(
  "VERIFICATION_RECIPE_ENVIRONMENT_FORBIDDEN", "VERIFICATION_RECIPE_ENVIRONMENT",
);
const outputUnavailable = (): VerificationRecipeRefusal => refusal(
  "VERIFICATION_RECIPE_OUTPUT_MOUNT_UNAVAILABLE", "VERIFICATION_RECIPE_OUTPUT",
);

function baseBindingsMatch(
  recipe: VerificationRecipeRevision,
  profile: ExecutionIsolationProfileRevision,
): boolean {
  const endpointMatches = profile.network.endpointPolicies.some((policy) =>
    policy.endpointPolicyDigest === recipe.networkPolicy.revisionDigest
    && policy.endpointPolicyRef === recipe.networkPolicy.policyRef
    && policy.plane === recipe.networkPolicy.plane
    && policy.purpose === profile.purpose);
  return recipe.executionProfileRevisionDigest === profile.revisionDigest
    && recipe.sourceSnapshotDigest === profile.sourceSnapshotDigest
    && recipe.image.imageDigest === profile.image.imageDigest
    && recipe.image.imageRef === profile.image.imageRef
    && profile.tools.some((tool) => tool.toolDigest === recipe.tool.toolDigest
      && tool.toolRef === recipe.tool.toolRef)
    && recipe.networkPolicy.accessMode === profile.network.accessMode
    && recipe.networkPolicy.plane === profile.network.plane
    && endpointMatches
    && recipe.resourceCaps.cpuMilliCores <= profile.limits.cpuMilliCores
    && recipe.resourceCaps.memoryBytes <= profile.limits.memoryBytes
    && recipe.resourceCaps.outputBytes <= profile.limits.outputBytes
    && recipe.resourceCaps.pids <= profile.limits.pids
    && recipe.resourceCaps.timeoutMs <= profile.limits.wallTimeMs;
}

function environmentMatchesPurpose(
  recipe: VerificationRecipeRevision,
  profile: ExecutionIsolationProfileRevision,
): boolean {
  const safeNames: readonly string[] = profile.purpose === "FRESH_VERIFIER"
    ? VERIFICATION_RECIPE_FRESH_VERIFIER_SAFE_ENVIRONMENT_NAMES
    : VERIFICATION_RECIPE_BUILD_AGENT_SAFE_ENVIRONMENT_NAMES;
  return recipe.environmentNameAllowlist.every((name) => safeNames.includes(name));
}

function outputsMatchWritableMounts(
  recipe: VerificationRecipeRevision,
  profile: ExecutionIsolationProfileRevision,
): boolean {
  return recipe.expectedOutputs.every((output) => {
    const mount = profile.mounts.find((candidate) => candidate.kind === output.mount);
    return mount !== undefined && mount.access !== "READ_ONLY"
      && recipe.resourceCaps.outputBytes <= mount.maxBytes;
  });
}

export function admitVerificationRecipeExecutionProfileBindings(
  recipe: VerificationRecipeRevision,
  executionProfileValue: unknown,
): VerificationRecipeProfileAdmission {
  const admitted = admitExecutionIsolationProfileRevision(executionProfileValue);
  if (!admitted.ok || !encodeExecutionIsolationProfileRevision(admitted.revision).ok) {
    return profileMismatch();
  }
  const profile = admitted.revision;
  if (!baseBindingsMatch(recipe, profile)) return profileMismatch();
  if (!environmentMatchesPurpose(recipe, profile)) return environmentForbidden();
  if (!outputsMatchWritableMounts(recipe, profile)) return outputUnavailable();
  return Object.freeze({ executionProfile: profile, ok: true as const, recipe });
}
