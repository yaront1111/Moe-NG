import { canonicalDigest, deepFreeze, isPlainRecord } from "../canonical.js";
import { scopeObservationDigestInput, type ScopeObservation } from "../scope/scope-contract.js";
import { observeScope } from "../scope/scope-observation.js";
import {
  captureFailure,
  FOUNDATION_CAPTURE_VERSION,
  isFoundationCaptureFailure,
  prelaunchProofSealMatches,
  sealPrelaunchProof,
  type FoundationCaptureFailure,
  type FoundationCaptureInput,
  type FoundationCaptureResult,
  type FoundationPrelaunchInput,
  type FoundationPrelaunchProof,
  type FoundationPrelaunchResult,
} from "./foundation-workspace-capture-contract.js";
import { isInside, scanDeclaredTrees } from "./foundation-workspace-capture-node.js";
import {
  declarationRejection,
  deriveCapture,
  gitStateRejection,
  limitsRejection,
  outOfScopeRejection,
  scannedTreeRejection,
} from "./foundation-workspace-capture-rules.js";
import { inputManifestDigestInput, type WorkspaceInputManifest } from "./workspace-contract.js";
import { buildResultManifest } from "./workspace-manifest.js";

/**
 * The two public entry points of the Foundation workspace capture scanner.
 *
 * They are a PAIR, and the order is the whole point. `proveFoundationPrelaunchTree`
 * runs before the provider is launched and answers one question: is the assigned
 * worktree, byte for byte, the tree its sealed input manifest describes? Only
 * that answer — carried in a sealed proof — authorizes anything afterwards.
 * `captureFoundationWorkspaceDelta` runs after the provider exits and derives
 * what changed, then hands the sealer the PRELAUNCH observation the proof
 * carries. A postlaunch observation sees the attempt's own writes as DIRTY or
 * UNTRACKED, and `buildResultManifest` only admits result bytes under a scope
 * entry whose attribution is CLEAN or ABSENT; re-observing "to get a fresh
 * observation" before sealing would therefore either self-reject or, worse,
 * let a dirty observation bless the very bytes that made it dirty.
 *
 * Nothing here is an accepted candidate, a verification, an authored commit or
 * an integration result. The output says so on its own type.
 */

const LAYER = "RUNNER_WORKSPACE_CAPTURE" as const;

function sealed(body: Record<string, unknown>, sha256: string): boolean {
  try {
    return canonicalDigest(body) === sha256;
  } catch {
    return false;
  }
}

const isSealedManifest = (manifest: WorkspaceInputManifest): boolean =>
  sealed(inputManifestDigestInput(manifest), manifest.sha256);

const isSealedObservation = (observation: ScopeObservation): boolean =>
  sealed(scopeObservationDigestInput(observation), observation.sha256);

/**
 * Shape guards for what a caller hands in, before any of it is dereferenced.
 *
 * A crash is not a refusal: an absent port or a manifest that is not a record
 * would otherwise surface as a TypeError, which carries no reason code and
 * cannot be branched on. `declaredScopePaths` is checked as an array because
 * `new Set("work")` silently succeeds and yields four one-character "paths".
 */
function shapeRejection(input: {
  readonly assignedRealRoot?: unknown;
  readonly fs?: unknown;
  readonly inputManifest?: unknown;
  readonly prelaunchObservation?: unknown;
  readonly declaredScopePaths?: unknown;
}): FoundationCaptureFailure | null {
  const invalid = (detail: string): FoundationCaptureFailure =>
    captureFailure("RUNNER_FOUNDATION_CAPTURE_INPUT_INVALID", LAYER, detail);
  if (typeof input.assignedRealRoot !== "string" || input.assignedRealRoot.length === 0) {
    return invalid("assignedRealRoot must be a non-empty string");
  }
  if (input.fs === null || typeof input.fs !== "object") {
    return invalid("a filesystem port is required");
  }
  if (!isPlainRecord(input.inputManifest) || !isPlainRecord(input.prelaunchObservation)) {
    return invalid("the sealed input manifest and the prelaunch observation must be records");
  }
  if (!Array.isArray(input.declaredScopePaths) || input.declaredScopePaths.some((path) => typeof path !== "string")) {
    return invalid("declaredScopePaths must be an array of strings");
  }
  return null;
}

