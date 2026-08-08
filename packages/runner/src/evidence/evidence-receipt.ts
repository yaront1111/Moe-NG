import { canonicalDigest, deepFreeze } from "../canonical.js";
import {
  inputManifestDigestInput,
  resultManifestDigestInput,
  type WorkspaceInputManifest,
  type WorkspaceResultManifest,
} from "../workspace/workspace-contract.js";
import {
  EVIDENCE_RECEIPT_VERSION,
  evidenceFailure,
  isEvidenceFailure,
  isEvidenceIdentity,
  type DischargedObligation,
  type EvidenceFailure,
  type VerificationRecipe,
} from "./evidence-contract.js";
import { canonicalObligations } from "./receipt-obligations.js";
import { recipeSealMatches } from "./verification-recipe.js";
import {
  observedExecutionRejection,
  type ObservedOutput,
  type ObservedVerifierExecution,
} from "./verifier-execution.js";

export interface ReceiptTimestamps {
  readonly startedAt: string;
  readonly completedAt: string;
}

/**
 * The local evidence key for one verification.
 *
 * Every field is digest-bound evidence: manifest digests owned by the workspace
 * foundation, a runtime observation bound by its own digest, content-addressed
 * output refs, caller-supplied canonical instants, the recipe digest, and opaque
 * graph/lease/effect identities. There is deliberately NO field through which
 * agent prose could arrive — that is the primary enforcement of "agent-reported
 * text cannot satisfy a verification obligation", not a runtime check.
 *
 * The execution's disposition is an admissibility gate rather than a bound field:
 * it decides whether a receipt exists at all, and what the receipt then attests
 * is exactly the list above.
 */
export interface EvidenceReceipt {
  readonly receiptVersion: typeof EVIDENCE_RECEIPT_VERSION;
  readonly argv: readonly string[];
  readonly recipeSha256: string;
  readonly inputTreeSha256: string;
  readonly resultTreeSha256: string;
  readonly runtimeObservationSha256: string;
  readonly outputs: readonly ObservedOutput[];
  readonly timestamps: ReceiptTimestamps;
  readonly graphIdentity: string;
  readonly leaseIdentity: string;
  readonly effectIdentity: string;
  readonly obligations: readonly DischargedObligation[];
  readonly sha256: string;
}

export type EvidenceReceiptBody = Omit<EvidenceReceipt, "sha256">;

export interface BuildEvidenceReceiptInput {
  readonly recipe: VerificationRecipe;
  readonly execution: ObservedVerifierExecution;
  readonly inputManifest: WorkspaceInputManifest;
  readonly resultManifest: WorkspaceResultManifest;
  readonly graphIdentity: string;
  readonly leaseIdentity: string;
  readonly effectIdentity: string;
  readonly obligations: readonly DischargedObligation[];
}

export type BuildEvidenceReceiptResult =
  | { readonly ok: true; readonly receipt: EvidenceReceipt }
  | EvidenceFailure;

/**
 * The exact field set the receipt digest covers, and the one place it is named.
 * Producer and verifier recompute from here, so the bound fields cannot drift,
 * and the digest provably does not cover itself.
 */
export function receiptDigestInput(body: EvidenceReceiptBody): Record<string, unknown> {
  return {
    receiptVersion: body.receiptVersion,
    argv: body.argv,
    recipeSha256: body.recipeSha256,
    inputTreeSha256: body.inputTreeSha256,
    resultTreeSha256: body.resultTreeSha256,
    runtimeObservationSha256: body.runtimeObservationSha256,
    outputs: body.outputs.map((output) => ({
      path: output.path,
      sha256: output.ref.sha256,
      byteLength: output.ref.byteLength,
    })),
    timestamps: {
      startedAt: body.timestamps.startedAt,
      completedAt: body.timestamps.completedAt,
    },
    graphIdentity: body.graphIdentity,
    leaseIdentity: body.leaseIdentity,
    effectIdentity: body.effectIdentity,
    obligations: body.obligations.map((obligation) => ({
      kind: obligation.kind,
      support: { ...obligation.support },
    })),
  };
}

