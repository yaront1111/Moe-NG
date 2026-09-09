import type { ProductContractV2Requirement } from "@moe/core";

import {
  CONTROLLED_PROFILE_VERSION,
} from "../controlled-profile/controlled-profile-generator.js";
import { deploymentInfrastructureFiles } from "./deployment-infrastructure-templates.js";

/**
 * Decides WHICH infrastructure files a repository is missing and what their bytes are. A pure
 * function: its only inputs are the request and the paths the repository already carries, so the
 * same contract against the same repository always yields the same answer.
 *
 * NON-DESTRUCTIVE IS STRUCTURAL HERE, NOT A FLAG. A path the repository already carries never
 * appears in `write` — it appears in `kept`. The caller is handed no bytes it could clobber an
 * operator's Dockerfile with, so there is no overwrite branch to get wrong and no option to pass.
 *
 * WHY THE CONTRACT IS AN INPUT AT ALL. `deploymentRequirements` on the v2 revision are PROSE
 * statements: `{statement, requirementId, priority, dependsOnRequirementIds, supersedesRequirementId}`
 * carries no port, image or health path. Parsing statements for build parameters would invent
 * authority the contract does not hold. Instead the profile fixes the deployment shape and the
 * requirement ids are recorded in each emitted file's provenance header — so a different requirement
 * set is different bytes, and the generated infrastructure traces to what it claims to satisfy.
 *
 * This module is INTERNAL to `@moe/daemon`, like the scaffold generator it sits beside: the
 * published surface in `src/index.ts` is guarded by `index-surface.test.ts`.
 */

/** Raised when a caller asks for a profile version this build does not know how to emit. */
export const DEPLOY_PROFILE_VERSION_UNKNOWN = "DEPLOY_PROFILE_VERSION_UNKNOWN" as const;

/**
 * Raised when the contract carries no deployment requirements. DoD 1 says the files are generated
 * FROM them; emitting infrastructure that satisfies nothing would be inventing the requirement, and
 * the provenance header would name an empty set while claiming to trace.
 */
export const DEPLOY_REQUIREMENTS_ABSENT = "DEPLOY_REQUIREMENTS_ABSENT" as const;

export type DeploymentInfrastructureRefusalCode =
  | typeof DEPLOY_PROFILE_VERSION_UNKNOWN
  | typeof DEPLOY_REQUIREMENTS_ABSENT;

export interface DeploymentInfrastructureRequest {
  /** The deployment requirements of the APPROVED contract revision. */
  readonly deploymentRequirements: readonly ProductContractV2Requirement[];
  /** Forward-slash relative paths the repository already carries. */
  readonly existingPaths: Iterable<string>;
  readonly profileVersion: string;
}

export interface DeploymentInfrastructurePlan {
  readonly ok: true;
  /**
   * Paths the repository already carries. Their bytes are absent from this result entirely: the
   * generator never reads or reproduces an operator's file, so it cannot round-trip it wrongly.
   */
  readonly kept: readonly string[];
  /** The requirement ids recorded in every emitted provenance header, sorted. */
  readonly requirementIds: readonly string[];
  /** Only the files the repository LACKS, keyed by forward-slash relative path. */
  readonly write: ReadonlyMap<string, string>;
}

export interface DeploymentInfrastructureRefusal {
  readonly ok: false;
  readonly code: DeploymentInfrastructureRefusalCode;
}

export type DeploymentInfrastructureResult = DeploymentInfrastructurePlan | DeploymentInfrastructureRefusal;

/**
 * Sorted by UTF-16 code unit, so a contract that lists the same requirements in a different order
 * still produces byte-identical files. Duplicates collapse: two rows naming one requirement id must
 * not double it in the header.
 */
function orderedRequirementIds(
  requirements: readonly ProductContractV2Requirement[],
): readonly string[] {
  return [...new Set(requirements.map((requirement) => requirement.requirementId))].sort();
}

export function planDeploymentInfrastructure(
  request: DeploymentInfrastructureRequest,
): DeploymentInfrastructureResult {
  if (request.profileVersion !== CONTROLLED_PROFILE_VERSION) {
    return { ok: false, code: DEPLOY_PROFILE_VERSION_UNKNOWN };
  }

  const requirementIds = orderedRequirementIds(request.deploymentRequirements);
  if (requirementIds.length === 0) {
    return { ok: false, code: DEPLOY_REQUIREMENTS_ABSENT };
  }

  const existing = new Set(request.existingPaths);
  const write = new Map<string, string>();
  const kept: string[] = [];

  for (const [path, body] of deploymentInfrastructureFiles(request.profileVersion, requirementIds)) {
    if (existing.has(path)) {
      kept.push(path);
      continue;
    }
    write.set(path, body);
  }

  return { ok: true, kept, requirementIds, write };
}