function rootRejection(observed: string, expected: string): FoundationCaptureFailure | null {
  return isInside(expected, observed) && isInside(observed, expected)
    ? null
    : captureFailure(
        "RUNNER_FOUNDATION_CAPTURE_ROOT_MISMATCH",
        LAYER,
        `observed worktree ${JSON.stringify(observed)} is not the assigned root ${JSON.stringify(expected)}`,
      );
}

/**
 * Proves the assigned tree IS its sealed input, under a trusted clean
 * prelaunch observation, and seals that proof.
 *
 * Every refusal here is a refusal to proceed, never a narrowing: an extra file,
 * a missing file, changed bytes, a symlink, an escape, an unreadable path, an
 * unsupported kind or a mid-scan swap all stop the capture rather than shrink
 * the answer to whatever could still be agreed on.
 */
export function proveFoundationPrelaunchTree(input: FoundationPrelaunchInput): FoundationPrelaunchResult {
  const shapeFailure = shapeRejection(input);
  if (shapeFailure !== null) return shapeFailure;
  const limitsFailure = limitsRejection(input.limits);
  if (limitsFailure !== null) return limitsFailure;
  if (!isSealedManifest(input.inputManifest)) {
    return captureFailure("RUNNER_FOUNDATION_CAPTURE_INPUT_MANIFEST_UNSEALED", LAYER, "the input manifest digest does not recompute");
  }
  if (!isSealedObservation(input.prelaunchObservation)) {
    return captureFailure("RUNNER_FOUNDATION_CAPTURE_OBSERVATION_UNSEALED", LAYER, "the prelaunch observation digest does not recompute");
  }
  if (input.inputManifest.baseIdentity !== input.prelaunchObservation.baseIdentity) {
    return captureFailure(
      "RUNNER_FOUNDATION_CAPTURE_BASE_MISMATCH",
      LAYER,
      `input manifest base ${input.inputManifest.baseIdentity} does not match observed base ${input.prelaunchObservation.baseIdentity}`,
    );
  }
  let realRoot: string;
  try {
    realRoot = input.fs.realpath(input.assignedRealRoot);
  } catch {
    return captureFailure("RUNNER_FOUNDATION_CAPTURE_ROOT_MISMATCH", LAYER, "the assigned root could not be resolved");
  }
  const rootFailure =
    rootRejection(realRoot, input.assignedRealRoot) ??
    rootRejection(input.prelaunchObservation.worktreeIdentity, realRoot);
  if (rootFailure !== null) return rootFailure;
  const declarationFailure = declarationRejection(input.declaredScopePaths, input.prelaunchObservation);
  if (declarationFailure !== null) return declarationFailure;

  const scanned = scanDeclaredTrees(input.fs, realRoot, input.declaredScopePaths, input.limits);
  if (isFoundationCaptureFailure(scanned)) return scanned;
  const equality = scannedTreeRejection(scanned, input.inputManifest.entries);
  if (equality !== null) return equality;
  const proof = sealPrelaunchProof({
    proofVersion: FOUNDATION_CAPTURE_VERSION,
    realRoot,
    baseIdentity: input.inputManifest.baseIdentity,
    declaredScopePaths: [...input.declaredScopePaths].sort(),
    inputManifest: input.inputManifest,
    prelaunchObservation: input.prelaunchObservation,
    scannedEntryCount: scanned.length,
    scannedByteTotal: scanned.reduce((total, file) => total + file.byteLength, 0),
  });
  return Object.freeze({ ok: true as const, proof });
}

/**
 * Re-observes and re-scans the proven tree after the attempt ran, derives the
 * delta from BYTES, and delegates all validation and sealing to the production
 * `buildResultManifest` under the PRELAUNCH observation.
 */
