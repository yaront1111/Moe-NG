import { ScopeObserverError } from "./scope-contract.js";

/**
 * How listRefs classifies a spawn failure, split out of scope-git.ts so it is a
 * real production surface a test can drive.
 *
 * The extraction is the same move this module's neighbour scope-refs.ts already
 * made for the ref grammar, and for the same reason: the process boundary is
 * not injectable. createNodeGitObserver closes over a private runGit that calls
 * execFileSync directly, so no test can hand listRefs a throwing spawn without
 * changing a signature every existing caller depends on. The classification is
 * the part that has branches, so the classification is the part that moves.
 *
 * Classification stays scoped to THIS operation rather than widening runGit,
 * which would change how the other five observer methods classify.
 */

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
