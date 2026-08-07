import {
  scopeFailure,
  type ScopeAttributionClass,
  type ScopeFailure,
} from "./scope-contract.js";

export interface GitStatusManifests {
  readonly dirty: readonly string[];
  readonly staged: readonly string[];
  readonly untracked: readonly string[];
  readonly unmerged: readonly string[];
  /** Changed-entry records whose XY claims no change: git contradicted itself. */
  readonly contradictory: readonly string[];
  readonly ignored: readonly string[];
}

type Buckets = { [K in keyof GitStatusManifests]: string[] };

const ORDINARY_FIELDS = 7;
const RENAME_FIELDS = 8;
const UNMERGED_FIELDS = 9;

function fieldsAfter(record: string, count: number): { xy: string; path: string } | null {
  const parts = record.slice(2).split(" ");
  const xy = parts[0];
  if (xy === undefined || xy.length !== 2 || parts.length <= count) {
    return null;
  }
  return { xy, path: parts.slice(count).join(" ") };
}

function classifyXy(xy: string, paths: readonly string[], buckets: Buckets): void {
  const staged = xy[0] !== ".";
  const dirty = xy[1] !== ".";
  for (const path of paths) {
    if (staged) buckets.staged.push(path);
    if (dirty) buckets.dirty.push(path);
    if (!staged && !dirty) buckets.contradictory.push(path);
  }
}

/**
 * Parses NUL-framed `status --porcelain=v2 -z` output.
 *
 * Framing is enforced rather than tolerated: a stream that does not end on a
 * record boundary, or that carries a record type this parser does not know, is
 * refused outright. Half-understood status output must never become an
 * attribution.
 */
export function parsePorcelainV2(bytes: Uint8Array): GitStatusManifests | ScopeFailure {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return scopeFailure("RUNNER_SCOPE_STATUS_MALFORMED", "status output is not valid UTF-8");
  }
  if (text.length === 0) {
    return freezeManifests(emptyBuckets());
  }
  if (!text.endsWith("\0")) {
    return scopeFailure("RUNNER_SCOPE_STATUS_MALFORMED", "status output is not NUL-terminated");
  }
  const tokens = text.slice(0, -1).split("\0");
  const buckets = emptyBuckets();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.length === 0) {
      return scopeFailure("RUNNER_SCOPE_STATUS_MALFORMED", "status output contains an empty record");
    }
    if (token.startsWith("# ")) {
      continue;
    }
    if (token.startsWith("? ")) {
      buckets.untracked.push(token.slice(2));
      continue;
    }
    if (token.startsWith("! ")) {
      buckets.ignored.push(token.slice(2));
      continue;
    }
    if (token.startsWith("1 ")) {
      const parsed = fieldsAfter(token, ORDINARY_FIELDS);
      if (parsed === null) {
        return scopeFailure("RUNNER_SCOPE_STATUS_MALFORMED", `malformed ordinary record: ${token}`);
      }
      classifyXy(parsed.xy, [parsed.path], buckets);
      continue;
    }
    if (token.startsWith("2 ")) {
      const parsed = fieldsAfter(token, RENAME_FIELDS);
      const origin = tokens[index + 1];
      if (parsed === null || origin === undefined || origin.length === 0) {
        return scopeFailure("RUNNER_SCOPE_STATUS_MALFORMED", `malformed rename record: ${token}`);
      }
      index += 1;
      classifyXy(parsed.xy, [parsed.path, origin], buckets);
      continue;
    }
    if (token.startsWith("u ")) {
      const parsed = fieldsAfter(token, UNMERGED_FIELDS);
      if (parsed === null) {
        return scopeFailure("RUNNER_SCOPE_STATUS_MALFORMED", `malformed unmerged record: ${token}`);
      }
      buckets.unmerged.push(parsed.path);
      continue;
    }
    return scopeFailure("RUNNER_SCOPE_STATUS_MALFORMED", `unknown record type: ${token}`);
  }
  return freezeManifests(buckets);
}

