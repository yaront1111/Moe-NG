import { canonicalDigest, isCommitIdentity } from "../canonical.js";
import { isWorkspaceRef, type RunnerWorkspaceErrorCode } from "./workspace-contract.js";

export const WORKTREE_ASSIGNMENT_VERSION = "moe-worktree-assignment/1" as const;

/**
 * Two refusing layers, and a caller must be able to tell them apart: the
 * contract refuses on identities it can judge without touching a disk, the Node
 * adapter refuses on facts only a real repository can produce. Collapsing them
 * would hide whether a rejected attempt ever reached git at all.
 */
export const RUNNER_WORKTREE_LAYERS = Object.freeze([
  "WORKTREE_CONTRACT",
  "WORKTREE_NODE",
] as const);

export type RunnerWorktreeLayer = (typeof RUNNER_WORKTREE_LAYERS)[number];

/**
 * Release is fenced on proven caller intent, so a non-terminal value has to be
 * representable — otherwise "only TERMINAL releases" would be a type, not a
 * decision, and nothing would ever exercise the refusal.
 */
export const WORKTREE_RELEASE_INTENTS = Object.freeze([
  "ATTEMPT_TERMINAL",
  "ATTEMPT_ACTIVE",
] as const);

export type WorktreeReleaseIntent = (typeof WORKTREE_RELEASE_INTENTS)[number];

/** QUARANTINED means bytes were kept on purpose; nothing here ever deletes blind. */
export const WORKTREE_RELEASE_DISPOSITIONS = Object.freeze([
  "RELEASED",
  "QUARANTINED",
] as const);

export type WorktreeReleaseDisposition = (typeof WORKTREE_RELEASE_DISPOSITIONS)[number];

/**
 * No caller-selected target path, branch, ref, checkout flag, shell command,
 * environment, or cleanup path appears here on purpose. `sourceRepositoryRoot`
 * and `worktreeParent` are catalog-owned; `projectId`, `attemptId` and
 * `baseIdentity` are server-owned. Location is DERIVED from those, never chosen.
 */
export interface WorktreeMaterializationRequest {
  readonly sourceRepositoryRoot: string;
  readonly worktreeParent: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly baseIdentity: string;
}

export interface WorktreeTarget {
  readonly leaf: string;
  readonly worktreePath: string;
  readonly sourceRepositoryRoot: string;
  readonly worktreeParent: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly baseIdentity: string;
}

export interface WorktreeAssignment {
  readonly assignmentVersion: typeof WORKTREE_ASSIGNMENT_VERSION;
  readonly projectId: string;
  readonly attemptId: string;
  readonly baseIdentity: string;
  readonly leaf: string;
  readonly worktreePath: string;
  readonly realWorktreePath: string;
  readonly realWorktreeParent: string;
  readonly realSourceRepositoryRoot: string;
  readonly adopted: boolean;
}

export interface WorktreeFailure {
  readonly ok: false;
  readonly code: RunnerWorkspaceErrorCode;
  readonly layer: RunnerWorktreeLayer;
  readonly message: string;
  readonly path: string | null;
}

export type DeriveWorktreeTargetResult =
  | { readonly ok: true; readonly target: WorktreeTarget }
  | WorktreeFailure;

export type WorktreeMaterializationResult =
  | { readonly ok: true; readonly assignment: WorktreeAssignment }
  | WorktreeFailure;

export type WorktreeReleaseResult =
  | { readonly ok: true; readonly disposition: WorktreeReleaseDisposition }
  | WorktreeFailure;

export interface WorktreeReleaseRequest {
  readonly assignment: WorktreeAssignment;
  readonly callerIntent: WorktreeReleaseIntent;
}

/** The observed facts a fence needs. Every field is measured, never assumed. */
export interface WorktreeInspection {
  readonly exists: boolean;
  readonly hasGitMetadata: boolean;
  readonly realWorktreePath: string | null;
  readonly realWorktreeParent: string;
  readonly realSourceRepositoryRoot: string | null;
  readonly headCommit: string | null;
  readonly detached: boolean;
  readonly clean: boolean;
}

export interface WorktreeMaterializer {
  materialize(request: WorktreeMaterializationRequest): WorktreeMaterializationResult;
  release(request: WorktreeReleaseRequest): WorktreeReleaseResult;
}

export function worktreeFailure(
  code: RunnerWorkspaceErrorCode,
  layer: RunnerWorktreeLayer,
  message: string,
  path: string | null = null,
): WorktreeFailure {
  return Object.freeze({ ok: false as const, code, layer, message, path });
}

export function isWorktreeFailure(value: object): value is WorktreeFailure {
  return "ok" in value && (value as { readonly ok: unknown }).ok === false;
}

/**
 * Segment-aware containment, with the separator as a parameter so the rule is
 * one function on every platform and both separators are reachable from a test
 * on either host. A bare `startsWith` would admit `/parent-evil` under `/parent`.
 */
export function isContainedByPath(parent: string, path: string, separator: string): boolean {
  if (parent.length === 0) return false;
  const base = parent.endsWith(separator) ? parent.slice(0, -separator.length) : parent;
  return path === base || path.startsWith(`${base}${separator}`);
}

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const UNSAFE_LEAF_CHARACTERS = /[^A-Za-z0-9._-]/gu;
const MAX_SLUG_CHARS = 24;
const DERIVATION_DIGEST_CHARS = 16;

