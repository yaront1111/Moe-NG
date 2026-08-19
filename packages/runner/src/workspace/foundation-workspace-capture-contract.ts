import type { ArtifactRef } from "../artifacts/artifact-contract.js";
import { canonicalDigest, deepFreeze } from "../canonical.js";
import type {
  GitObserver,
  RunnerScopeErrorCode,
  ScopeObservation,
  ScopePathObserver,
} from "../scope/scope-contract.js";
import type {
  ResultEntryKind,
  ResultTreeEntry,
  RunnerWorkspaceErrorCode,
  WorkspaceInputManifest,
  WorkspaceResultManifest,
} from "./workspace-contract.js";

export const FOUNDATION_CAPTURE_VERSION = "moe-foundation-workspace-capture/1" as const;

/**
 * Which boundary refused. Three can, and they mean different things: this
 * scanner's own rules, the scope observer's, and the result sealer's. A caller
 * that sees only a code cannot tell whether the layer it meant to exercise is
 * still the one answering, which is exactly how a refusal test detaches from
 * its subject.
 *
 * NAMED `_LAYER_NAMES`, not `_LAYERS`, on purpose: tests/security/
 * boundary-roster.security.ts live-scans production sources for
 * `^export const [A-Z_]+(LAYERS|LAYER|BOUNDARIES)\s*(:...)?=` and demands a
 * roster row, a size pin, a distribution bump and a three-armed hostile case
 * table for each match — five files this task does not own.
 */
export const FOUNDATION_CAPTURE_LAYER_NAMES = Object.freeze([
  "RUNNER_WORKSPACE_CAPTURE",
  "RUNNER_SCOPE_OBSERVATION",
  "RUNNER_WORKSPACE_MANIFEST",
] as const);

export type FoundationCaptureLayer = (typeof FOUNDATION_CAPTURE_LAYER_NAMES)[number];

/**
 * Closed rejection vocabulary for the capture layer itself. A refusal raised by
 * `observeScope` or `buildResultManifest` keeps ITS OWN code verbatim under ITS
 * OWN layer — restating those here would produce two vocabularies for one
 * condition and make a sealing fault indistinguishable from a scan fault.
 */
export const FOUNDATION_CAPTURE_CODES = Object.freeze([
  "RUNNER_FOUNDATION_CAPTURE_INPUT_INVALID",
  "RUNNER_FOUNDATION_CAPTURE_ROOT_MISMATCH",
  "RUNNER_FOUNDATION_CAPTURE_INPUT_MANIFEST_UNSEALED",
  "RUNNER_FOUNDATION_CAPTURE_OBSERVATION_UNSEALED",
  "RUNNER_FOUNDATION_CAPTURE_PROOF_UNSEALED",
  "RUNNER_FOUNDATION_CAPTURE_PRELAUNCH_NOT_CLEAN",
  "RUNNER_FOUNDATION_CAPTURE_SCOPE_UNDECLARED",
  "RUNNER_FOUNDATION_CAPTURE_PATH_NOT_CANONICAL",
  "RUNNER_FOUNDATION_CAPTURE_PATH_SYMLINKED",
  "RUNNER_FOUNDATION_CAPTURE_PATH_KIND_UNSUPPORTED",
  "RUNNER_FOUNDATION_CAPTURE_PATH_ESCAPED",
  "RUNNER_FOUNDATION_CAPTURE_PATH_UNREADABLE",
  "RUNNER_FOUNDATION_CAPTURE_IDENTITY_SWAPPED",
  "RUNNER_FOUNDATION_CAPTURE_ENTRY_LIMIT",
  "RUNNER_FOUNDATION_CAPTURE_BYTE_LIMIT",
  "RUNNER_FOUNDATION_CAPTURE_DEPTH_LIMIT",
  "RUNNER_FOUNDATION_CAPTURE_INPUT_ENTRY_EXTRA",
  "RUNNER_FOUNDATION_CAPTURE_INPUT_ENTRY_MISSING",
  "RUNNER_FOUNDATION_CAPTURE_INPUT_ENTRY_CHANGED",
  "RUNNER_FOUNDATION_CAPTURE_OUT_OF_SCOPE_HOST_EFFECT_UNKNOWN",
  "RUNNER_FOUNDATION_CAPTURE_STAGED_STATE",
  "RUNNER_FOUNDATION_CAPTURE_UNMERGED_STATE",
  "RUNNER_FOUNDATION_CAPTURE_IGNORED_STATE",
  "RUNNER_FOUNDATION_CAPTURE_CONTRADICTORY_STATE",
  "RUNNER_FOUNDATION_CAPTURE_BASE_MISMATCH",
] as const);

