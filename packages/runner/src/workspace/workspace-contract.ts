import type { ArtifactRef } from "../artifacts/artifact-contract.js";
import { isCommitIdentity, isHex64, isNormalizedText, isSafeByteCount } from "../canonical.js";
import { canonicalPathRejection } from "../scope/scope-contract.js";
import type { ScopeObservation } from "../scope/scope-contract.js";

export const WORKSPACE_INPUT_MANIFEST_VERSION = "moe-workspace-input-manifest/1" as const;
export const WORKSPACE_RESULT_MANIFEST_VERSION = "moe-workspace-result-manifest/1" as const;

export const MAX_WORKSPACE_ENTRIES = 4096;
export const MAX_WORKSPACE_REF_CHARS = 200;

/**
 * Closed rejection vocabulary. Every clean-candidate rule the design names gets
 * its own code — foreign bytes, an undeclared path, and a dirty declaration are
 * different facts about who owns a byte, and collapsing them would erase the
 * only signal a consumer has for what to do next.
 */
export const RUNNER_WORKSPACE_ERROR_CODES = Object.freeze([
  "RUNNER_WORKSPACE_BASE_IDENTITY_INVALID",
  "RUNNER_WORKSPACE_PATH_NOT_CANONICAL",
  "RUNNER_WORKSPACE_ENTRY_DIGEST_INVALID",
  "RUNNER_WORKSPACE_ENTRY_BYTE_LENGTH_INVALID",
  "RUNNER_WORKSPACE_ENTRY_DUPLICATE",
  "RUNNER_WORKSPACE_ENTRY_LIMIT",
  "RUNNER_WORKSPACE_PRODUCER_INVALID",
  "RUNNER_WORKSPACE_INPUT_MANIFEST_INVALID",
  "RUNNER_WORKSPACE_SCOPE_OBSERVATION_INVALID",
  "RUNNER_WORKSPACE_BASE_MISMATCH",
  "RUNNER_WORKSPACE_PATH_ESCAPED",
  "RUNNER_WORKSPACE_PATH_SYMLINKED",
  "RUNNER_WORKSPACE_PATH_KIND_UNSUPPORTED",
  "RUNNER_WORKSPACE_PATH_FOREIGN",
  "RUNNER_WORKSPACE_PATH_DIRTY",
  "RUNNER_WORKSPACE_PATH_STAGED",
  "RUNNER_WORKSPACE_PATH_UNTRACKED",
  "RUNNER_WORKSPACE_PATH_UNDECLARED",
  "RUNNER_WORKSPACE_ATTRIBUTION_UNKNOWN",
  "RUNNER_WORKSPACE_AUTHORED_PATH_OUT_OF_SCOPE",
  "RUNNER_WORKSPACE_INHERITED_PRODUCER_MISMATCH",
  "RUNNER_WORKSPACE_ARTIFACT_REF_INVALID",
  // Physical worktree materialization. Deliberate extension of the closed
  // roster: the allocator refuses on facts the manifest rules never see (a
  // half-created tree, a wrong HEAD, an escaped realpath), and a consumer that
  // cannot tell those apart cannot decide whether to retry, adopt, or quarantine.
  "RUNNER_WORKSPACE_WORKTREE_IDENTITY_INVALID",
  "RUNNER_WORKSPACE_WORKTREE_PARENT_INVALID",
  "RUNNER_WORKSPACE_WORKTREE_SOURCE_INVALID",
  "RUNNER_WORKSPACE_WORKTREE_COLLISION",
  "RUNNER_WORKSPACE_WORKTREE_PARTIAL",
  "RUNNER_WORKSPACE_WORKTREE_HEAD_MISMATCH",
  "RUNNER_WORKSPACE_WORKTREE_NOT_DETACHED",
  "RUNNER_WORKSPACE_WORKTREE_DIRTY",
  "RUNNER_WORKSPACE_WORKTREE_ESCAPED",
  "RUNNER_WORKSPACE_WORKTREE_OWNERSHIP_AMBIGUOUS",
  "RUNNER_WORKSPACE_WORKTREE_COMMAND_FAILED",
  "RUNNER_WORKSPACE_WORKTREE_OUTPUT_OVERFLOW",
  "RUNNER_WORKSPACE_WORKTREE_RELEASE_NOT_TERMINAL",
  "RUNNER_WORKSPACE_WORKTREE_RELEASE_FENCE_MISMATCH",
  "RUNNER_WORKSPACE_WORKTREE_RELEASE_UNCERTAIN",
] as const);

