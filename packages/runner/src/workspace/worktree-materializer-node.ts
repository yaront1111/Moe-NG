import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import { isCommitIdentity } from "../canonical.js";
import { hermeticGitEnvironment } from "../scope/scope-git.js";
import type { RunnerWorkspaceErrorCode } from "./workspace-contract.js";
import {
  WORKTREE_ASSIGNMENT_VERSION,
  deriveWorktreeLeaf,
  deriveWorktreeTarget,
  isContainedByPath,
  worktreeFailure,
  worktreeStateRejection,
  type WorktreeAssignment,
  type WorktreeFailure,
  type WorktreeInspection,
  type WorktreeMaterializationRequest,
  type WorktreeMaterializationResult,
  type WorktreeMaterializer,
  type WorktreeReleaseRequest,
  type WorktreeReleaseResult,
  type WorktreeTarget,
} from "./worktree-materializer-contract.js";

/**
 * The observer's 30s budget is wrong here on purpose: `worktree add --detach`
 * writes a whole checkout, which routinely outruns a read-only status call.
 * Exported so the budget is a pinned decision, not a stray literal.
 */
export const WORKTREE_GIT_TIMEOUT_MS = 120_000;
export const MAX_WORKTREE_COMMAND_BYTES = 4 * 1024 * 1024;

type GitRun =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly overflow: boolean; readonly detail: string };

/**
 * Module-private on purpose: exporting it would widen a deliberately small
 * public surface for zero consumer benefit. The execFileSync discipline is
 * transcribed from the scope observer — argv array, `shell: false`, no inherited
 * GIT_* state — so no request field can ever become a command.
 */
