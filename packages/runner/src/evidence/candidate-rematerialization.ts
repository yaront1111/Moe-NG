import { join } from "node:path";

import {
  refMatches,
  type ArtifactFsPort,
  type ArtifactRef,
  type ArtifactStore,
} from "../artifacts/artifact-contract.js";
import {
  type WorkspaceInputEntry,
  type WorkspaceInputManifest,
  type WorkspaceProducer,
} from "../workspace/workspace-contract.js";
import { buildInputManifest } from "../workspace/workspace-manifest.js";
import {
  expectationRejection,
  portAttempt,
  reconcile,
  scanRejection,
  type CandidateTreeEntry,
} from "./candidate-reconciliation.js";
import {
  evidenceFailure,
  type EvidenceFailure,
  type VerificationRecipe,
} from "./evidence-contract.js";
import { recipeSealMatches } from "./verification-recipe.js";

export type { CandidateTreeEntry } from "./candidate-reconciliation.js";

const LAYER = "REMATERIALIZATION" as const;

/**
 * The candidate location as a port. Real filesystem access lives only in the
 * caller's adapter, so this module can be exercised against a hostile tree that
 * gains or loses bytes mid-run without ever spawning or touching a disk.
 */
export interface CandidateTreePort {
  list(): readonly CandidateTreeEntry[];
  write(path: string, bytes: Uint8Array): void;
  remove(path: string): void;
}

export interface RematerializeCandidateInput {
  readonly recipe: VerificationRecipe;
  readonly baseIdentity: string;
  readonly producer: WorkspaceProducer;
  readonly artifacts: ArtifactStore;
  readonly artifactFs: ArtifactFsPort;
  /** Store root; object layout mirrors createArtifactStore's `<root>/objects/<sha256>`. */
  readonly artifactRoot: string;
  readonly candidate: CandidateTreePort;
  /** When present, the tree this rematerialization must reproduce exactly. */
  readonly expectedInputManifest?: WorkspaceInputManifest;
}

export type RematerializeCandidateResult =
  | {
      readonly ok: true;
      readonly inputManifest: WorkspaceInputManifest;
      readonly materializedPaths: readonly string[];
    }
  | EvidenceFailure;

/**
 * Rebuilds a clean candidate tree from a recipe's declared closure.
 *
 * Bytes reach the tree only after the artifact store's own verification and a
 * `refMatches` check on what was actually read back, so a swap between those two
 * reads cannot survive. Any refusal after the first write removes every byte this
 * call wrote: a refused rematerialization must not leave a partial tree that a
 * later run could inherit.
 */
export function rematerializeCandidate(
  input: RematerializeCandidateInput,
): RematerializeCandidateResult {
  const { recipe, candidate } = input;
  if (!recipeSealMatches(recipe)) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_RECIPE_DIGEST_MISMATCH",
      LAYER,
      "recipe digest does not describe the recipe it is attached to",
    );
  }
  const empty = requireEmptyCandidate(candidate);
  if (empty !== null) {
    return empty;
  }

  const written: string[] = [];
  const refuse = (failure: EvidenceFailure): EvidenceFailure => {
    for (const path of written) {
      try {
        candidate.remove(path);
      } catch {
        // A failed cleanup never upgrades a refusal into a materialized tree.
      }
    }
    return failure;
  };

  const declared = new Map<string, ArtifactRef>();
  for (const entry of recipe.declaredInputs) {
    const materialized = materializeOne(input, entry.path, entry.ref);
    if (!materialized.ok) {
      return refuse(materialized);
    }
    written.push(entry.path);
    declared.set(entry.path, entry.ref);
  }

  const after = portAttempt(() => candidate.list());
  if (!after.ok) {
    return refuse(after);
  }
  const afterRejection = scanRejection(after.value);
  if (afterRejection !== null) {
    return refuse(afterRejection);
  }
  const mismatch = reconcile(after.value, declared, recipe.declaredOutputPaths);
  if (mismatch !== null) {
    return refuse(mismatch);
  }
  return sealInputTree(input, written, refuse);
}

/** Clean start: a stale prior tree must not be able to contribute a single byte. */
function requireEmptyCandidate(candidate: CandidateTreePort): EvidenceFailure | null {
  const before = portAttempt(() => candidate.list());
  if (!before.ok) {
    return before;
  }
  const rejection = scanRejection(before.value);
  if (rejection !== null) {
    return rejection;
  }
  return before.value.length === 0
    ? null
    : evidenceFailure(
        "RUNNER_EVIDENCE_CANDIDATE_NOT_EMPTY",
        LAYER,
        `candidate location already holds ${before.value.length} entries`,
        before.value[0]?.path ?? null,
      );
}

/** The input tree identity is the workspace foundation's; this module derives no second one. */
function sealInputTree(
  input: RematerializeCandidateInput,
  written: readonly string[],
  refuse: (failure: EvidenceFailure) => EvidenceFailure,
): RematerializeCandidateResult {
  const entries: WorkspaceInputEntry[] = input.recipe.declaredInputs.map((entry) => ({
    path: entry.path,
    sha256: entry.ref.sha256,
    byteLength: entry.ref.byteLength,
    producer: input.producer,
  }));
  const manifest = buildInputManifest({ baseIdentity: input.baseIdentity, entries });
  if (!manifest.ok) {
    return refuse(
      evidenceFailure(
        "RUNNER_EVIDENCE_INPUT_MANIFEST_INVALID",
        LAYER,
        `input manifest refused: ${manifest.code} ${manifest.message}`,
        manifest.path,
      ),
    );
  }
  if (input.expectedInputManifest !== undefined) {
    const divergence = expectationRejection(input.expectedInputManifest, manifest.manifest);
    if (divergence !== null) {
      return refuse(divergence);
    }
  }
  return Object.freeze({
    ok: true as const,
    inputManifest: manifest.manifest,
    materializedPaths: Object.freeze([...written]),
  });
}

/** Verified by the store, re-checked with refMatches, then written — in that order. */
function materializeOne(
  input: RematerializeCandidateInput,
  path: string,
  ref: ArtifactRef,
): { readonly ok: true } | EvidenceFailure {
  const verified = input.artifacts.verifyArtifact(ref);
  if (!verified.ok) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_ARTIFACT_UNVERIFIABLE",
      LAYER,
      `declared input ${JSON.stringify(path)} is unverifiable: ${verified.code} ${verified.message}`,
      path,
    );
  }
  const read = portAttempt(() =>
    input.artifactFs.readAll(join(input.artifactRoot, "objects", ref.sha256)),
  );
  if (!read.ok) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_ARTIFACT_UNVERIFIABLE",
      LAYER,
      `declared input ${JSON.stringify(path)} could not be read: ${read.message}`,
      path,
    );
  }
  if (!refMatches(read.value, ref)) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_REF_MISMATCH",
      LAYER,
      `bytes read for ${JSON.stringify(path)} no longer match ${ref.sha256}`,
      path,
    );
  }
  const wrote = portAttempt(() => input.candidate.write(path, read.value));
  return wrote.ok ? { ok: true as const } : wrote;
}