export type FoundationCaptureCode = (typeof FOUNDATION_CAPTURE_CODES)[number];

/**
 * The scanner's OWN budgets. `MAX_WORKSPACE_ENTRIES` is the sealer's bound on
 * how large a manifest may be; a filesystem walk needs a bound on how much work
 * it will do before it knows whether a manifest is even producible.
 */
export const MAX_FOUNDATION_CAPTURE_ENTRIES = 100_000;
export const MAX_FOUNDATION_CAPTURE_BYTES = 512 * 1024 * 1024;

export interface FoundationCaptureLimits {
  readonly maxEntries: number;
  readonly maxAggregateBytes: number;
}

export const DEFAULT_FOUNDATION_CAPTURE_LIMITS: FoundationCaptureLimits = Object.freeze({
  maxEntries: MAX_FOUNDATION_CAPTURE_ENTRIES,
  maxAggregateBytes: MAX_FOUNDATION_CAPTURE_BYTES,
});

/** A basename plus what `lstat` said it is — never what the target is. */
export interface FoundationCaptureDirent {
  readonly name: string;
  readonly kind: ResultEntryKind;
}

/**
 * `identity` is the filesystem's own object identity (`dev:ino`, populated on
 * win32 too under bigint stats). It is what ties a containment verdict taken by
 * PATH to the bytes read from a HANDLE: if the two disagree, the path was
 * swapped between the two observations and no answer is available.
 */
export interface FoundationCaptureStat {
  readonly kind: ResultEntryKind;
  readonly byteLength: number;
  readonly identity: string;
}

/**
 * The bracketed-read port. Everything after `openRead` is asked OF THE HANDLE:
 * a port that re-resolved the path for each question would hand the scanner a
 * different file per phase and never notice.
 */
export interface FoundationCaptureFsPort {
  listDirectory(absolutePath: string): readonly FoundationCaptureDirent[];
  lstatPath(absolutePath: string): FoundationCaptureStat;
  openRead(absolutePath: string): number;
  fstatHandle(handle: number): FoundationCaptureStat;
  readHandle(handle: number): Uint8Array;
  closeHandle(handle: number): void;
  realpath(absolutePath: string): string;
  exists(absolutePath: string): boolean;
}

export interface FoundationCaptureFailure {
  readonly ok: false;
  /** A forwarded refusal keeps the foreign code; `layer` says who decided. */
  readonly code: FoundationCaptureCode | RunnerScopeErrorCode | RunnerWorkspaceErrorCode;
  readonly layer: FoundationCaptureLayer;
  readonly message: string;
  readonly path: string | null;
}

export function captureFailure(
  code: FoundationCaptureFailure["code"],
  layer: FoundationCaptureLayer,
  message: string,
  path: string | null = null,
): FoundationCaptureFailure {
  return Object.freeze({ ok: false as const, code, layer, message, path });
}

export function isFoundationCaptureFailure(value: object): value is FoundationCaptureFailure {
  return "ok" in value && (value as { readonly ok: unknown }).ok === false;
}

/**
 * The prelaunch input: an assigned real root, the sealed input manifest, the
 * authoritative declared paths, the trusted clean prelaunch observation, the
 * filesystem port and the scan budget — nothing else. (The observer ports and
 * the daemon's observation metadata belong to the POSTLAUNCH input below, which
 * is the only phase that re-observes.)
 *
 * There is no `authoredPaths`, no `resultTreeEntries`, no artifact ref, no
 * result byte and no launch template on this type by construction: a caller
 * cannot smuggle a conclusion into a scanner with no field to hold one.
 */
