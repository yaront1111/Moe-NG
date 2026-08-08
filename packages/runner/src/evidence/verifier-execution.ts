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

const invalid = (message: string): EvidenceFailure =>
  evidenceFailure("RUNNER_EVIDENCE_EXECUTION_INVALID", LAYER, message);

/**
 * Read by INDEX, never by iterator. `Array.isArray` is true for a subclass, and a
 * subclass can override `Symbol.iterator` to yield values its indices never held
 * — so a `for...of` validation pass and an index-based comparison would be
 * inspecting two different lists. Every structural read in this module walks
 * indices up to the checked `length` so exactly one list is ever seen.
 */
function argvRejection(argv: readonly string[]): EvidenceFailure | null {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_EVIDENCE_ARGV_ENTRIES) {
    return invalid("observed argv must be a non-empty bounded list");
  }
  for (let index = 0; index < argv.length; index += 1) {
    if (!isBoundedEvidenceText(argv[index])) {
      return invalid(
        `observed argv entry ${JSON.stringify(argv[index])} is not bounded normalized text`,
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
    return invalid("observed outputs must be a bounded list");
  }
  const declared = new Set(declaredOutputPaths);
  const seen = new Set<string>();
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index] as ObservedOutput;
    if (typeof output !== "object" || output === null) {
      return invalid("every observed output must be a record");
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

/**
 * The check that makes a receipt evidence of ITS recipe rather than of some other
 * run that happened to produce the same outputs. Order counts, because argv order
 * is the command.
 */
function argvDivergence(
  observed: readonly string[],
  declared: readonly string[],
): EvidenceFailure | null {
  if (observed.length !== declared.length) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_ARGV_DIVERGENCE",
      LAYER,
      `observed argv has ${observed.length} entries, the recipe declares ${declared.length}`,
    );
  }
  for (let index = 0; index < declared.length; index += 1) {
    if (observed[index] !== declared[index]) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_ARGV_DIVERGENCE",
        LAYER,
        `observed argv entry ${index} is ${JSON.stringify(observed[index])}, the recipe declares ${JSON.stringify(declared[index])}`,
      );
    }
  }
  return null;
}

/**
 * An observation that cannot re-derive its own digest attests nothing, and one
 * whose truth class is UNKNOWN never gains authority: unverifiable evidence stays
 * unverifiable rather than being upgraded by having been recorded.
 */
function observationRejection(observation: ProviderRuntimeObservation): EvidenceFailure | null {
  let recomputes = false;
  try {
    recomputes = canonicalDigest(observationDigestInput(observation)) === observation.observationDigest;
  } catch {
    recomputes = false;
  }
  if (!recomputes) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_OBSERVATION_INVALID",
      LAYER,
      "runtime observation digest does not recompute",
    );
  }
  return observation.truthClass === "PROVEN"
    ? null
    : evidenceFailure(
        "RUNNER_EVIDENCE_OBSERVATION_UNKNOWN",
        LAYER,
        `runtime observation truth class is ${observation.truthClass} and can discharge nothing`,
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
    return invalid("observed execution must be a record");
  }
  const argvFailure = argvRejection(execution.argv);
  if (argvFailure !== null) {
    return argvFailure;
  }
  if (!EXECUTION_DISPOSITIONS.includes(execution.disposition)) {
    return invalid(`unknown execution disposition ${JSON.stringify(execution.disposition)}`);
  }
  const divergence = argvDivergence(execution.argv, recipe.argv);
  if (divergence !== null) {
    return divergence;
  }
  // A FAILED run is a proven fact and still earns a receipt; an UNKNOWN one is
  // the absence of a fact, so it yields nothing at all.
  if (execution.disposition === "UNKNOWN") {
    return evidenceFailure(
      "RUNNER_EVIDENCE_EXECUTION_UNKNOWN",
      LAYER,
      "an execution whose disposition is UNKNOWN cannot discharge an obligation",
    );
  }
  if (execution.exitCode !== null && !Number.isSafeInteger(execution.exitCode)) {
    return invalid("exit code must be a safe integer or explicitly null");
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