export type RunnerWorkspaceErrorCode = (typeof RUNNER_WORKSPACE_ERROR_CODES)[number];

/**
 * Producer identity is mandatory on every input entry because it is not
 * recoverable later: a content digest is one-way, so nothing downstream can ask
 * "which attempt produced these bytes" unless the input manifest already says.
 */
export type WorkspaceProducer =
  | { readonly kind: "BASE" }
  | {
      readonly kind: "PREDECESSOR";
      readonly attemptRef: string;
      readonly epoch: number;
      readonly adoptionRef?: string;
    };

export interface WorkspaceInputEntry {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly producer: WorkspaceProducer;
}

export interface WorkspaceInputManifest {
  readonly manifestVersion: typeof WORKSPACE_INPUT_MANIFEST_VERSION;
  readonly baseIdentity: string;
  readonly entries: readonly WorkspaceInputEntry[];
  readonly sha256: string;
}

export interface BuildInputManifestInput {
  readonly baseIdentity: string;
  readonly entries: readonly WorkspaceInputEntry[];
}

/** Observed by the workspace scanner: only a regular file can carry bytes here. */
export type ResultEntryKind = "REGULAR" | "SYMLINK" | "DIRECTORY" | "OTHER";

export type ResultEntryOrigin = "INHERITED" | "AUTHORED";

export interface ResultTreeEntry {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly origin: ResultEntryOrigin;
  readonly kind: ResultEntryKind;
}

export interface WorkspaceTreeEntry {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface BuildResultManifestInput {
  /** The full manifest, not just its digest: producer identity is validated here. */
  readonly inputManifest: WorkspaceInputManifest;
  readonly scopeObservation: ScopeObservation;
  readonly authoredPaths: readonly string[];
  readonly resultTreeEntries: readonly ResultTreeEntry[];
  readonly declaredArtifactRefs: readonly ArtifactRef[];
}

/**
 * DEFERRED, deliberately: the authored commit, the canonical authored delta,
 * receipts, decisions, and journal references the design also binds into a
 * sealed result belong to the later result-sealing task. This module builds the
 * tree, ownership, and digest core those fields will later be sealed alongside.
 */
export interface WorkspaceResultManifest {
  readonly manifestVersion: typeof WORKSPACE_RESULT_MANIFEST_VERSION;
  readonly baseIdentity: string;
  readonly inputManifestSha256: string;
  readonly scopeObservationSha256: string;
  readonly authoredPaths: readonly string[];
  readonly inheritedEntries: readonly WorkspaceTreeEntry[];
  readonly authoredEntries: readonly WorkspaceTreeEntry[];
  readonly declaredArtifactRefs: readonly ArtifactRef[];
  readonly sha256: string;
}

export type WorkspaceInputManifestBody = Omit<WorkspaceInputManifest, "sha256">;
export type WorkspaceResultManifestBody = Omit<WorkspaceResultManifest, "sha256">;

/**
 * The exact field set each digest covers. Producer and verifier recompute from
 * this one function, so the bound fields cannot drift apart. The result body
 * embeds both upstream digests, which is what transitively binds the base, the
 * scope observation, and the whole input tree into the result digest.
 */
export function inputManifestDigestInput(body: WorkspaceInputManifestBody): Record<string, unknown> {
  return {
    manifestVersion: body.manifestVersion,
    baseIdentity: body.baseIdentity,
    entries: body.entries,
  };
}

export function resultManifestDigestInput(body: WorkspaceResultManifestBody): Record<string, unknown> {
  return {
    manifestVersion: body.manifestVersion,
    baseIdentity: body.baseIdentity,
    inputManifestSha256: body.inputManifestSha256,
    scopeObservationSha256: body.scopeObservationSha256,
    authoredPaths: body.authoredPaths,
    inheritedEntries: body.inheritedEntries,
    authoredEntries: body.authoredEntries,
    declaredArtifactRefs: body.declaredArtifactRefs,
  };
}

export interface WorkspaceFailure {
  readonly ok: false;
  readonly code: RunnerWorkspaceErrorCode;
  readonly message: string;
  readonly path: string | null;
}

export type BuildInputManifestResult =
  | { readonly ok: true; readonly manifest: WorkspaceInputManifest }
  | WorkspaceFailure;

export type BuildResultManifestResult =
  | { readonly ok: true; readonly manifest: WorkspaceResultManifest }
  | WorkspaceFailure;

export function workspaceFailure(
  code: RunnerWorkspaceErrorCode,
  message: string,
  path: string | null = null,
): WorkspaceFailure {
  return Object.freeze({ ok: false as const, code, message, path });
}

export function isWorkspaceFailure(value: object): value is WorkspaceFailure {
  return "ok" in value && (value as { readonly ok: unknown }).ok === false;
}

/** Reuses the scope canonicalizer so both areas reject the same hostile paths. */
export function workspacePathRejection(path: unknown): WorkspaceFailure | null {
  if (typeof path !== "string") {
    return workspaceFailure("RUNNER_WORKSPACE_PATH_NOT_CANONICAL", "path must be a string");
  }
  const rejection = canonicalPathRejection(path);
  if (rejection !== null) {
    return workspaceFailure(
      "RUNNER_WORKSPACE_PATH_NOT_CANONICAL",
      `path ${JSON.stringify(path)} is not canonical (${rejection})`,
      path,
    );
  }
  return null;
}

export function isWorkspaceRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_WORKSPACE_REF_CHARS &&
    isNormalizedText(value)
  );
}

