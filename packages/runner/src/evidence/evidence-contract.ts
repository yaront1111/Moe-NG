import { refRejection, type ArtifactRef } from "../artifacts/artifact-contract.js";
import { isNormalizedText } from "../canonical.js";
import { canonicalPathRejection } from "../scope/scope-contract.js";

/**
 * Shared vocabulary for the evidence receipt pipeline.
 *
 * A recipe says what a verifier was asked to do, a rematerialization rebuilds the
 * exact bytes it was asked to do it to, and a receipt records what an observed
 * execution proved. Every one of those is content-addressed, so the version
 * literals below are pinned: a digest is only comparable across time if the field
 * set it covers is named by a version that changes when the field set does.
 */
export const VERIFICATION_RECIPE_VERSION = "moe-verification-recipe/1" as const;
export const EVIDENCE_RECEIPT_VERSION = "moe-evidence-receipt/1" as const;

export const MAX_EVIDENCE_ARGV_ENTRIES = 128;
export const MAX_EVIDENCE_TEXT_CHARS = 400;
export const MAX_EVIDENCE_DECLARED_ENTRIES = 1024;
export const MAX_EVIDENCE_OBLIGATIONS = 64;

/**
 * Which gate refused. Recorded on every failure because more than one layer can
 * refuse the same call: without this a shape gate answering first would leave a
 * test green while it no longer exercises the rule it was written for.
 */
export const EVIDENCE_REFUSAL_LAYERS = Object.freeze([
  "RECIPE_SHAPE",
  "RECIPE_BINDING",
  "REMATERIALIZATION",
  "EXECUTION",
  "RECEIPT_SHAPE",
  "RECEIPT_BINDING",
  "OBLIGATION",
] as const);

export type EvidenceRefusalLayer = (typeof EVIDENCE_REFUSAL_LAYERS)[number];

/**
 * Closed rejection vocabulary. Foreign bytes, undeclared bytes, and a ref that no
 * longer matches its address are different facts about who owns a byte; a generic
 * failure would erase the only signal a consumer has for what to do next.
 */
export const RUNNER_EVIDENCE_ERROR_CODES = Object.freeze([
  "RUNNER_EVIDENCE_ARGV_INVALID",
  "RUNNER_EVIDENCE_ARGV_LIMIT",
  "RUNNER_EVIDENCE_ARGV_DIVERGENCE",
  "RUNNER_EVIDENCE_PATH_NOT_CANONICAL",
  "RUNNER_EVIDENCE_ARTIFACT_REF_INVALID",
  "RUNNER_EVIDENCE_DECLARATION_LIMIT",
  "RUNNER_EVIDENCE_DECLARATION_DUPLICATE",
  "RUNNER_EVIDENCE_VERIFIER_IDENTITY_INVALID",
  "RUNNER_EVIDENCE_RECIPE_DIGEST_MISMATCH",
  "RUNNER_EVIDENCE_CANDIDATE_NOT_EMPTY",
  "RUNNER_EVIDENCE_CANDIDATE_PORT_FAILED",
  "RUNNER_EVIDENCE_FOREIGN_BYTES",
  "RUNNER_EVIDENCE_UNDECLARED_BYTES",
  "RUNNER_EVIDENCE_DECLARED_BYTES_MISSING",
  "RUNNER_EVIDENCE_ARTIFACT_UNVERIFIABLE",
  "RUNNER_EVIDENCE_REF_MISMATCH",
  "RUNNER_EVIDENCE_MANIFEST_TAMPERED",
  "RUNNER_EVIDENCE_INPUT_TREE_DIVERGENCE",
  "RUNNER_EVIDENCE_INPUT_MANIFEST_INVALID",
  "RUNNER_EVIDENCE_RESULT_MANIFEST_INVALID",
  "RUNNER_EVIDENCE_MANIFEST_BINDING_MISMATCH",
  "RUNNER_EVIDENCE_OBSERVATION_INVALID",
  "RUNNER_EVIDENCE_OBSERVATION_UNKNOWN",
  "RUNNER_EVIDENCE_EXECUTION_INVALID",
  "RUNNER_EVIDENCE_EXECUTION_UNKNOWN",
  "RUNNER_EVIDENCE_OUTPUT_UNDECLARED",
  "RUNNER_EVIDENCE_OUTPUT_MISSING",
  "RUNNER_EVIDENCE_TIMESTAMP_INVALID",
  "RUNNER_EVIDENCE_IDENTITY_INVALID",
  "RUNNER_EVIDENCE_OBLIGATION_KIND_INVALID",
  "RUNNER_EVIDENCE_OBLIGATION_SUPPORT_INVALID",
  "RUNNER_EVIDENCE_OBLIGATION_LIMIT",
  "RUNNER_EVIDENCE_AGENT_TEXT_UNSUPPORTED",
] as const);

export type RunnerEvidenceErrorCode = (typeof RUNNER_EVIDENCE_ERROR_CODES)[number];

/** What a receipt is allowed to claim was proven. Closed, so nothing new is provable by accident. */
export const EVIDENCE_OBLIGATION_KINDS = Object.freeze([
  "COMMAND_EXIT",
  "OUTPUT_PRESENT",
  "RESULT_TREE_SEALED",
  "RUNTIME_PINNED",
] as const);