function emptyBuckets(): Buckets {
  return { dirty: [], staged: [], untracked: [], unmerged: [], contradictory: [], ignored: [] };
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function freezeManifests(buckets: Buckets): GitStatusManifests {
  return Object.freeze({
    dirty: sortedUnique(buckets.dirty),
    staged: sortedUnique(buckets.staged),
    untracked: sortedUnique(buckets.untracked),
    unmerged: sortedUnique(buckets.unmerged),
    contradictory: sortedUnique(buckets.contradictory),
    ignored: sortedUnique(buckets.ignored),
  });
}

const RANK: Readonly<Record<ScopeAttributionClass, number>> = Object.freeze({
  UNKNOWN: 0,
  UNMERGED: 1,
  UNTRACKED: 2,
  STAGED: 3,
  DIRTY: 4,
  IGNORED: 5,
  CLEAN: 6,
  ABSENT: 7,
});

const REASON: Readonly<Record<ScopeAttributionClass, string>> = Object.freeze({
  UNKNOWN: "git reported the path but its status record contradicts itself",
  UNMERGED: "git reports an unmerged index entry",
  UNTRACKED: "git reports the path as untracked",
  STAGED: "git reports an index change against HEAD",
  DIRTY: "git reports a worktree change against the index",
  IGNORED: "git reports the path as ignored",
  CLEAN: "git tracks the path and reports no change",
  ABSENT: "no git query reported the path",
});

/** Index of the first entry that is not less than `target`. */
function lowerBound(sorted: readonly string[], target: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle]! < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export interface ScopeAttributionIndex {
  classify(path: string): { readonly attribution: ScopeAttributionClass; readonly reason: string };
}

/**
 * Resolves a declared path against everything git reported.
 *
 * A declaration may name a directory, so an exact miss falls back to the
 * strongest class anywhere in its subtree: one dirty file must not let a whole
 * declared directory read as clean.
 */
export function buildAttributionIndex(
  manifests: GitStatusManifests,
  tracked: readonly string[],
  ignored: readonly string[],
): ScopeAttributionIndex {
  const known = new Map<string, ScopeAttributionClass>();
  const assign = (path: string, attribution: ScopeAttributionClass): void => {
    const current = known.get(path);
    if (current === undefined || RANK[attribution] < RANK[current]) {
      known.set(path, attribution);
    }
  };
  const ignoredDirectories: string[] = [];
  for (const entry of [...ignored, ...manifests.ignored]) {
    if (entry.endsWith("/")) {
      ignoredDirectories.push(entry.slice(0, -1));
    } else {
      assign(entry, "IGNORED");
    }
  }
  for (const path of tracked) assign(path, "CLEAN");
  for (const path of manifests.dirty) assign(path, "DIRTY");
  for (const path of manifests.staged) assign(path, "STAGED");
  for (const path of manifests.untracked) assign(path, "UNTRACKED");
  for (const path of manifests.unmerged) assign(path, "UNMERGED");
  for (const path of manifests.contradictory) assign(path, "UNKNOWN");

  const sortedKnown = [...known.keys()].sort();

  const strongestInSubtree = (path: string): ScopeAttributionClass | null => {
    const prefix = `${path}/`;
    let strongest: ScopeAttributionClass | null = null;
    for (let index = lowerBound(sortedKnown, prefix); index < sortedKnown.length; index += 1) {
      const candidate = sortedKnown[index]!;
      if (!candidate.startsWith(prefix)) {
        break;
      }
      const attribution = known.get(candidate)!;
      if (strongest === null || RANK[attribution] < RANK[strongest]) {
        strongest = attribution;
      }
    }
    return strongest;
  };

  return {
    classify(path: string) {
      const exact = known.get(path) ?? strongestInSubtree(path);
      if (exact !== null && exact !== undefined) {
        return { attribution: exact, reason: REASON[exact] };
      }
      const underIgnoredDirectory = ignoredDirectories.some(
        (directory) => path === directory || path.startsWith(`${directory}/`),
      );
      const attribution: ScopeAttributionClass = underIgnoredDirectory ? "IGNORED" : "ABSENT";
      return { attribution, reason: REASON[attribution] };
    },
  };
}