export function captureFoundationWorkspaceDelta(input: FoundationCaptureInput): FoundationCaptureResult {
  const { proof } = input;
  if (!isPlainRecord(proof) || !prelaunchProofSealMatches(proof as FoundationPrelaunchProof)) {
    return captureFailure("RUNNER_FOUNDATION_CAPTURE_PROOF_UNSEALED", LAYER, "the prelaunch proof digest does not recompute");
  }
  const shapeFailure = shapeRejection({
    assignedRealRoot: proof.realRoot,
    fs: input.fs,
    inputManifest: proof.inputManifest,
    prelaunchObservation: proof.prelaunchObservation,
    declaredScopePaths: proof.declaredScopePaths,
  });
  if (shapeFailure !== null) return shapeFailure;
  // The proof digest binds the two upstream DIGESTS, not their bodies, so a
  // caller could swap in a manifest or observation carrying the same `sha256`
  // field over different entries and the proof seal would still recompute.
  // Re-verifying both here is what makes that swap unrepresentable.
  if (!isSealedManifest(proof.inputManifest)) {
    return captureFailure("RUNNER_FOUNDATION_CAPTURE_INPUT_MANIFEST_UNSEALED", LAYER, "the proven input manifest digest does not recompute");
  }
  if (!isSealedObservation(proof.prelaunchObservation)) {
    return captureFailure("RUNNER_FOUNDATION_CAPTURE_OBSERVATION_UNSEALED", LAYER, "the proven prelaunch observation digest does not recompute");
  }
  const limitsFailure = limitsRejection(input.limits);
  if (limitsFailure !== null) return limitsFailure;
  const observed = observeScope({
    worktreeRoot: proof.realRoot,
    baseIdentity: proof.baseIdentity,
    declaredScopePaths: proof.declaredScopePaths,
    gitObserver: input.gitObserver,
    pathObserver: input.pathObserver,
    observedAt: input.observedAt,
    observerVersion: input.observerVersion,
  });
  if (!observed.ok) {
    return captureFailure(observed.code, "RUNNER_SCOPE_OBSERVATION", observed.message, observed.path);
  }
  const postlaunchObservation = observed.observation;
  const rootFailure = rootRejection(postlaunchObservation.worktreeIdentity, proof.realRoot);
  if (rootFailure !== null) return rootFailure;
  const attribution = postlaunchObservation.gitAttribution;
  const outOfScope = outOfScopeRejection(attribution.changedPaths, proof.declaredScopePaths);
  if (outOfScope !== null) return outOfScope;
  const stateFailure = gitStateRejection(postlaunchObservation);
  if (stateFailure !== null) return stateFailure;

  const scanned = scanDeclaredTrees(input.fs, proof.realRoot, proof.declaredScopePaths, input.limits);
  if (isFoundationCaptureFailure(scanned)) return scanned;
  const { authoredPaths, resultTreeEntries } = deriveCapture(proof.inputManifest.entries, scanned);
  // The closed M1 value. Artifact declaration is a separate capability, and a
  // scanner that accepted refs from a caller would be sealing a claim it never
  // observed. Pinned HERE rather than in the shared sealer, which other
  // producers legitimately hand non-empty refs.
  const declaredArtifactRefs = Object.freeze([]);
  const sealedResult = buildResultManifest({
    inputManifest: proof.inputManifest,
    scopeObservation: proof.prelaunchObservation,
    authoredPaths,
    resultTreeEntries,
    declaredArtifactRefs,
  });
  if (!sealedResult.ok) {
    return captureFailure(sealedResult.code, "RUNNER_WORKSPACE_MANIFEST", sealedResult.message, sealedResult.path);
  }
  return Object.freeze({
    ok: true as const,
    core: deepFreeze({
      captureVersion: FOUNDATION_CAPTURE_VERSION,
      advisory: true as const,
      authoredPaths,
      declaredArtifactRefs,
      resultTreeEntries,
      scopeObservation: proof.prelaunchObservation,
      postlaunchObservation,
      resultManifest: sealedResult.manifest,
    }),
  });
}