function isAbsoluteRoot(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (value.includes("\0")) return false;
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

function slug(identity: string): string {
  return identity.replace(UNSAFE_LEAF_CHARACTERS, "_").slice(0, MAX_SLUG_CHARS);
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && isWorkspaceRef(value) && IDENTITY_PATTERN.test(value);
}

/**
 * The leaf carries both identities in readable form AND a digest over the exact
 * pair. Slugging is lossy, so the readable half alone could collide across two
 * distinct attempts; the digest is what makes a path collision require an
 * identity collision. Same inputs produce byte-identical output, which is also
 * what lets an exact replay adopt its own tree instead of creating a second one.
 */
export function deriveWorktreeLeaf(projectId: string, attemptId: string): string {
  const digest = canonicalDigest({ attemptId, projectId }).slice(0, DERIVATION_DIGEST_CHARS);
  return `${slug(projectId)}-${slug(attemptId)}-${digest}`;
}

function joinUnder(parent: string, leaf: string): string {
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  const base = parent.endsWith("/") || parent.endsWith("\\") ? parent.slice(0, -1) : parent;
  return `${base}${separator}${leaf}`;
}

/** Pure: the only authority is the request, and the request cannot name a path. */
export function deriveWorktreeTarget(
  request: WorktreeMaterializationRequest,
): DeriveWorktreeTargetResult {
  const refuse = (code: RunnerWorkspaceErrorCode, message: string, path: string | null = null) =>
    worktreeFailure(code, "WORKTREE_CONTRACT", message, path);
  if (request === null || typeof request !== "object") {
    return refuse("RUNNER_WORKSPACE_WORKTREE_IDENTITY_INVALID", "request must be an object");
  }
  if (!isAbsoluteRoot(request.sourceRepositoryRoot)) {
    return refuse(
      "RUNNER_WORKSPACE_WORKTREE_SOURCE_INVALID",
      "sourceRepositoryRoot must be an absolute path",
      typeof request.sourceRepositoryRoot === "string" ? request.sourceRepositoryRoot : null,
    );
  }
  if (!isAbsoluteRoot(request.worktreeParent)) {
    return refuse(
      "RUNNER_WORKSPACE_WORKTREE_PARENT_INVALID",
      "worktreeParent must be an absolute path",
      typeof request.worktreeParent === "string" ? request.worktreeParent : null,
    );
  }
  if (!isIdentity(request.projectId) || !isIdentity(request.attemptId)) {
    return refuse(
      "RUNNER_WORKSPACE_WORKTREE_IDENTITY_INVALID",
      "projectId and attemptId must be canonical identities",
    );
  }
  if (!isCommitIdentity(request.baseIdentity)) {
    return refuse(
      "RUNNER_WORKSPACE_BASE_IDENTITY_INVALID",
      "baseIdentity must be a 40- or 64-hex commit",
    );
  }
  const leaf = deriveWorktreeLeaf(request.projectId, request.attemptId);
  return Object.freeze({
    ok: true as const,
    target: Object.freeze({
      leaf,
      worktreePath: joinUnder(request.worktreeParent, leaf),
      sourceRepositoryRoot: request.sourceRepositoryRoot,
      worktreeParent: request.worktreeParent,
      projectId: request.projectId,
      attemptId: request.attemptId,
      baseIdentity: request.baseIdentity,
    }),
  });
}

/**
 * The whole fence, as one pure rule over measured facts. The adapter calls this
 * both after creating a tree and before adopting one, so "verified" and
 * "adopted" can never drift into two different definitions of the same word.
 */
export function worktreeStateRejection(
  target: WorktreeTarget,
  inspection: WorktreeInspection,
  expectedSourceRepositoryRoot: string,
  separator: string,
): WorktreeFailure | null {
  const refuse = (code: RunnerWorkspaceErrorCode, message: string) =>
    worktreeFailure(code, "WORKTREE_NODE", message, target.worktreePath);
  if (!inspection.hasGitMetadata || inspection.realWorktreePath === null) {
    return refuse(
      "RUNNER_WORKSPACE_WORKTREE_PARTIAL",
      "worktree path exists without reachable git metadata",
    );
  }
  if (!isContainedByPath(inspection.realWorktreeParent, inspection.realWorktreePath, separator)) {
    return refuse(
      "RUNNER_WORKSPACE_WORKTREE_ESCAPED",
      `worktree realpath ${inspection.realWorktreePath} resolves outside its parent`,
    );
  }
  if (inspection.realSourceRepositoryRoot === null) {
    return refuse(
      "RUNNER_WORKSPACE_WORKTREE_OWNERSHIP_AMBIGUOUS",
      "worktree does not name a single owning repository",
    );
  }
  if (inspection.realSourceRepositoryRoot !== expectedSourceRepositoryRoot) {
    return refuse(
      "RUNNER_WORKSPACE_WORKTREE_OWNERSHIP_MISMATCH",
      "worktree is owned by a different repository",
    );
  }
  if (!inspection.detached) {
    return refuse("RUNNER_WORKSPACE_WORKTREE_NOT_DETACHED", "worktree HEAD is not detached");
  }
  if (inspection.headCommit !== target.baseIdentity) {
    return refuse(
      "RUNNER_WORKSPACE_WORKTREE_HEAD_MISMATCH",
      `worktree HEAD is ${inspection.headCommit ?? "unreadable"}, not ${target.baseIdentity}`,
    );
  }
  if (!inspection.clean) {
    return refuse("RUNNER_WORKSPACE_WORKTREE_DIRTY", "worktree has uncommitted changes");
  }
  return null;
}
