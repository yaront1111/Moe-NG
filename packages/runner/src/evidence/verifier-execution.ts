import type { ArtifactRef } from "../artifacts/artifact-contract.js";
import { canonicalDigest, isCanonicalUtcTimestamp } from "../canonical.js";
import {
  observationDigestInput,
  type ProviderRuntimeObservation,
} from "../providers/claude/claude-observation.js";
import {
  evidenceFailure,
  evidencePathRejection,
  evidenceRefRejection,
  isBoundedEvidenceText,
  MAX_EVIDENCE_ARGV_ENTRIES,
  MAX_EVIDENCE_DECLARED_ENTRIES,
  type EvidenceFailure,
  type VerificationRecipe,
} from "./evidence-contract.js";

const LAYER = "EXECUTION" as const;

/**
 * Verifier execution is an OBSERVATION PORT, never a spawn.
 *
 * Nothing in this package launches a process. The caller supplies what it
 * observed — the argv actually used, how the run ended, the outputs it produced,
 * and the runtime it ran on — and this module decides what that proves, exactly
 * as the Claude adapter does for a provider run.
 */
export const EXECUTION_DISPOSITIONS = Object.freeze([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
] as const);

export type ExecutionDisposition = (typeof EXECUTION_DISPOSITIONS)[number];

export interface ObservedOutput {
  readonly path: string;
  readonly ref: ArtifactRef;
}

export interface ObservedVerifierExecution {
  readonly argv: readonly string[];
  readonly disposition: ExecutionDisposition;
  /** Safe integer or explicitly null; canonicalDigest throws on anything else. */
  readonly exitCode: number | null;
  readonly outputs: readonly ObservedOutput[];
  readonly runtimeObservation: ProviderRuntimeObservation;
  readonly startedAt: string;
  readonly completedAt: string;
}

function argvRejection(argv: readonly string[]): EvidenceFailure | null {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_EVIDENCE_ARGV_ENTRIES) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_EXECUTION_INVALID",
      LAYER,
      "observed argv must be a non-empty bounded list",
    );
  }
  for (const entry of argv) {
    if (!isBoundedEvidenceText(entry)) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_EXECUTION_INVALID",
        LAYER,
        `observed argv entry ${JSON.stringify(entry)} is not bounded normalized text`,
      );
    }
  }
  return null;
}

/**
 * Reconciles what the run produced against what the recipe declared. An output
 * at an undeclared path and a declared output that never appeared are different
 * facts, so they never collapse into one code.
 */
function outputsRejection(
  outputs: readonly ObservedOutput[],
  declaredOutputPaths: readonly string[],
): EvidenceFailure | null {
  if (!Array.isArray(outputs) || outputs.length > MAX_EVIDENCE_DECLARED_ENTRIES) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_EXECUTION_INVALID",
      LAYER,
      "observed outputs must be a bounded list",
    );
  }
  const declared = new Set(declaredOutputPaths);
  const seen = new Set<string>();
  for (const output of outputs) {
    if (typeof output !== "object" || output === null) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_EXECUTION_INVALID",
        LAYER,
        "every observed output must be a record",
      );
    }
    const pathFailure = evidencePathRejection(output.path, LAYER);
    if (pathFailure !== null) {
      return pathFailure;
    }
    if (!declared.has(output.path)) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_OUTPUT_UNDECLARED",
        LAYER,
        `output ${JSON.stringify(output.path)} is not declared by the recipe`,
        output.path,
      );
    }
    const refFailure = evidenceRefRejection(output.ref, LAYER, output.path);
    if (refFailure !== null) {
      return refFailure;
    }
    if (seen.has(output.path)) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_DECLARATION_DUPLICATE",
        LAYER,
        `output ${JSON.stringify(output.path)} was observed more than once`,
        output.path,
      );
    }
    seen.add(output.path);
  }
  for (const path of declared) {
    if (!seen.has(path)) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_OUTPUT_MISSING",
        LAYER,
        `declared output ${JSON.stringify(path)} was never produced`,
        path,
      );
    }
  }
  return null;
}

/** An observation that cannot re-derive its own digest attests nothing. */
function observationRejection(observation: ProviderRuntimeObservation): EvidenceFailure | null {
  let recomputes = false;
  try {
    recomputes = canonicalDigest(observationDigestInput(observation)) === observation.observationDigest;
  } catch {
    recomputes = false;
  }
  return recomputes
    ? null
    : evidenceFailure(
        "RUNNER_EVIDENCE_OBSERVATION_INVALID",
        LAYER,
        "runtime observation digest does not recompute",
      );
}

/**
 * Decides whether an observed execution is admissible as evidence of `recipe`.
 * Shape first, then what the observation actually proves.
 */
export function observedExecutionRejection(
  execution: ObservedVerifierExecution,
  recipe: VerificationRecipe,
): EvidenceFailure | null {
  if (typeof execution !== "object" || execution === null) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_EXECUTION_INVALID",
      LAYER,
      "observed execution must be a record",
    );
  }
  const argvFailure = argvRejection(execution.argv);
  if (argvFailure !== null) {
    return argvFailure;
  }
  if (!EXECUTION_DISPOSITIONS.includes(execution.disposition)) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_EXECUTION_INVALID",
      LAYER,
      `unknown execution disposition ${JSON.stringify(execution.disposition)}`,
    );
  }
  if (execution.exitCode !== null && !Number.isSafeInteger(execution.exitCode)) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_EXECUTION_INVALID",
      LAYER,
      "exit code must be a safe integer or explicitly null",
    );
  }
  if (
    !isCanonicalUtcTimestamp(execution.startedAt) ||
    !isCanonicalUtcTimestamp(execution.completedAt)
  ) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_TIMESTAMP_INVALID",
      LAYER,
      "execution timestamps must be caller-supplied canonical UTC instants",
    );
  }
  const observationFailure = observationRejection(execution.runtimeObservation);
  if (observationFailure !== null) {
    return observationFailure;
  }
  return outputsRejection(execution.outputs, recipe.declaredOutputPaths);
}