export type EvidenceObligationKind = (typeof EVIDENCE_OBLIGATION_KINDS)[number];

/**
 * What backs a discharged obligation. Every member is digest-bound, so nothing
 * prose-shaped ever reaches a receipt — `AGENT_REPORT` carries only the author
 * and a digest of what they wrote. It exists so the nearest legal attempt has a
 * representable shape and a coded refusal, never so it can discharge anything.
 */
export type ObligationSupport =
  | { readonly kind: "ARTIFACT"; readonly ref: ArtifactRef }
  | { readonly kind: "RESULT_TREE"; readonly manifestSha256: string }
  | { readonly kind: "RUNTIME_OBSERVATION"; readonly observationSha256: string }
  | { readonly kind: "AGENT_REPORT"; readonly reportedBy: string; readonly reportSha256: string };

export interface DischargedObligation {
  readonly kind: EvidenceObligationKind;
  readonly support: ObligationSupport;
}

export interface EvidenceFailure {
  readonly ok: false;
  readonly code: RunnerEvidenceErrorCode;
  readonly layer: EvidenceRefusalLayer;
  readonly message: string;
  readonly path: string | null;
}

export function evidenceFailure(
  code: RunnerEvidenceErrorCode,
  layer: EvidenceRefusalLayer,
  message: string,
  path: string | null = null,
): EvidenceFailure {
  return Object.freeze({ ok: false as const, code, layer, message, path });
}

export function isEvidenceFailure(value: object): value is EvidenceFailure {
  return "ok" in value && (value as { readonly ok: unknown }).ok === false;
}

export function isBoundedEvidenceText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EVIDENCE_TEXT_CHARS &&
    isNormalizedText(value)
  );
}

/** Opaque caller-supplied reference (graph, lease, effect). Shape only: this task owns none of their semantics. */
export const isEvidenceIdentity = isBoundedEvidenceText;

/** Reuses the scope canonicalizer so evidence rejects exactly the paths the workspace does. */
export function evidencePathRejection(
  path: unknown,
  layer: EvidenceRefusalLayer,
): EvidenceFailure | null {
  if (typeof path !== "string") {
    return evidenceFailure("RUNNER_EVIDENCE_PATH_NOT_CANONICAL", layer, "path must be a string");
  }
  const rejection = canonicalPathRejection(path);
  return rejection === null
    ? null
    : evidenceFailure(
        "RUNNER_EVIDENCE_PATH_NOT_CANONICAL",
        layer,
        `path ${JSON.stringify(path)} is not canonical (${rejection})`,
        path,
      );
}

/** Delegates to the artifact package's own validator; this module never re-implements one. */
export function evidenceRefRejection(
  ref: unknown,
  layer: EvidenceRefusalLayer,
  path: string | null = null,
): EvidenceFailure | null {
  if (typeof ref !== "object" || ref === null) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_ARTIFACT_REF_INVALID",
      layer,
      "artifact reference must be a record",
      path,
    );
  }
  const rejection = refRejection(ref as ArtifactRef);
  return rejection === null
    ? null
    : evidenceFailure("RUNNER_EVIDENCE_ARTIFACT_REF_INVALID", layer, rejection, path);
}

export interface DeclaredInput {
  readonly path: string;
  readonly ref: ArtifactRef;
}

export interface VerifierIdentity {
  readonly verifierId: string;
  readonly verifierVersion: string;
  readonly capabilitySchemaDigest: string;
}

export interface VerificationRecipe {
  readonly recipeVersion: typeof VERIFICATION_RECIPE_VERSION;
  readonly argv: readonly string[];
  readonly declaredInputs: readonly DeclaredInput[];
  readonly declaredOutputPaths: readonly string[];
  readonly verifierIdentity: VerifierIdentity;
  readonly sha256: string;
}

export type VerificationRecipeBody = Omit<VerificationRecipe, "sha256">;

export interface BuildVerificationRecipeInput {
  readonly argv: readonly string[];
  readonly declaredInputs: readonly DeclaredInput[];
  readonly declaredOutputPaths: readonly string[];
  readonly verifierIdentity: VerifierIdentity;
}

export type BuildVerificationRecipeResult =
  | { readonly ok: true; readonly recipe: VerificationRecipe }
  | EvidenceFailure;

/**
 * The exact field set the recipe digest covers. Producer and verifier recompute
 * from this one function, so the bound fields cannot drift apart, and the digest
 * provably does not cover itself.
 */
export function recipeDigestInput(body: VerificationRecipeBody): Record<string, unknown> {
  return {
    recipeVersion: body.recipeVersion,
    argv: body.argv,
    declaredInputs: body.declaredInputs.map((entry) => ({
      path: entry.path,
      sha256: entry.ref.sha256,
      byteLength: entry.ref.byteLength,
    })),
    declaredOutputPaths: body.declaredOutputPaths,
    verifierIdentity: {
      verifierId: body.verifierIdentity.verifierId,
      verifierVersion: body.verifierIdentity.verifierVersion,
      capabilitySchemaDigest: body.verifierIdentity.capabilitySchemaDigest,
    },
  };
}
