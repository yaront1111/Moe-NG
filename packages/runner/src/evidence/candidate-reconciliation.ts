import type { ArtifactRef } from "../artifacts/artifact-contract.js";
import { canonicalDigest, isHex64, isSafeByteCount } from "../canonical.js";
import {
  inputManifestDigestInput,
  type WorkspaceInputManifest,
} from "../workspace/workspace-contract.js";
import { evidenceFailure, type EvidenceFailure } from "./evidence-contract.js";

const LAYER = "REMATERIALIZATION" as const;

export interface CandidateTreeEntry {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export type PortRead<T> = { readonly ok: true; readonly value: T } | EvidenceFailure;

/** Turns one port call into a coded refusal so no boundary can throw past this area. */
export function portAttempt<T>(action: () => T): PortRead<T> {
  try {
    return { ok: true as const, value: action() };
  } catch (error) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_CANDIDATE_PORT_FAILED",
      LAYER,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** A listing crosses a port, so its shape is a claim rather than a guarantee. */
export function scanRejection(entries: readonly CandidateTreeEntry[]): EvidenceFailure | null {
  if (!Array.isArray(entries)) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_CANDIDATE_PORT_FAILED",
      LAYER,
      "candidate listing must be a list of entries",
    );
  }
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_CANDIDATE_PORT_FAILED",
        LAYER,
        "every candidate entry must be a record",
      );
    }
    if (
      typeof entry.path !== "string" ||
      !isHex64(entry.sha256) ||
      !isSafeByteCount(entry.byteLength)
    ) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_CANDIDATE_PORT_FAILED",
        LAYER,
        "candidate entry needs a path, a sha256 digest, and a byte count",
      );
    }
  }
  return null;
}

/**
 * Reconciles what is actually in the tree against what the recipe declared.
 *
 * FOREIGN and UNDECLARED are deliberately separate facts. A path the recipe
 * mentions nowhere is content from outside the recipe entirely; a path the recipe
 * declares only as an OUTPUT slot holds content no ref declares, because
 * rematerialization runs before the verifier has produced anything. Collapsing
 * them would erase which one a consumer is looking at.
 */
export function reconcile(
  observed: readonly CandidateTreeEntry[],
  declared: ReadonlyMap<string, ArtifactRef>,
  declaredOutputPaths: readonly string[],
): EvidenceFailure | null {
  const outputs = new Set(declaredOutputPaths);
  const seen = new Set<string>();
  for (const entry of observed) {
    const ref = declared.get(entry.path);
    if (ref === undefined) {
      return outputs.has(entry.path)
        ? evidenceFailure(
            "RUNNER_EVIDENCE_UNDECLARED_BYTES",
            LAYER,
            `output ${JSON.stringify(entry.path)} holds content no declared ref covers`,
            entry.path,
          )
        : evidenceFailure(
            "RUNNER_EVIDENCE_FOREIGN_BYTES",
            LAYER,
            `path ${JSON.stringify(entry.path)} is not declared by this recipe`,
            entry.path,
          );
    }
    if (entry.sha256 !== ref.sha256 || entry.byteLength !== ref.byteLength) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_REF_MISMATCH",
        LAYER,
        `path ${JSON.stringify(entry.path)} does not hold the declared content`,
        entry.path,
      );
    }
    seen.add(entry.path);
  }
  for (const path of declared.keys()) {
    if (!seen.has(path)) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_DECLARED_BYTES_MISSING",
        LAYER,
        `declared path ${JSON.stringify(path)} is absent from the rematerialized tree`,
        path,
      );
    }
  }
  return null;
}

/** An unsealed expectation is tampered; a sealed one that names another tree is divergence. */
export function expectationRejection(
  expected: WorkspaceInputManifest,
  fresh: WorkspaceInputManifest,
): EvidenceFailure | null {
  let recomputes = false;
  try {
    recomputes = canonicalDigest(inputManifestDigestInput(expected)) === expected.sha256;
  } catch {
    recomputes = false;
  }
  if (!recomputes) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_MANIFEST_TAMPERED",
      LAYER,
      "expected input manifest digest does not recompute",
    );
  }
  return expected.sha256 === fresh.sha256
    ? null
    : evidenceFailure(
        "RUNNER_EVIDENCE_INPUT_TREE_DIVERGENCE",
        LAYER,
        `rematerialized tree ${fresh.sha256} does not match expected ${expected.sha256}`,
      );
}