/** Normalizes to a fresh record so an absent adoption never reaches a digest as `undefined`. */
export function normalizeProducer(producer: WorkspaceProducer): WorkspaceProducer | null {
  if (producer === null || typeof producer !== "object") {
    return null;
  }
  if (producer.kind === "BASE") {
    return { kind: "BASE" };
  }
  if (producer.kind !== "PREDECESSOR") {
    return null;
  }
  if (!isWorkspaceRef(producer.attemptRef) || !isSafeByteCount(producer.epoch)) {
    return null;
  }
  if (producer.adoptionRef === undefined) {
    return { kind: "PREDECESSOR", attemptRef: producer.attemptRef, epoch: producer.epoch };
  }
  if (!isWorkspaceRef(producer.adoptionRef)) {
    return null;
  }
  return {
    kind: "PREDECESSOR",
    attemptRef: producer.attemptRef,
    epoch: producer.epoch,
    adoptionRef: producer.adoptionRef,
  };
}

export function bytesRejection(sha256: unknown, byteLength: unknown, path: string): WorkspaceFailure | null {
  if (!isHex64(sha256)) {
    return workspaceFailure("RUNNER_WORKSPACE_ENTRY_DIGEST_INVALID", "entry sha256 must be lowercase 64-hex", path);
  }
  if (!isSafeByteCount(byteLength)) {
    return workspaceFailure(
      "RUNNER_WORKSPACE_ENTRY_BYTE_LENGTH_INVALID",
      "entry byteLength must be a non-negative safe integer",
      path,
    );
  }
  return null;
}

export function baseIdentityRejection(baseIdentity: unknown): WorkspaceFailure | null {
  return isCommitIdentity(baseIdentity)
    ? null
    : workspaceFailure("RUNNER_WORKSPACE_BASE_IDENTITY_INVALID", "baseIdentity must be a 40- or 64-hex commit");
}

/** A declaration may name a directory, so containment is prefix-based on segments. */
export function isContainedBy(scopePath: string, path: string): boolean {
  return path === scopePath || path.startsWith(`${scopePath}/`);
}