function runGit(cwd: string, environment: NodeJS.ProcessEnv, args: readonly string[]): GitRun {
  try {
    const stdout = execFileSync(
      "git",
      [
        "--no-replace-objects",
        "-c",
        `safe.directory=${cwd}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        ...args,
      ],
      {
        cwd,
        encoding: "buffer",
        env: environment,
        maxBuffer: MAX_WORKTREE_COMMAND_BYTES,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: WORKTREE_GIT_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    return { ok: true, stdout: new TextDecoder("utf-8").decode(new Uint8Array(stdout)) };
  } catch (error) {
    const overflow = (error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    return { ok: false, overflow, detail: `git ${args[0] ?? ""} failed` };
  }
}

function fail(
  code: RunnerWorkspaceErrorCode,
  message: string,
  path: string | null,
): WorktreeFailure {
  return worktreeFailure(code, "WORKTREE_NODE", message, path);
}

/** A truncated observation is worse than none, so overflow keeps its own code. */
function commandFailure(run: Extract<GitRun, { ok: false }>, path: string): WorktreeFailure {
  const code = run.overflow
    ? "RUNNER_WORKSPACE_WORKTREE_OUTPUT_OVERFLOW"
    : "RUNNER_WORKSPACE_WORKTREE_COMMAND_FAILED";
  return fail(code, run.detail, path);
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Git prints POSIX separators even on win32, so both sides are normalized. */
function samePath(left: string, right: string): boolean {
  const canonical = (value: string): string => {
    const slashed = value.replace(/\\/gu, "/").replace(/\/+$/u, "");
    return process.platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  return canonical(left) === canonical(right);
}

function isRegistered(listing: string, physicalPath: string): boolean {
  return listing
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .some((line) => samePath(line.slice("worktree ".length).trim(), physicalPath));
}

function isFailure(value: WorktreeInspection | WorktreeFailure): value is WorktreeFailure {
  return "ok" in value;
}

/**
 * Measures the tree. Every field is read from git or the filesystem; nothing is
 * inferred from the fact that a creation command exited zero.
 */
function inspect(
  physicalPath: string,
  realParent: string,
  environment: NodeJS.ProcessEnv,
): WorktreeInspection | WorktreeFailure {
  const realWorktreePath = existsSync(physicalPath) ? realpathOrNull(physicalPath) : null;
  const absent: WorktreeInspection = {
    exists: realWorktreePath !== null,
    hasGitMetadata: false,
    realWorktreePath,
    realWorktreeParent: realParent,
    realSourceRepositoryRoot: null,
    headCommit: null,
    detached: false,
    clean: false,
  };
  if (realWorktreePath === null) return absent;
  const run = (args: readonly string[]): GitRun => runGit(realWorktreePath, environment, args);
  const commonDir = run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!commonDir.ok) return commonDir.overflow ? commandFailure(commonDir, physicalPath) : absent;
  const resolved = realpathOrNull(commonDir.stdout.trim());
  const owner =
    resolved !== null && basename(resolved).toLowerCase() === ".git"
      ? realpathOrNull(dirname(resolved))
      : null;
  const head = run(["rev-parse", "HEAD"]);
  const status = run(["status", "--porcelain=v1", "--untracked-files=all"]);
  for (const command of [head, status]) {
    if (!command.ok && command.overflow) return commandFailure(command, physicalPath);
  }
  // `symbolic-ref --quiet HEAD` exits non-zero exactly when HEAD is detached.
  const symbolic = run(["symbolic-ref", "--quiet", "HEAD"]);
  const headCommit = head.ok ? head.stdout.trim() : "";
  return {
    exists: true,
    hasGitMetadata: true,
    realWorktreePath,
    realWorktreeParent: realParent,
    realSourceRepositoryRoot: owner,
    headCommit: isCommitIdentity(headCommit) ? headCommit : null,
    detached: !symbolic.ok,
    clean: status.ok && status.stdout.trim().length === 0,
  };
}

function assignmentOf(
  target: WorktreeTarget,
  inspection: WorktreeInspection,
  adopted: boolean,
): WorktreeAssignment {
  return Object.freeze({
    assignmentVersion: WORKTREE_ASSIGNMENT_VERSION,
    projectId: target.projectId,
    attemptId: target.attemptId,
    baseIdentity: target.baseIdentity,
    leaf: target.leaf,
    worktreePath: target.worktreePath,
    realWorktreePath: inspection.realWorktreePath as string,
    realWorktreeParent: inspection.realWorktreeParent,
    realSourceRepositoryRoot: inspection.realSourceRepositoryRoot as string,
    adopted,
  });
}

/**
 * Verifies before it returns, and never removes bytes on a failed verification:
 * an unproven tree is retained for a human, exactly as a failed release
 * quarantines one.
 */
function verify(
  target: WorktreeTarget,
  physicalPath: string,
  realParent: string,
  adopted: boolean,
  environment: NodeJS.ProcessEnv,
): WorktreeMaterializationResult {
  const inspection = inspect(physicalPath, realParent, environment);
  if (isFailure(inspection)) return inspection;
  const rejection = worktreeStateRejection(target, inspection, sep);
  if (rejection !== null) return rejection;
  return Object.freeze({ ok: true as const, assignment: assignmentOf(target, inspection, adopted) });
}

function materialize(
  request: WorktreeMaterializationRequest,
  environment: NodeJS.ProcessEnv,
): WorktreeMaterializationResult {
  const derived = deriveWorktreeTarget(request);
  if (!derived.ok) return derived;
  const target = derived.target;
  const realSource = realpathOrNull(target.sourceRepositoryRoot);
  if (realSource === null) {
    const message = "sourceRepositoryRoot is unresolvable";
    return fail("RUNNER_WORKSPACE_WORKTREE_SOURCE_INVALID", message, target.sourceRepositoryRoot);
  }
  const realParent = realpathOrNull(target.worktreeParent);
  if (realParent === null) {
    const message = "worktreeParent is unresolvable";
    return fail("RUNNER_WORKSPACE_WORKTREE_PARENT_INVALID", message, target.worktreeParent);
  }
  const physicalPath = join(realParent, target.leaf);
  const listing = runGit(realSource, environment, ["worktree", "list", "--porcelain"]);
  if (!listing.ok) return commandFailure(listing, target.sourceRepositoryRoot);
  // Registered means this repository already owns the derived path, so an exact
  // replay adopts instead of creating a second tree for the same attempt.
  if (isRegistered(listing.stdout, physicalPath)) {
    return verify(target, physicalPath, realParent, true, environment);
  }
  if (existsSync(physicalPath)) {
    // Occupied by something this repository does not own. Guessing here is how
    // another agent's bytes get checked out over.
    const message = "derived worktree path is occupied by an unregistered tree";
    return fail("RUNNER_WORKSPACE_WORKTREE_COLLISION", message, physicalPath);
  }
  const argv = ["worktree", "add", "--detach", physicalPath, target.baseIdentity];
  const created = runGit(realSource, environment, argv);
  if (!created.ok) return commandFailure(created, physicalPath);
  return verify(target, physicalPath, realParent, false, environment);
}

/**
 * A forged assignment must not be able to name a path its identities do not
 * derive. Every field is type-checked BEFORE `deriveWorktreeLeaf` sees it: a
 * non-string identity would make the derivation throw, and a crash is not a
 * refusal — the caller would get a stack trace where a stable code belongs.
 */
function isFencedAssignment(assignment: WorktreeAssignment): boolean {
  return (
    assignment.assignmentVersion === WORKTREE_ASSIGNMENT_VERSION &&
    typeof assignment.leaf === "string" &&
    typeof assignment.projectId === "string" &&
    typeof assignment.attemptId === "string" &&
    typeof assignment.realWorktreePath === "string" &&
    typeof assignment.realWorktreeParent === "string" &&
    typeof assignment.realSourceRepositoryRoot === "string" &&
    isCommitIdentity(assignment.baseIdentity) &&
    deriveWorktreeLeaf(assignment.projectId, assignment.attemptId) === assignment.leaf &&
    samePath(join(assignment.realWorktreeParent, assignment.leaf), assignment.realWorktreePath) &&
    isContainedByPath(assignment.realWorktreeParent, assignment.realWorktreePath, sep)
  );
}

/**
 * Release is fenced on the exact assignment identity and on proven terminal
 * caller intent. Anything it cannot prove is retained: QUARANTINED is a
 * deliberate decision to keep bytes, never a failure to delete them.
 */
function release(
  request: WorktreeReleaseRequest,
  environment: NodeJS.ProcessEnv,
): WorktreeReleaseResult {
  const assignment = request?.assignment as WorktreeAssignment | undefined;
  if (assignment === undefined || assignment === null || typeof assignment !== "object") {
    return fail("RUNNER_WORKSPACE_WORKTREE_RELEASE_FENCE_MISMATCH", "release needs an assignment", null);
  }
  const named = typeof assignment.worktreePath === "string" ? assignment.worktreePath : null;
  if (request.callerIntent !== "ATTEMPT_TERMINAL") {
    const message = "release requires proven terminal caller intent";
    return fail("RUNNER_WORKSPACE_WORKTREE_RELEASE_NOT_TERMINAL", message, named);
  }
  if (!isFencedAssignment(assignment)) {
    const message = "assignment identity does not derive its own path";
    return fail("RUNNER_WORKSPACE_WORKTREE_RELEASE_FENCE_MISMATCH", message, named);
  }
  const physicalPath = join(assignment.realWorktreeParent, assignment.leaf);
  const released = Object.freeze({ ok: true as const, disposition: "RELEASED" as const });
  if (!existsSync(physicalPath)) return released;
  const inspection = inspect(physicalPath, assignment.realWorktreeParent, environment);
  if (isFailure(inspection)) return inspection;
  const owned =
    inspection.hasGitMetadata &&
    inspection.realSourceRepositoryRoot !== null &&
    samePath(inspection.realSourceRepositoryRoot, assignment.realSourceRepositoryRoot) &&
    inspection.headCommit === assignment.baseIdentity &&
    inspection.realWorktreePath !== null &&
    samePath(inspection.realWorktreePath, assignment.realWorktreePath);
  // Not provably ours: keep the bytes. Deleting an unknown path is the single
  // failure mode this whole seam exists to make impossible.
  if (!owned) return Object.freeze({ ok: true as const, disposition: "QUARANTINED" as const });
  // No `--force`: git's own refusal on a dirty tree becomes our uncertainty.
  const argv = ["worktree", "remove", physicalPath];
  const removed = runGit(assignment.realSourceRepositoryRoot, environment, argv);
  if (!removed.ok || existsSync(physicalPath)) {
    const message = "worktree removal did not complete; the tree is retained";
    return fail("RUNNER_WORKSPACE_WORKTREE_RELEASE_UNCERTAIN", message, physicalPath);
  }
  return released;
}

/**
 * The allocator. It creates or adopts exactly one detached tree for one exact
 * server-authorized attempt, and it never stages, commits, merges, pushes,
 * resets, or touches any checkout other than the one it derived.
 */
export function createNodeWorktreeMaterializer(
  baseEnvironment: NodeJS.ProcessEnv,
): WorktreeMaterializer {
  const environment = hermeticGitEnvironment(baseEnvironment);
  return Object.freeze({
    materialize: (request: WorktreeMaterializationRequest) => materialize(request, environment),
    release: (request: WorktreeReleaseRequest) => release(request, environment),
  });
}