function identityRejection(input: BuildEvidenceReceiptInput): EvidenceFailure | null {
  const named: ReadonlyArray<readonly [string, unknown]> = [
    ["graph", input.graphIdentity],
    ["lease", input.leaseIdentity],
    ["effect", input.effectIdentity],
  ];
  for (const [label, value] of named) {
    if (!isEvidenceIdentity(value)) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_IDENTITY_INVALID",
        "RECEIPT_SHAPE",
        `${label} identity must be a bounded normalized reference`,
      );
    }
  }
  return null;
}

function sealMatches(digestInput: Record<string, unknown>, sha256: string): boolean {
  try {
    return canonicalDigest(digestInput) === sha256;
  } catch {
    return false;
  }
}

/** The trees are the workspace foundation's; this module binds their digests, never re-derives them. */
function manifestRejection(input: BuildEvidenceReceiptInput): EvidenceFailure | null {
  const { inputManifest, resultManifest } = input;
  if (!sealMatches(inputManifestDigestInput(inputManifest), inputManifest.sha256)) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_INPUT_MANIFEST_INVALID",
      "RECEIPT_BINDING",
      "input manifest digest does not recompute",
    );
  }
  if (!sealMatches(resultManifestDigestInput(resultManifest), resultManifest.sha256)) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_RESULT_MANIFEST_INVALID",
      "RECEIPT_BINDING",
      "result manifest digest does not recompute",
    );
  }
  return resultManifest.inputManifestSha256 === inputManifest.sha256
    ? null
    : evidenceFailure(
        "RUNNER_EVIDENCE_MANIFEST_BINDING_MISMATCH",
        "RECEIPT_BINDING",
        `result tree was sealed against input tree ${resultManifest.inputManifestSha256}`,
      );
}

const byPath = (left: ObservedOutput, right: ObservedOutput): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

/**
 * Builds the receipt once every piece of evidence has proven itself: the recipe
 * re-derives its own digest, both manifests re-derive theirs and the result tree
 * names this input tree, and the observed execution is admissible against the
 * recipe. Only then are the obligations checked against what this receipt
 * actually binds.
 */
export function buildEvidenceReceipt(
  input: BuildEvidenceReceiptInput,
): BuildEvidenceReceiptResult {
  if (!recipeSealMatches(input.recipe)) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_RECIPE_DIGEST_MISMATCH",
      "RECEIPT_BINDING",
      "recipe digest does not describe the recipe it is attached to",
    );
  }
  const identityFailure = identityRejection(input);
  if (identityFailure !== null) {
    return identityFailure;
  }
  const manifestFailure = manifestRejection(input);
  if (manifestFailure !== null) {
    return manifestFailure;
  }
  const executionFailure = observedExecutionRejection(input.execution, input.recipe);
  if (executionFailure !== null) {
    return executionFailure;
  }
  const { execution } = input;
  const outputs = execution.outputs
    .map((output) => ({
      path: output.path,
      ref: { sha256: output.ref.sha256, byteLength: output.ref.byteLength },
    }))
    .sort(byPath);
  const obligations = canonicalObligations(input.obligations, {
    outputRefs: outputs.map((output) => output.ref),
    resultTreeSha256: input.resultManifest.sha256,
    runtimeObservationSha256: execution.runtimeObservation.observationDigest,
  });
  if (isEvidenceFailure(obligations)) {
    return obligations;
  }
  const body = {
    receiptVersion: EVIDENCE_RECEIPT_VERSION,
    // Bound from the recipe, which the divergence check has just proven the run
    // used. Re-reading execution.argv here would be a SECOND structural read of a
    // caller-supplied list, and a list that answers differently on its second
    // read could smuggle argv past the check that just approved it.
    argv: [...input.recipe.argv],
    recipeSha256: input.recipe.sha256,
    inputTreeSha256: input.inputManifest.sha256,
    resultTreeSha256: input.resultManifest.sha256,
    runtimeObservationSha256: execution.runtimeObservation.observationDigest,
    outputs,
    timestamps: { startedAt: execution.startedAt, completedAt: execution.completedAt },
    graphIdentity: input.graphIdentity,
    leaseIdentity: input.leaseIdentity,
    effectIdentity: input.effectIdentity,
    obligations,
  } as const satisfies EvidenceReceiptBody;
  const receipt = deepFreeze({ ...body, sha256: canonicalDigest(receiptDigestInput(body)) });
  return Object.freeze({ ok: true as const, receipt });
}
