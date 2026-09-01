import { ScopeObserverError } from "./scope-contract.js";

/**
 * How the observer reads a spawn failure, split out of scope-git.ts so it is a
 * real production surface a test can drive: listRefs' classification, and the
 * exit status that tells a headCommit refusal from an unborn HEAD.
 *
 * The extraction is the same move this module's neighbour scope-refs.ts already
 * made for the ref grammar, and for the same reason: the process boundary is
 * not injectable. createNodeGitObserver closes over a private runGit that calls
 * execFileSync directly, so no test can hand listRefs a throwing spawn without
 * changing a signature every existing caller depends on. The classification is
 * the part that has branches, so the classification is the part that moves.
 *
 * runGit has since learned to recognise ENOBUFS itself, so the overflow
 * promotion in classifyRefFailure is now a redundant second witness; the
 * classifier is kept because it still does what runGit does not — attribute
 * the refusal to the GIT_OBSERVER layer.
 */

/**
 * Whether a headCommit refusal is git answering "HEAD resolves to nothing".
 *
 * `rev-parse --verify --quiet HEAD` is the observer's only exit-1 producer: an
 * unborn HEAD exits 1 with no output, a fatal exits 128, and a timeout kill or
 * an EAGAIN/ENOMEM spawn fault leaves no status at all. runGit codes all four
 * RUNNER_SCOPE_OBSERVATION_FAILED, so the preserved cause is the only witness
 * that distinguishes an observed absence from an observation that never
 * happened. The code is checked as well as the status because a status a
 * different layer attached says nothing about whether HEAD was read.
 */
export function isUnresolvedHeadFailure(error: unknown): boolean {
  if (!(error instanceof ScopeObserverError) || error.code !== "RUNNER_SCOPE_OBSERVATION_FAILED") {
    return false;
  }
  return (error as { cause?: { status?: unknown } }).cause?.status === 1;
}

/** Attaches the refusing layer, and treats ENOBUFS as the overflow it is. */
export function classifyRefFailure(error: unknown): ScopeObserverError {
  if (error instanceof ScopeObserverError) {
    const overflowed =
      error.code === "RUNNER_SCOPE_OBSERVATION_OVERFLOW" ||
      (error as { cause?: { code?: unknown } }).cause?.code === "ENOBUFS";
    return new ScopeObserverError(
      overflowed ? "RUNNER_SCOPE_OBSERVATION_OVERFLOW" : error.code,
      error.message,
      "GIT_OBSERVER",
    );
  }
  return new ScopeObserverError(
    "RUNNER_SCOPE_OBSERVATION_FAILED",
    "git for-each-ref failed",
    "GIT_OBSERVER",
  );
}