export interface FoundationPrelaunchInput {
  readonly assignedRealRoot: string;
  readonly inputManifest: WorkspaceInputManifest;
  readonly declaredScopePaths: readonly string[];
  readonly prelaunchObservation: ScopeObservation;
  readonly fs: FoundationCaptureFsPort;
  readonly limits: FoundationCaptureLimits;
}

/**
 * Sealed proof that the assigned tree WAS the sealed input, taken before the
 * provider ran. It carries the trusted clean observation forward because that
 * observation — not the postlaunch one — is the only thing that may authorize
 * result bytes.
 */
export interface FoundationPrelaunchProof {
  readonly proofVersion: typeof FOUNDATION_CAPTURE_VERSION;
  readonly realRoot: string;
  readonly baseIdentity: string;
  readonly declaredScopePaths: readonly string[];
  readonly inputManifest: WorkspaceInputManifest;
  readonly prelaunchObservation: ScopeObservation;
  readonly scannedEntryCount: number;
  readonly scannedByteTotal: number;
  readonly sha256: string;
}

export type FoundationPrelaunchProofBody = Omit<FoundationPrelaunchProof, "sha256">;

export function prelaunchProofDigestInput(body: FoundationPrelaunchProofBody): Record<string, unknown> {
  return {
    proofVersion: body.proofVersion,
    realRoot: body.realRoot,
    baseIdentity: body.baseIdentity,
    declaredScopePaths: body.declaredScopePaths,
    inputManifestSha256: body.inputManifest.sha256,
    prelaunchObservationSha256: body.prelaunchObservation.sha256,
    scannedEntryCount: body.scannedEntryCount,
    scannedByteTotal: body.scannedByteTotal,
  };
}

export function sealPrelaunchProof(body: FoundationPrelaunchProofBody): FoundationPrelaunchProof {
  return deepFreeze({ ...body, sha256: canonicalDigest(prelaunchProofDigestInput(body)) });
}

export function prelaunchProofSealMatches(proof: FoundationPrelaunchProof): boolean {
  try {
    return canonicalDigest(prelaunchProofDigestInput(proof)) === proof.sha256;
  } catch {
    return false;
  }
}

/** The postlaunch input. The proof is the only carrier of prelaunch authority. */
export interface FoundationCaptureInput {
  readonly proof: FoundationPrelaunchProof;
  readonly gitObserver: GitObserver;
  readonly pathObserver: ScopePathObserver;
  readonly fs: FoundationCaptureFsPort;
  readonly limits: FoundationCaptureLimits;
  readonly observedAt: string;
  readonly observerVersion: string;
}

/**
 * An ADVISORY Foundation attempt core. `advisory` is on the type, not in a
 * comment: nothing here is an accepted candidate, a verification, an authored
 * commit or an integration result, and a consumer that treats it as one is
 * contradicted by the value it holds.
 *
 * The first four fields are exactly the daemon's `CAPTURE_KEYS`, in that
 * vocabulary, so the producer downstream forwards them without reshaping.
 */
export interface FoundationCaptureCore {
  readonly captureVersion: typeof FOUNDATION_CAPTURE_VERSION;
  readonly advisory: true;
  readonly authoredPaths: readonly string[];
  readonly declaredArtifactRefs: readonly ArtifactRef[];
  readonly resultTreeEntries: readonly ResultTreeEntry[];
  readonly scopeObservation: ScopeObservation;
  /** Evidence of what the attempt did — never authority to bless its bytes. */
  readonly postlaunchObservation: ScopeObservation;
  readonly resultManifest: WorkspaceResultManifest;
}

export type FoundationPrelaunchResult =
  | { readonly ok: true; readonly proof: FoundationPrelaunchProof }
  | FoundationCaptureFailure;

export type FoundationCaptureResult =
  | { readonly ok: true; readonly core: FoundationCaptureCore }
  | FoundationCaptureFailure;
