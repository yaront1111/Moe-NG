import { join, sep } from "node:path";

import { canonicalDigest, deepFreeze, isCanonicalUtcTimestamp, isCommitIdentity } from "../canonical.js";
import { buildAttributionIndex, parsePorcelainV2 } from "./scope-attribution.js";
import {
  canonicalPathRejection,
  isObserverVersion,
  isScopeFailure,
  MAX_SCOPE_PATHS,
  scopeFailure,
  SCOPE_OBSERVATION_VERSION,
  ScopeObserverError,
  type ObserveScopeInput,
  type ObserveScopeResult,
  type ScopeCanonicalEntry,
  type ScopeFailure,
  type ScopeGitAttribution,
  type ScopeObservation,
} from "./scope-contract.js";

type Observed<T> = { readonly ok: true; readonly value: T } | ScopeFailure;

/** Preserves an adapter's precise code (maxBuffer overflow, for one). */
function observe<T>(action: () => T): Observed<T> {
  try {
    return { ok: true as const, value: action() };
  } catch (error) {
    if (error instanceof ScopeObserverError) {
      return scopeFailure(error.code, error.message);
    }
    return scopeFailure(
      "RUNNER_SCOPE_OBSERVATION_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
}

const fold = (value: string): string =>
  process.platform === "win32" ? value.toLowerCase() : value;

function isInside(realRoot: string, resolved: string): boolean {
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  return fold(resolved).startsWith(fold(prefix));
}

function validateScalars(input: ObserveScopeInput): ScopeFailure | null {
  if (!isObserverVersion(input.observerVersion)) {
    return scopeFailure("RUNNER_SCOPE_OBSERVER_VERSION_INVALID", "observerVersion must be bounded NFC text");
  }
  if (!isCanonicalUtcTimestamp(input.observedAt)) {
    return scopeFailure(
      "RUNNER_SCOPE_OBSERVED_AT_INVALID",
      "observedAt must be canonical ISO-8601 UTC (YYYY-MM-DDTHH:MM:SS[.mmm]Z)",
    );
  }
  if (!isCommitIdentity(input.baseIdentity)) {
    return scopeFailure("RUNNER_SCOPE_BASE_IDENTITY_INVALID", "baseIdentity must be a 40- or 64-hex commit");
  }
  if (input.declaredScopePaths.length === 0) {
    return scopeFailure("RUNNER_SCOPE_DECLARATION_EMPTY", "at least one scope path must be declared");
  }
  if (input.declaredScopePaths.length > MAX_SCOPE_PATHS) {
    return scopeFailure("RUNNER_SCOPE_DECLARATION_LIMIT", `declared scope exceeds ${MAX_SCOPE_PATHS} paths`);
  }
  return null;
}

/** Validates, de-duplicates, and sorts the declaration before anything is resolved. */
function canonicalizePaths(declared: readonly string[]): readonly string[] | ScopeFailure {
  const exact = new Set<string>();
  const folded = new Set<string>();
  for (const path of declared) {
    if (typeof path !== "string") {
      return scopeFailure("RUNNER_SCOPE_PATH_LENGTH_INVALID", "declared scope path must be a string");
    }
    const rejection = canonicalPathRejection(path);
    if (rejection !== null) {
      return scopeFailure(rejection, `declared scope path ${JSON.stringify(path)} is not canonical`, path);
    }
    if (exact.has(path)) {
      return scopeFailure("RUNNER_SCOPE_PATH_DUPLICATE", `duplicate scope path ${JSON.stringify(path)}`, path);
    }
    const lowered = path.toLowerCase();
    if (folded.has(lowered)) {
      return scopeFailure(
        "RUNNER_SCOPE_PATH_CASE_COLLISION",
        `scope path ${JSON.stringify(path)} collides case-insensitively`,
        path,
      );
    }
    exact.add(path);
    folded.add(lowered);
  }
  return [...exact].sort();
}

function submoduleRejection(paths: readonly string[], submodules: readonly string[]): ScopeFailure | null {
  for (const path of paths) {
    for (const submodule of submodules) {
      if (path === submodule || path.startsWith(`${submodule}/`)) {
        return scopeFailure(
          "RUNNER_SCOPE_SUBMODULE_BOUNDARY",
          `scope path ${JSON.stringify(path)} crosses submodule ${JSON.stringify(submodule)}`,
          path,
        );
      }
    }
  }
  return null;
}

/**
 * Captures a hashed, digest-bound scope observation over an exact base and
 * worktree. Every canonicalization and attribution rule fails closed, and the
 * digest covers every field, so a consumer can bind to this exact observation.
 */
export function observeScope(input: ObserveScopeInput): ObserveScopeResult {
  const scalarFailure = validateScalars(input);
  if (scalarFailure !== null) {
    return scalarFailure;
  }
  const canonicalPaths = canonicalizePaths(input.declaredScopePaths);
  if (isScopeFailure(canonicalPaths)) {
    return canonicalPaths;
  }

  const head = observe(() => input.gitObserver.headCommit());
  if (!head.ok) return head;
  if (head.value !== input.baseIdentity) {
    return scopeFailure(
      "RUNNER_SCOPE_HEAD_MISMATCH",
      `observed HEAD ${head.value} does not match declared base ${input.baseIdentity}`,
    );
  }
  const submodules = observe(() => input.gitObserver.submodulePaths());
  if (!submodules.ok) return submodules;
  const submoduleFailure = submoduleRejection(canonicalPaths, submodules.value);
  if (submoduleFailure !== null) {
    return submoduleFailure;
  }
  const status = observe(() => input.gitObserver.statusPorcelainV2());
  if (!status.ok) return status;
  const manifests = parsePorcelainV2(status.value);
  if (isScopeFailure(manifests)) {
    return manifests;
  }
  const tracked = observe(() => input.gitObserver.lsFilesTracked());
  if (!tracked.ok) return tracked;
  const ignored = observe(() => input.gitObserver.lsFilesIgnored());
  if (!ignored.ok) return ignored;

  const realRoot = observe(() => input.pathObserver.realpath(input.worktreeRoot));
  if (!realRoot.ok) {
    return scopeFailure("RUNNER_SCOPE_REPOSITORY_ESCAPE", `worktree root is unresolvable: ${realRoot.message}`);
  }
  const containment = checkContainment(input, canonicalPaths, realRoot.value);
  if (containment !== null) {
    return containment;
  }

  const index = buildAttributionIndex(manifests, tracked.value, ignored.value);
  const canonicalEntries: ScopeCanonicalEntry[] = canonicalPaths.map((path) => {
    const { attribution, reason } = index.classify(path);
    return { path, attribution, attributionReason: reason };
  });
  const gitAttribution: ScopeGitAttribution = {
    headCommit: head.value,
    changedPaths: [
      ...new Set([
        ...manifests.dirty,
        ...manifests.staged,
        ...manifests.untracked,
        ...manifests.unmerged,
        ...manifests.contradictory,
      ]),
    ].sort(),
    dirtyPaths: manifests.dirty,
    stagedPaths: manifests.staged,
    untrackedPaths: manifests.untracked,
    unmergedPaths: manifests.unmerged,
    ignoredPaths: [...new Set([...ignored.value, ...manifests.ignored])].sort(),
  };
  const unsealed = {
    observationVersion: SCOPE_OBSERVATION_VERSION,
    baseIdentity: input.baseIdentity,
    worktreeIdentity: realRoot.value,
    canonicalEntries,
    gitAttribution,
    observedAt: input.observedAt,
    observerVersion: input.observerVersion,
  };
  const observation: ScopeObservation = deepFreeze({
    ...unsealed,
    sha256: canonicalDigest(unsealed),
  });
  return Object.freeze({ ok: true as const, observation });
}

/** Symlinks and junctions are resolved per entry; a path that does not exist yet is not resolved. */
function checkContainment(
  input: ObserveScopeInput,
  canonicalPaths: readonly string[],
  realRoot: string,
): ScopeFailure | null {
  for (const path of canonicalPaths) {
    const present = observe(() => input.pathObserver.exists(join(input.worktreeRoot, path)));
    if (!present.ok) return present;
    if (!present.value) {
      continue;
    }
    const resolved = observe(() => input.pathObserver.realpath(join(input.worktreeRoot, path)));
    if (!resolved.ok) return resolved;
    if (!isInside(realRoot, resolved.value)) {
      return scopeFailure(
        "RUNNER_SCOPE_SYMLINK_ESCAPE",
        `scope path ${JSON.stringify(path)} resolves outside the worktree`,
        path,
      );
    }
  }
  return null;
}
